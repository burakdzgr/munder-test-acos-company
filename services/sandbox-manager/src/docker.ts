// DockerSandbox — the container lifecycle (S1: the ONLY Docker-socket owner).
// dockerode create/exec/destroy per isolation level with the hardened
// HostConfig from @acos/tools (S8). Buffered exec for tool calls; PTY exec
// streams frames into a TerminalSession (NATS + ring + log). Every container
// carries acos labels so the GC and `list` can find orphans deterministically.
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import {
  hardenedHostConfig,
  isIsolationLevel,
  workspaceEnv,
  type IsolationLevel,
} from "@acos/tools";
import type {
  CreateWorkspaceRequest,
  ExecRequest,
  ExecResult,
  Workspace,
} from "@acos/contracts";
import { TerminalSession, type TerminalLogSink, type TerminalTransport } from "./terminal.js";

const LABEL_MANAGED = "acos.sandbox";
const LABEL_WORKSPACE = "acos.workspace_id";
const LABEL_ISOLATION = "acos.isolation";
const LABEL_CREATED = "acos.created_at";

/** Keeps the container alive so tools can exec into it; runs from the image's
 *  read-only rootfs (the tmpfs /tmp is noexec, S8). */
const KEEPALIVE = ["/bin/sh", "-c", "while true; do sleep 3600; done"];
const DEFAULT_IMAGE = "alpine:3.20"; // real workspace images land with T38
/** T47: how long a 409 loser keeps polling for the name's owner before giving up. */
export const CREATE_ADOPT_WINDOW_MS = 8_000;
/** T47: poll interval while waiting for the conflicting container to become usable/free. */
export const CREATE_ADOPT_POLL_MS = 200;
/** The in-container session entry (baked read-only into acos/workspace-node, E4/T31). */
export const AGENT_SESSION_ENTRY = "/opt/acos/cli/run-session.sh";

export interface AgentSessionOpen {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
  /** Runtime-injected env: brokered identity + gateway token + brief. */
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  /** Test seam only — production always runs the baked entry script. */
  readonly entrypoint?: readonly string[];
}

export interface AgentSessionStatus {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly running: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly exitCode: number | null;
}

interface AgentSessionState {
  workspaceId: string;
  exec: import("dockerode").Exec;
  stream: NodeJS.ReadWriteStream;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  ending: boolean;
}

export class SandboxError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "IMAGE_PULL_FAILED" | "DOCKER_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export interface DockerSandboxDeps {
  docker: Docker;
  transport: TerminalTransport;
  logSink: TerminalLogSink;
  nowMs: () => number;
  /** Fixed clock injection stays deterministic in tests. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Injectable wait (tests run the adopt poll on a fake clock). Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export class DockerSandbox {
  private readonly docker: Docker;
  private readonly pulled = new Set<string>();
  /** T47: in-flight creates per workspaceId — concurrent callers share one. */
  private readonly creating = new Map<string, Promise<Workspace>>();
  /** Live terminal sessions — ring source for late WS subscribers (22 §5.2). */
  private readonly terminals = new Map<string, TerminalSession>();
  /** Long-lived bidirectional PTY shells (REVISION TASK 2). */
  private readonly shells = new Map<
    string,
    { exec: import("dockerode").Exec; stream: NodeJS.ReadWriteStream }
  >();
  /** Live agent CLI sessions (E4/T31): the `claude` process IS the PTY process. */
  private readonly agentSessions = new Map<string, AgentSessionState>();
  private static readonly MAX_TRACKED_TERMINALS = 200;

  constructor(private readonly deps: DockerSandboxDeps) {
    this.docker = deps.docker;
  }

  /**
   * create → start; IDEMPOTENT on workspaceId (T47). The container name is the
   * deterministic `acos-ws-<workspaceId>` (R1/T50 idempotent replay), so the
   * same workspace is routinely created more than once: a Temporal activity
   * retry, the intake analyzer fan-out (N activities, one workspace), a second
   * process. Contract: every concurrent or repeated create for one workspaceId
   * resolves to the SAME live container — never a 409 surfaced as a 500.
   *
   * Two layers:
   *  1. in-process coalescing — concurrent callers share one in-flight create;
   *  2. adopt-on-conflict — a 409 from Docker means someone else owns the
   *     name; the loser polls (bounded) until the winner is visible and
   *     running and adopts it. Docker reserves the NAME before the container
   *     becomes listable/inspectable (live finding 2026-08-21: the immediate
   *     lookup after a 409 found nothing, 250 ms later it was there), so a
   *     single lookup is not enough — hence the poll. A name held by a
   *     container that is being removed frees up; the poll then re-creates.
   */
  async createWorkspace(req: CreateWorkspaceRequest): Promise<Workspace> {
    const inflight = this.creating.get(req.workspaceId);
    if (inflight) return inflight;
    const p = this.createWorkspaceUncoalesced(req).finally(() => {
      this.creating.delete(req.workspaceId);
    });
    this.creating.set(req.workspaceId, p);
    return p;
  }

  private async createWorkspaceUncoalesced(req: CreateWorkspaceRequest): Promise<Workspace> {
    const deadline = this.deps.nowMs() + CREATE_ADOPT_WINDOW_MS;
    let lastErr: unknown = null;
    for (;;) {
      const existing = await this.adoptExisting(req.workspaceId);
      if (existing) return existing;

      try {
        return await this.createFresh(req);
      } catch (err) {
        lastErr = err;
        // TOCTOU on the idempotency check: a concurrent create (another
        // process, a retry racing the original) owns the name → adopt it.
        // Anything else is a real Docker error.
        if ((err as { statusCode?: number }).statusCode !== 409) {
          throw new SandboxError("DOCKER_ERROR", `create/start failed: ${String(err)}`);
        }
      }
      if (this.deps.nowMs() >= deadline) break;
      await this.sleep(CREATE_ADOPT_POLL_MS);
    }
    throw new SandboxError(
      "DOCKER_ERROR",
      `create/start failed: the name acos-ws-${req.workspaceId} stayed in conflict for ${CREATE_ADOPT_WINDOW_MS} ms without a usable container to adopt: ${String(lastErr)}`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /**
   * The container holding this workspace's name, if any, made usable: running
   * → reuse; created/exited/paused → start; being removed / dead → null after
   * best-effort removal (the caller re-creates once the name is free). Looks
   * up by label first (the normal path) and by NAME second — a container that
   * is reserved-but-not-yet-registered, or foreign-labeled, is only visible
   * by name.
   */
  private async adoptExisting(workspaceId: string): Promise<Workspace | null> {
    const container = (await this.findContainer(workspaceId)) ?? this.docker.getContainer(`acos-ws-${workspaceId}`);
    let info: Docker.ContainerInspectInfo;
    try {
      info = await container.inspect();
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw new SandboxError("DOCKER_ERROR", `inspect failed: ${String(err)}`);
    }
    if (info.State.Running) return this.toWorkspace(info);
    const status = info.State.Status;
    if (status === "removing" || status === "dead" || info.State.Dead) {
      // the name frees itself when removal completes; nudge a dead one along
      await container.remove({ force: true }).catch(() => {});
      return null;
    }
    // INVARIANT 15 (retry idempotency): a stopped same-name container is
    // restarted; if it cannot start it is removed and created clean — no 409.
    try {
      await container.start();
      const after = await container.inspect();
      if (after.State.Running) return this.toWorkspace(after);
    } catch {
      /* fall through to removal */
    }
    await container.remove({ force: true }).catch(() => {});
    return null;
  }

  /** One create → start attempt. Throws the raw Docker error (409 = name owned by someone else). */
  private async createFresh(req: CreateWorkspaceRequest): Promise<Workspace> {
    const level: IsolationLevel = req.isolation;
    const image = req.image ?? DEFAULT_IMAGE;
    await this.ensureImage(image);

    const env = { ...workspaceEnv(level), ...req.env };
    const hostConfig = hardenedHostConfig(
      level,
      req.mounts.map((m) => ({
        source: m.source,
        target: m.target,
        readonly: m.readonly,
        type: m.type,
      })),
    );

    // WorkingDir only when a mount provides it — on a read-only rootfs
    // Docker cannot create a missing WorkingDir, so default to "/". The
    // worktree volume mounts rw at /work (15 §3.1, T38).
    const workMount = req.mounts.find((m) => m.target === "/work");
    const container = await this.docker.createContainer({
      name: `acos-ws-${req.workspaceId}`,
      Image: image,
      Cmd: KEEPALIVE,
      Tty: false,
      // O10: agent code runs UNPRIVILEGED inside the workspace. The rest of
      // the stack already assumed this — provisionWorktree hands the
      // worktree over with `chown -R 1000:1000 /work` and calls the image
      // "unprivileged (uid 1000, S8)" — but the container spec never said
      // so, so every workspace ran as root on top of a volume owned by
      // 1000. CapDrop ALL + no-new-privileges + a read-only rootfs limited
      // the blast radius; this closes the gap they were compensating for.
      User: "1000:1000",
      ...(workMount && { WorkingDir: "/work" }),
      Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
      Labels: {
        [LABEL_MANAGED]: "true",
        [LABEL_WORKSPACE]: req.workspaceId,
        [LABEL_ISOLATION]: level,
        [LABEL_CREATED]: String(this.deps.nowMs()),
        ...req.labels,
      },
      HostConfig: hostConfig as unknown as Docker.ContainerCreateOptions["HostConfig"],
    });
    try {
      await container.start();
    } catch (err) {
      // a create that cannot start must not leave a dead name behind for the
      // next attempt to trip over
      await container.remove({ force: true }).catch(() => {});
      throw err;
    }
    const info = await container.inspect();
    this.deps.log?.("workspace created", { workspaceId: req.workspaceId, isolation: level });
    return this.toWorkspace(info);
  }

  /**
   * Buffered exec (tool calls) or PTY-streamed exec (terminals). Timeout is
   * enforced inside the container with busybox `timeout -s KILL` so a runaway
   * command dies at the wall clock, not just client-side.
   */
  async exec(
    workspaceId: string,
    req: ExecRequest,
    session?: TerminalSession,
  ): Promise<ExecResult> {
    const container = await this.requireContainer(workspaceId);
    const timeoutSec = Math.max(1, Math.ceil(req.timeoutMs / 1000));
    const cmd = ["timeout", "-s", "KILL", String(timeoutSec), ...req.command];
    const tty = session !== undefined;

    // Y3: a payload on stdin instead of inside argv. Linux caps one argv entry
    // at MAX_ARG_STRLEN (128 KB) and base64 inflates by a third, so writing a
    // file larger than ~96 KB used to die with a bare `E2BIG`. stdin is a
    // stream — no cap — and a PTY exec cannot use it (the TTY owns the fd), so
    // stdin is only attached on the buffered path.
    const withStdin = req.stdinBase64 !== undefined && !tty;

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      ...(withStdin && { AttachStdin: true }),
      Tty: tty,
      ...(req.cwd && { WorkingDir: req.cwd }),
      Env: Object.entries(req.env).map(([k, v]) => `${k}=${v}`),
    });

    const started = this.deps.nowMs();
    const stream = await exec.start({
      Tty: tty,
      hijack: true,
      ...(withStdin && { stdin: true }),
    });

    if (withStdin) {
      // decode here so the container receives raw bytes and the command needs
      // no `base64 -d`; ending the stream is what sends EOF to the reader
      stream.write(Buffer.from(req.stdinBase64!, "base64"));
      stream.end();
    }

    let stdout = "";
    let stderr = "";
    if (tty) {
      // PTY: one merged stream → frames on `term.<sessionId>` AND the
      // buffered result (waitForResult callers need both, T41)
      stream.on("data", (chunk: Buffer) => {
        session!.emit("stdout", chunk);
        stdout += chunk.toString("utf8");
      });
    } else {
      const outS = new PassThrough();
      const errS = new PassThrough();
      outS.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      errS.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      this.docker.modem.demuxStream(stream, outS, errS);
    }

    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    // Half-closing stdin ends the hijacked socket on OUR side, so `end` can
    // fire while the process is still running and `ExitCode` is still null
    // (it surfaced as a bare `exit -1`). Wait for Docker to agree the exec is
    // finished before reading the code. Costs one inspect on the normal path.
    let inspect = await exec.inspect();
    const inspectDeadline = this.deps.nowMs() + req.timeoutMs + 5_000;
    while (inspect.Running && this.deps.nowMs() < inspectDeadline) {
      await new Promise((r) => setTimeout(r, 25));
      inspect = await exec.inspect();
    }
    const exitCode = inspect.ExitCode ?? -1;
    // busybox `timeout -s KILL` → 137 (128+SIGKILL); coreutils → 124
    const timedOut = exitCode === 137 || exitCode === 124;
    return {
      exitCode,
      stdout,
      stderr,
      durationMs: this.deps.nowMs() - started,
      timedOut,
    };
  }

  async destroyWorkspace(workspaceId: string): Promise<void> {
    const container = await this.findContainer(workspaceId);
    if (!container) return; // idempotent
    try {
      await container.remove({ force: true });
    } catch (err) {
      throw new SandboxError("DOCKER_ERROR", `destroy failed: ${String(err)}`);
    }
    this.deps.log?.("workspace destroyed", { workspaceId });
  }

  async list(): Promise<Workspace[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_MANAGED}=true`] },
    });
    return containers
      .filter((c) => c.Labels[LABEL_WORKSPACE] && isIsolationLevel(c.Labels[LABEL_ISOLATION] ?? ""))
      .map((c) => ({
        workspaceId: c.Labels[LABEL_WORKSPACE]!,
        containerId: c.Id,
        isolation: c.Labels[LABEL_ISOLATION] as IsolationLevel,
        status: c.State === "running" ? ("running" as const) : ("exited" as const),
        createdAt: new Date(c.Created * 1000).toISOString(),
      }));
  }

  /**
   * GC (27 §11): remove exited containers and any live workspace older than
   * `maxAgeMs` (orphans whose owning task/workflow is long gone). Returns the
   * ids reaped. Runs on an interval from main.ts.
   */
  async gc(maxAgeMs: number): Promise<string[]> {
    const now = this.deps.nowMs();
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_MANAGED}=true`] },
    });
    const reaped: string[] = [];
    for (const c of containers) {
      const workspaceId = c.Labels[LABEL_WORKSPACE];
      if (!workspaceId) continue;
      const createdMs = Number(c.Labels[LABEL_CREATED] ?? c.Created * 1000);
      const exited = c.State !== "running";
      if (exited || now - createdMs > maxAgeMs) {
        try {
          await this.docker.getContainer(c.Id).remove({ force: true });
          reaped.push(workspaceId);
        } catch {
          /* another GC pass or destroy raced us — fine */
        }
      }
    }
    if (reaped.length > 0) this.deps.log?.("gc reaped workspaces", { count: reaped.length });
    return reaped;
  }

  newTerminalSession(sessionId: string): TerminalSession {
    const existing = this.terminals.get(sessionId);
    if (existing) return existing; // resumed exec keeps the seq monotonic
    const session = new TerminalSession(
      sessionId,
      this.deps.transport,
      this.deps.logSink,
      this.deps.nowMs,
    );
    this.terminals.set(sessionId, session);
    // bounded registry — evict oldest finished sessions (their scrollback
    // stays in the rolling log)
    if (this.terminals.size > DockerSandbox.MAX_TRACKED_TERMINALS) {
      const oldest = this.terminals.keys().next().value;
      if (oldest !== undefined) this.terminals.delete(oldest);
    }
    return session;
  }

  terminalSession(sessionId: string): TerminalSession | undefined {
    return this.terminals.get(sessionId);
  }

  // ---------- preview gateway (REVISION TASK 3) ----------

  /**
   * Listening TCP ports inside the workspace, read from /proc/net/tcp{,6}
   * (state 0A = LISTEN) so no netstat/ss binary is required in the image.
   */
  async discoverPorts(workspaceId: string): Promise<number[]> {
    const result = await this.exec(workspaceId, {
      command: ["sh", "-c", "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null"],
      env: {},
      timeoutMs: 5_000,
    } as ExecRequest);
    const ports = new Set<number>();
    for (const line of result.stdout.split("\n")) {
      const cols = line.trim().split(/\s+/);
      // sl local_address rem_address st ... — st 0A = LISTEN
      if (cols.length < 4 || cols[3] !== "0A") continue;
      const hexPort = cols[1]?.split(":").pop();
      if (!hexPort) continue;
      const port = Number.parseInt(hexPort, 16);
      if (port > 0) ports.add(port);
    }
    return [...ports].sort((a, b) => a - b);
  }

  /** Workspace container IP on the internal network — preview proxy target. */
  async containerIp(workspaceId: string): Promise<string> {
    const container = await this.requireContainer(workspaceId);
    const info = await container.inspect();
    for (const net of Object.values(info.NetworkSettings?.Networks ?? {})) {
      if (net.IPAddress) return net.IPAddress;
    }
    throw new SandboxError("DOCKER_ERROR", "workspace has no network address");
  }

  // ---------- interactive shell (REVISION TASK 2) ----------

  /**
   * Long-lived bidirectional PTY: `/bin/sh` in the workspace container,
   * stdin attached, output riding the SAME TerminalSession plumbing as
   * one-shot execs (NATS `term.<sessionId>` + ring + rolling log), so the
   * existing WS gateway and replay endpoints work unchanged.
   */
  async openShell(
    workspaceId: string,
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<{ opened: boolean }> {
    if (this.shells.has(sessionId)) return { opened: false }; // idempotent
    const container = await this.requireContainer(workspaceId);
    const session = this.newTerminalSession(sessionId);
    const exec = await container.exec({
      Cmd: ["/bin/sh"],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: "/work",
      Env: ["TERM=xterm-256color", "HOME=/home/node"],
    });
    const stream = await exec.start({ Tty: true, hijack: true, stdin: true });
    await exec.resize({ w: cols, h: rows }).catch(() => {});
    this.shells.set(sessionId, { exec, stream: stream as unknown as NodeJS.ReadWriteStream });
    stream.on("data", (chunk: Buffer) => session.emit("stdout", chunk));
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      this.shells.delete(sessionId);
      session.emit("stdout", "\r\n[shell kapandı]\r\n");
    };
    stream.on("end", cleanup);
    stream.on("error", cleanup);
    this.deps.log?.("interactive shell opened", { workspaceId, sessionId });
    return { opened: true };
  }

  hasShell(sessionId: string): boolean {
    return this.shells.has(sessionId);
  }

  /** Founder keystrokes → PTY stdin. Returns false when no live shell. */
  writeShell(sessionId: string, dataBase64: string): boolean {
    const shell = this.shells.get(sessionId);
    if (!shell) return false;
    shell.stream.write(Buffer.from(dataBase64, "base64"));
    return true;
  }

  async resizeShell(sessionId: string, cols: number, rows: number): Promise<boolean> {
    const shell = this.shells.get(sessionId);
    if (!shell) return false;
    await shell.exec.resize({ w: cols, h: rows }).catch(() => {});
    return true;
  }

  closeShell(sessionId: string): boolean {
    const shell = this.shells.get(sessionId);
    if (!shell) return false;
    try {
      (shell.stream as unknown as { end: () => void }).end();
    } catch {
      // stream already torn down — cleanup handler owns the registry
    }
    this.shells.delete(sessionId);
    return true;
  }

  // ---------- agent CLI session (E4/T31, ADR-022) ----------

  /**
   * Start the agent's Claude Code CLI session as THE process of this PTY.
   * Same frame plumbing as `openShell` (ring + NATS `term.<sessionId>` + log),
   * so the Founder watches the genuine session; the shell registry is shared
   * so takeover keystrokes / resize / close work unchanged. The entrypoint is
   * the read-only kit baked into the workspace image; `env` carries ONLY the
   * brokered identity (ANTHROPIC_BASE_URL + acos-sess token), the gateway
   * session token and the brief — never a raw credential (the entry script
   * refuses to start if it sees one).
   */
  async openAgentSession(input: AgentSessionOpen): Promise<{ opened: boolean }> {
    const live = this.agentSessions.get(input.sessionId);
    if (live && live.endedAt === null) return { opened: false }; // idempotent while running
    const container = await this.requireContainer(input.workspaceId);
    const session = this.newTerminalSession(input.sessionId);
    const env = [
      "TERM=xterm-256color",
      "HOME=/home/node",
      ...Object.entries(input.env).map(([k, v]) => `${k}=${v}`),
    ];
    const exec = await container.exec({
      Cmd: [...(input.entrypoint ?? [AGENT_SESSION_ENTRY])],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      WorkingDir: input.cwd ?? "/work",
      Env: env,
    });
    const stream = await exec.start({ Tty: true, hijack: true, stdin: true });
    const state: AgentSessionState = {
      workspaceId: input.workspaceId,
      exec,
      stream: stream as unknown as NodeJS.ReadWriteStream,
      startedAt: this.deps.nowMs(),
      endedAt: null,
      exitCode: null,
      ending: false,
    };
    this.agentSessions.set(input.sessionId, state);
    this.shells.set(input.sessionId, { exec, stream: state.stream });
    stream.on("data", (chunk: Buffer) => session.emit("stdout", chunk));
    let closed = false;
    const finish = async () => {
      if (closed) return;
      closed = true;
      this.shells.delete(input.sessionId);
      // the hijacked socket can end before Docker has the exit code — wait briefly
      let code: number | null = null;
      const deadline = this.deps.nowMs() + 5_000;
      for (;;) {
        try {
          const info = await exec.inspect();
          if (!info.Running) {
            code = info.ExitCode ?? null;
            break;
          }
        } catch {
          break;
        }
        if (this.deps.nowMs() >= deadline) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      state.exitCode = code;
      state.endedAt = this.deps.nowMs();
      session.emit("stdout", `\r\n[acos: agent session ended${code === null ? "" : ` (exit ${code})`}]\r\n`);
      this.deps.log?.("agent session ended", { sessionId: input.sessionId, exitCode: code });
    };
    stream.on("end", () => void finish());
    stream.on("error", () => void finish());
    // resize AFTER the handlers are wired: a process that exits immediately
    // ends the hijacked stream during this await and the 'end' would be lost
    await exec.resize({ w: input.cols, h: input.rows }).catch(() => {});
    this.deps.log?.("agent session opened", { workspaceId: input.workspaceId, sessionId: input.sessionId });
    return { opened: true };
  }

  agentSessionStatus(sessionId: string): AgentSessionStatus | undefined {
    const s = this.agentSessions.get(sessionId);
    if (!s) return undefined;
    return {
      sessionId,
      workspaceId: s.workspaceId,
      running: s.endedAt === null,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      exitCode: s.exitCode,
    };
  }

  /**
   * End a live agent session deterministically. Escalation: Ctrl-C up to four
   * times, 1.5 s apart (interrupt a running turn, then exit at the prompt — the
   * CLI's own "press Ctrl-C again to exit") → SIGTERM to the recorded session pid
   * (written by run-session.sh into HOME) → close our side of the PTY. Each
   * step waits `graceMs` for the stream to end. Idempotent.
   */
  async endAgentSession(sessionId: string, graceMs = 8_000): Promise<AgentSessionStatus | undefined> {
    const s = this.agentSessions.get(sessionId);
    if (!s) return undefined;
    if (s.endedAt !== null || s.ending) return this.agentSessionStatus(sessionId);
    s.ending = true;
    const ended = () => s.endedAt !== null;
    const wait = async (ms: number) => {
      const deadline = this.deps.nowMs() + ms;
      while (!ended() && this.deps.nowMs() < deadline) await new Promise((r) => setTimeout(r, 100));
      return ended();
    };
    // Ctrl-C, repeated: the first interrupts a running turn, the next exits at
    // the prompt ("Press Ctrl-C again to exit"). Live finding 2026-08-21: two
    // presses 400 ms apart were swallowed while the TUI was mid-render and the
    // session fell through to SIGTERM (exit 143). Press up to four times, 1.5 s
    // apart, stopping as soon as the stream ends — still well inside graceMs.
    for (let press = 0; press < 4 && !ended(); press++) {
      try {
        s.stream.write("\x03");
      } catch {
        break; /* stream already gone */
      }
      await wait(1_500);
    }
    if (await wait(graceMs)) return this.agentSessionStatus(sessionId);
    try {
      const container = await this.requireContainer(s.workspaceId);
      const kill = await container.exec({
        Cmd: ["/bin/sh", "-c", 'p=$(cat /home/node/.acos/session.pid 2>/dev/null); [ -n "$p" ] && kill -TERM "$p"'],
        AttachStdout: false,
        AttachStderr: false,
        Env: ["HOME=/home/node"],
      });
      await kill.start({ Detach: true });
    } catch {
      /* container gone or no pid file — fall through */
    }
    if (await wait(graceMs)) return this.agentSessionStatus(sessionId);
    this.closeShell(sessionId);
    await wait(2_000);
    return this.agentSessionStatus(sessionId);
  }

  /** Ended sessions older than `maxAgeMs` are forgotten (status is transient; the DB owns history). */
  forgetEndedAgentSessions(maxAgeMs: number): number {
    let n = 0;
    for (const [id, s] of this.agentSessions) {
      if (s.endedAt !== null && this.deps.nowMs() - s.endedAt > maxAgeMs) {
        this.agentSessions.delete(id);
        n++;
      }
    }
    return n;
  }

  // ---------- helpers ----------

  private async ensureImage(image: string): Promise<void> {
    if (this.pulled.has(image)) return;
    try {
      await this.docker.getImage(image).inspect();
      this.pulled.add(image);
      return;
    } catch {
      /* not present — pull below */
    }
    try {
      const stream = await this.docker.pull(image);
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
      });
      this.pulled.add(image);
    } catch (err) {
      throw new SandboxError("IMAGE_PULL_FAILED", `pull ${image} failed: ${String(err)}`);
    }
  }

  private async findContainer(workspaceId: string): Promise<Docker.Container | null> {
    const matches = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_WORKSPACE}=${workspaceId}`] },
    });
    const first = matches[0];
    return first ? this.docker.getContainer(first.Id) : null;
  }

  private async requireContainer(workspaceId: string): Promise<Docker.Container> {
    const container = await this.findContainer(workspaceId);
    if (!container) throw new SandboxError("NOT_FOUND", `workspace ${workspaceId} not found`);
    return container;
  }

  private toWorkspace(info: Docker.ContainerInspectInfo): Workspace {
    return {
      workspaceId: info.Config.Labels[LABEL_WORKSPACE]!,
      containerId: info.Id,
      isolation: info.Config.Labels[LABEL_ISOLATION] as IsolationLevel,
      status: info.State.Running ? "running" : "exited",
      createdAt: info.Created,
    };
  }
}
