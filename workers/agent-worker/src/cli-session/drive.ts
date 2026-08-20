// The session driver: admission → broker mint → gateway mint → open the CLI as
// the PTY process → watch (CLI exit | task handoff | wall-clock | token
// budget) → end → revoke. Pure orchestration over ports; no DB, no Temporal.
// INV-19 lives here at the session boundary: wall-clock and token ceilings are
// enforced by the driver (and independently by the broker), and the session is
// ALWAYS closed and revoked in `finally` — a crashed worker is the only way to
// leak a CLI, and the sweep on boot covers that.
import type {
  AdmissionPort,
  BrokerPort,
  BrokerSessionSummary,
  CliOutcome,
  DriveResult,
  EndedBy,
  GatewaySessionPort,
  SandboxSessionPort,
  SessionLimits,
  TaskStatePort,
} from "./ports.js";

export interface DriveInput {
  readonly companyId: string;
  readonly agentId: string;
  readonly taskId: string;
  /** agent_sessions.id — doubles as the broker session id. */
  readonly agentSessionId: string;
  readonly terminalSessionId: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly brief: string;
  readonly model: string | undefined;
  readonly sessionMode: "interactive" | "print";
  readonly limits: SessionLimits;
  readonly cols: number;
  readonly rows: number;
  /** Extra env for the container process (never credentials). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export interface DriveOptions {
  readonly pollMs: number;
  readonly admissionWaitMs: number;
  readonly endGraceMs: number;
  readonly nowMs: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly heartbeat?: (detail: string) => void;
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface DrivePorts {
  readonly admission: AdmissionPort;
  readonly broker: BrokerPort;
  readonly gateway: GatewaySessionPort;
  readonly sandbox: SandboxSessionPort;
  readonly task: TaskStatePort;
}

/** Task statuses after which the agent's turn is over (the MCP tools moved it). */
const HANDOFF_STATUSES = new Set(["DONE", "REVIEW", "QA", "APPROVAL", "BLOCKED", "WAITING", "FAILED", "CANCELLED"]);

export function outcomeForStatus(status: string, endedBy: EndedBy): CliOutcome {
  switch (status) {
    case "DONE":
      return "completed";
    case "REVIEW":
    case "QA":
    case "APPROVAL":
      return "review_requested";
    case "BLOCKED":
    case "WAITING":
      return "help_requested";
    default:
      // the CLI went away (or was stopped) without moving the task anywhere
      return endedBy === "cli_exit" ? "abandoned" : "guard_stopped";
  }
}

export class CliSessionError extends Error {
  constructor(
    readonly code: "gateway_unavailable" | "sandbox_open_failed",
    message: string,
  ) {
    super(message);
    this.name = "CliSessionError";
  }
}

export async function driveSession(ports: DrivePorts, input: DriveInput, opts: DriveOptions): Promise<DriveResult> {
  const log = opts.log ?? (() => {});
  const beat = opts.heartbeat ?? (() => {});
  const start = opts.nowMs();

  // ---- 1. admission (company cap — Scheduler's call; we only wait politely)
  let release: (() => Promise<void>) | null = null;
  for (;;) {
    const a = await ports.admission.admit({ companyId: input.companyId, agentId: input.agentId, taskId: input.taskId });
    if (a.admitted) {
      release = a.release;
      break;
    }
    if (opts.nowMs() - start >= opts.admissionWaitMs) {
      log("cli session: admission wait exhausted", { agentSessionId: input.agentSessionId });
      return {
        outcome: "guard_stopped",
        endedBy: "admission_timeout",
        exitCode: null,
        finalTaskStatus: await ports.task.status(),
        usage: null,
        brokerToken: null,
      };
    }
    beat("awaiting session admission");
    await opts.sleep(Math.min(a.retryAfterMs, opts.admissionWaitMs));
  }

  let brokerToken: string | null = null;
  let gatewayToken: string | null = null;
  let opened = false;
  let endedBy: EndedBy = "cli_exit";
  let exitCode: number | null = null;
  let usage: BrokerSessionSummary | null = null;
  try {
    // ---- 2. brokered identity (INV-2): the ONLY credential the container sees
    let mint: { token: string; baseUrl: string } | null = null;
    for (;;) {
      const m = await ports.broker.mint({
        sessionId: input.agentSessionId,
        companyId: input.companyId,
        agentId: input.agentId,
        taskId: input.taskId,
        limits: input.limits,
      });
      if (m.ok) {
        mint = m.mint;
        break;
      }
      if (opts.nowMs() - start >= opts.admissionWaitMs) {
        log("cli session: broker saturated past the admission window", { agentSessionId: input.agentSessionId });
        return {
          outcome: "guard_stopped",
          endedBy: "broker_saturated",
          exitCode: null,
          finalTaskStatus: await ports.task.status(),
          usage: null,
          brokerToken: null,
        };
      }
      beat("awaiting broker slot");
      await opts.sleep(Math.min(m.retryAfterMs, opts.admissionWaitMs));
    }
    brokerToken = mint.token;

    // ---- 3. gateway session (the control plane's bearer for MCP + audit)
    const gw = await ports.gateway.mint({
      companyId: input.companyId,
      agentId: input.agentId,
      taskId: input.taskId,
      agentSessionId: input.agentSessionId,
      terminalSessionId: input.terminalSessionId,
      workspaceId: input.workspaceId,
    });
    gatewayToken = gw.token;

    // ---- 4. the CLI becomes the PTY process
    const env: Record<string, string> = {
      ...(input.extraEnv ?? {}),
      ANTHROPIC_BASE_URL: mint.baseUrl,
      ANTHROPIC_AUTH_TOKEN: mint.token,
      ACOS_GATEWAY_URL: gw.containerGatewayUrl,
      ACOS_GATEWAY_TOKEN: gw.token,
      ACOS_PROMPT: input.brief,
      ACOS_SESSION_MODE: input.sessionMode,
      ACOS_AGENT_SESSION_ID: input.agentSessionId,
      ACOS_TASK_ID: input.taskId,
    };
    if (input.model) env.ACOS_MODEL = input.model;
    const o = await ports.sandbox.open({
      terminalSessionId: input.terminalSessionId,
      workspaceId: input.workspaceId,
      env,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
    });
    opened = true;
    log("cli session opened", { agentSessionId: input.agentSessionId, terminalSessionId: input.terminalSessionId, reused: !o.opened });

    // ---- 5. watch
    const deadline = start + input.limits.maxWallMs;
    for (;;) {
      beat("cli session live");
      const st = await ports.sandbox.status(input.terminalSessionId);
      if (!st || !st.running) {
        exitCode = st?.exitCode ?? null;
        endedBy = "cli_exit";
        break;
      }
      const taskStatus = await ports.task.status();
      if (HANDOFF_STATUSES.has(taskStatus)) {
        endedBy = "task_terminal";
        log("cli session: task handed off, closing", { taskStatus });
        break;
      }
      if (opts.nowMs() >= deadline) {
        endedBy = "wall_clock";
        log("cli session: wall-clock ceiling", { maxWallMs: input.limits.maxWallMs });
        break;
      }
      const sum = await ports.broker.summary(input.agentSessionId);
      if (sum && sum.totals.totalTokens >= input.limits.maxTotalTokens) {
        endedBy = "token_budget";
        log("cli session: token ceiling", { totalTokens: sum.totals.totalTokens });
        break;
      }
      await opts.sleep(opts.pollMs);
    }
  } finally {
    // ---- 6. always: stop the process, revoke both tokens, free the slot
    if (opened) {
      try {
        const fin = await ports.sandbox.end(input.terminalSessionId, opts.endGraceMs);
        if (fin && exitCode === null) exitCode = fin.exitCode;
      } catch (err) {
        log("cli session: end failed", { err: String(err) });
      }
    }
    if (gatewayToken) await ports.gateway.revoke(gatewayToken).catch((err: unknown) => log("gateway revoke failed", { err: String(err) }));
    if (brokerToken) {
      try {
        usage = await ports.broker.revoke(input.agentSessionId);
      } catch (err) {
        log("broker revoke failed", { err: String(err) });
      }
    }
    if (release) await release().catch(() => {});
  }

  const finalTaskStatus = await ports.task.status();
  return {
    outcome: outcomeForStatus(finalTaskStatus, endedBy),
    endedBy,
    exitCode,
    finalTaskStatus,
    usage,
    brokerToken,
  };
}
