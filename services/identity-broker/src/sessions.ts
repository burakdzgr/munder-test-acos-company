// Per-session capability tokens (E4/ADR-022 §4 "identity is brokered, never
// mounted"). The runtime mints ONE token per live CLI session; the workspace
// container receives only that token + the broker URL. The token is opaque,
// revocable, wall-clock bounded and token-budget bounded (INV-19 re-established
// at the session boundary), and maps back to {companyId, agentId, taskId} so
// every metered request is attributable. Nothing here touches the subscription
// credential — see credentials.ts.
import { randomBytes } from "node:crypto";

export interface SessionLimits {
  /** Hard ceiling on input+output+cache tokens across the whole session. */
  readonly maxTotalTokens: number;
  /** Wall-clock lifetime from mint; expired tokens are refused. */
  readonly maxWallMs: number;
  /** Upper bound on upstream requests (runaway-loop guard). */
  readonly maxRequests: number;
}

export const DEFAULT_LIMITS: SessionLimits = {
  maxTotalTokens: 5_000_000,
  maxWallMs: 2 * 60 * 60 * 1000, // 2h
  maxRequests: 400,
};

export interface MintInput {
  readonly sessionId: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly taskId?: string;
  readonly limits?: Partial<SessionLimits>;
}

export interface UsageCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

export interface RequestRecord {
  readonly requestId: string;
  readonly model: string | null;
  readonly startedAt: number;
  readonly durationMs: number;
  /** Upstream HTTP status (0 = transport failure before a status arrived). */
  readonly status: number;
  readonly usage: UsageCounts | null;
}

export interface BrokerSession {
  readonly sessionId: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly taskId: string | null;
  readonly token: string;
  readonly mintedAt: number;
  readonly expiresAt: number;
  readonly limits: SessionLimits;
  revokedAt: number | null;
  requests: RequestRecord[];
  /** Requests in flight right now (for cleanup/observability). */
  inflight: number;
}

export type RefusalReason =
  | "unknown_token"
  | "revoked"
  | "expired"
  | "token_budget_exhausted"
  | "request_budget_exhausted";

export interface SessionSummary {
  readonly sessionId: string;
  readonly companyId: string;
  readonly agentId: string;
  readonly taskId: string | null;
  readonly mintedAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly limits: SessionLimits;
  readonly requestCount: number;
  readonly inflight: number;
  readonly totals: UsageCounts & { readonly totalTokens: number };
}

export const TOKEN_PREFIX = "acos-sess-";

function sumUsage(requests: readonly RequestRecord[]): UsageCounts & { totalTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  for (const r of requests) {
    if (!r.usage) continue;
    inputTokens += r.usage.inputTokens;
    outputTokens += r.usage.outputTokens;
    cacheCreationInputTokens += r.usage.cacheCreationInputTokens;
    cacheReadInputTokens += r.usage.cacheReadInputTokens;
  }
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
  };
}

export class SessionRegistry {
  private readonly bySession = new Map<string, BrokerSession>();
  private readonly byToken = new Map<string, BrokerSession>();

  constructor(
    private readonly nowMs: () => number = () => Date.now(),
    private readonly randomToken: () => string = () => TOKEN_PREFIX + randomBytes(24).toString("base64url"),
  ) {}

  /** Idempotent per sessionId: re-minting an un-revoked session returns the SAME token. */
  mint(input: MintInput): BrokerSession {
    const existing = this.bySession.get(input.sessionId);
    if (existing && existing.revokedAt === null) return existing;
    const now = this.nowMs();
    const limits: SessionLimits = { ...DEFAULT_LIMITS, ...stripUndefined(input.limits ?? {}) };
    const session: BrokerSession = {
      sessionId: input.sessionId,
      companyId: input.companyId,
      agentId: input.agentId,
      taskId: input.taskId ?? null,
      token: this.randomToken(),
      mintedAt: now,
      expiresAt: now + limits.maxWallMs,
      limits,
      revokedAt: null,
      requests: existing?.requests ?? [],
      inflight: 0,
    };
    this.bySession.set(session.sessionId, session);
    this.byToken.set(session.token, session);
    return session;
  }

  get(sessionId: string): BrokerSession | undefined {
    return this.bySession.get(sessionId);
  }

  /** Admission check for a proxied request: the token must be live and under budget. */
  admit(token: string): { ok: true; session: BrokerSession } | { ok: false; reason: RefusalReason } {
    const session = this.byToken.get(token);
    if (!session) return { ok: false, reason: "unknown_token" };
    if (session.revokedAt !== null) return { ok: false, reason: "revoked" };
    if (this.nowMs() >= session.expiresAt) return { ok: false, reason: "expired" };
    if (session.requests.length + session.inflight >= session.limits.maxRequests) {
      return { ok: false, reason: "request_budget_exhausted" };
    }
    if (sumUsage(session.requests).totalTokens >= session.limits.maxTotalTokens) {
      return { ok: false, reason: "token_budget_exhausted" };
    }
    return { ok: true, session };
  }

  record(sessionId: string, rec: RequestRecord): void {
    const session = this.bySession.get(sessionId);
    if (!session) return;
    session.requests.push(rec);
  }

  /** Revoke: the token stops working immediately; usage history is kept for the final read. */
  revoke(sessionId: string): BrokerSession | undefined {
    const session = this.bySession.get(sessionId);
    if (!session) return undefined;
    if (session.revokedAt === null) session.revokedAt = this.nowMs();
    this.byToken.delete(session.token);
    return session;
  }

  /** Forget a session entirely (after the runtime has drained its usage). */
  forget(sessionId: string): boolean {
    const session = this.bySession.get(sessionId);
    if (!session) return false;
    this.byToken.delete(session.token);
    this.bySession.delete(sessionId);
    return true;
  }

  /** Drop revoked/expired sessions older than `graceMs` — never leaks. */
  reap(graceMs: number): string[] {
    const now = this.nowMs();
    const dropped: string[] = [];
    for (const s of this.bySession.values()) {
      const endedAt = s.revokedAt ?? (now >= s.expiresAt ? s.expiresAt : null);
      if (endedAt !== null && now - endedAt >= graceMs && s.inflight === 0) {
        this.forget(s.sessionId);
        dropped.push(s.sessionId);
      }
    }
    return dropped;
  }

  summary(sessionId: string): SessionSummary | undefined {
    const s = this.bySession.get(sessionId);
    if (!s) return undefined;
    return {
      sessionId: s.sessionId,
      companyId: s.companyId,
      agentId: s.agentId,
      taskId: s.taskId,
      mintedAt: s.mintedAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      limits: s.limits,
      requestCount: s.requests.length,
      inflight: s.inflight,
      totals: sumUsage(s.requests),
    };
  }

  list(): SessionSummary[] {
    return [...this.bySession.keys()].map((id) => this.summary(id)!).filter(Boolean);
  }

  liveCount(): number {
    const now = this.nowMs();
    let n = 0;
    for (const s of this.bySession.values()) if (s.revokedAt === null && now < s.expiresAt) n++;
    return n;
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
