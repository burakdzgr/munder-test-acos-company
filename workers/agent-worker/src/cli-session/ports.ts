// E4/T31 (ADR-022): the agent turn as a live Claude Code CLI session.
// Ports the session driver talks to — all HTTP in production, all fakeable
// in tests. The driver itself (drive.ts) owns no I/O beyond these.

export interface SessionLimits {
  readonly maxTotalTokens: number;
  readonly maxWallMs: number;
  readonly maxRequests: number;
}

export interface BrokerMint {
  readonly token: string;
  readonly baseUrl: string;
  readonly expiresAt: number;
}

export interface BrokerUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly totalTokens: number;
}

export interface BrokerRequestRecord {
  readonly requestId: string;
  readonly model: string | null;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly status: number;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheCreationInputTokens: number;
    readonly cacheReadInputTokens: number;
  } | null;
}

export interface BrokerSessionSummary {
  readonly sessionId: string;
  readonly requestCount: number;
  readonly totals: BrokerUsageTotals;
  readonly requests?: readonly BrokerRequestRecord[];
}

/** Identity broker control plane (services/identity-broker). */
export interface BrokerPort {
  mint(input: {
    sessionId: string;
    companyId: string;
    agentId: string;
    taskId: string;
    limits: Partial<SessionLimits>;
  }): Promise<{ ok: true; mint: BrokerMint } | { ok: false; saturated: true; retryAfterMs: number }>;
  summary(sessionId: string): Promise<BrokerSessionSummary | null>;
  /** Revoke + return the final usage (with requests) in one call. */
  revoke(sessionId: string): Promise<BrokerSessionSummary | null>;
}

/** Tool Gateway MCP sessions (T30 contract §1.1): `POST /internal/v1/mcp/sessions`
 *  mints the per-session bearer the container's CLI presents to the gateway
 *  (MCP at `mcpUrl` + the builtin audit endpoint). Minted with the INTERNAL
 *  token on the HOST side; only `token` enters the container. */
export interface GatewaySessionPort {
  mint(input: {
    companyId: string;
    agentId: string;
    taskId: string;
    agentSessionId: string;
    ttlSec?: number;
  }): Promise<{ token: string; mcpSessionId: string; mcpUrl: string; expiresAt: string | number | null }>;
  revoke(mcpSessionId: string, companyId: string): Promise<void>;
}

export interface AgentSessionStatus {
  readonly running: boolean;
  readonly exitCode: number | null;
}

/** sandbox-manager agent-session routes (services/sandbox-manager). */
export interface SandboxSessionPort {
  open(input: {
    terminalSessionId: string;
    workspaceId: string;
    env: Readonly<Record<string, string>>;
    cwd: string;
    cols: number;
    rows: number;
  }): Promise<{ opened: boolean }>;
  status(terminalSessionId: string): Promise<AgentSessionStatus | null>;
  end(terminalSessionId: string, graceMs: number): Promise<AgentSessionStatus | null>;
}

/** The task's current status as the control plane sees it (the MCP tools
 *  move it; the driver only READS it to decide when the session is done). */
export interface TaskStatePort {
  status(): Promise<string>;
}

/** Company-scoped live-session admission (Scheduler cap — Oscar's T30).
 *  The default implementation admits unconditionally; the broker's per-company
 *  ceiling is the backstop. */
export interface AdmissionPort {
  admit(input: { companyId: string; agentId: string; taskId: string }): Promise<
    { admitted: true; release: () => Promise<void> } | { admitted: false; retryAfterMs: number }
  >;
}

export const ALWAYS_ADMIT: AdmissionPort = {
  admit: async () => ({ admitted: true, release: async () => {} }),
};

export type CliOutcome = "completed" | "review_requested" | "help_requested" | "abandoned" | "guard_stopped";

export type EndedBy =
  | "cli_exit" // the CLI process ended on its own (print mode, /exit, crash)
  | "task_terminal" // task reached a terminal/handoff state → runtime closed the session
  | "wall_clock"
  | "token_budget"
  | "admission_timeout"
  | "broker_saturated";

export interface DriveResult {
  readonly outcome: CliOutcome;
  readonly endedBy: EndedBy;
  readonly exitCode: number | null;
  readonly finalTaskStatus: string;
  readonly usage: BrokerSessionSummary | null;
  readonly brokerToken: string | null;
}
