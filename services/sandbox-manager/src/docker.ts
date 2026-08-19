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
}

export class DockerSandbox {
  private readonly docker: Docker;
  private readonly pulled = new Set<string>();
  /** Live terminal sessions — ring source for late WS subscribers (22 §5.2). */
  private readonly terminals = new Map<string, TerminalSession>();
  /** Long-lived bidirectional PTY shells (REVISION TASK 2). */
  private readonly shells = new Map<
    string,
    { exec: import("dockerode").Exec; stream: NodeJS.ReadWriteStream }
  >();
  private static readonly MAX_TRACKED_TERMINALS = 200;

  constructor(private readonly deps: DockerSandboxDeps) {
    this.docker = deps.docker;
  }

  /** create → start; idempotent on workspaceId (a live container is reused). */
  async createWorkspace(req: CreateWorkspaceRequest): Promise<Workspace> {
    const existing = await this.findContainer(req.workspaceId);
    if (existing) {
      const info = await existing.inspect();
      if (info.State.Running) return this.toWorkspace(info);
      // INVARIANT 15 (retry idempotency): durmuş aynı-adlı konteyner yeniden
      // başlatılır; başlatılamıyorsa kaldırılıp temiz yaratılır — 409 yok.
      try {
        await existing.start();
        return this.toWorkspace(await existing.inspect());
      } catch {
        await existing.remove({ force: true }).catch(() => {});
      }
    }

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

    let container: Docker.Container;
    try {
      // WorkingDir only when a mount provides it — on a read-only rootfs
      // Docker cannot create a missing WorkingDir, so default to "/". The
      // worktree volume mounts rw at /work (15 §3.1, T38).
      const workMount = req.mounts.find((m) => m.target === "/work");
      container = await this.docker.createContainer({
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
      await container.start();
    } catch (err) {
      // TOCTOU on the idempotency check: concurrent creates for the same
      // workspaceId race past findContainer — the 409 loser adopts the winner
      if ((err as { statusCode?: number }).statusCode === 409) {
        const winner = await this.findContainer(req.workspaceId);
        if (winner) {
          const info = await winner.inspect();
          if (!info.State.Running) await winner.start().catch(() => {});
          return this.toWorkspace(await winner.inspect());
        }
      }
      throw new SandboxError("DOCKER_ERROR", `create/start failed: ${String(err)}`);
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
