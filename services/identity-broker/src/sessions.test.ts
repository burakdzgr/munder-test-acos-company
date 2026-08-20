import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, SessionRegistry, TOKEN_PREFIX } from "./sessions.js";

function harness(start = 1_000_000) {
  let clock = start;
  let n = 0;
  const reg = new SessionRegistry(
    () => clock,
    () => `${TOKEN_PREFIX}t${++n}`,
  );
  return { reg, tick: (ms: number) => (clock += ms), now: () => clock };
}

describe("SessionRegistry — per-session capability tokens (ADR-022 §4, INV-19 at the session boundary)", () => {
  it("mints an opaque token bound to company/agent/task and admits it", () => {
    const { reg } = harness();
    const s = reg.mint({ sessionId: "sess-1", companyId: "co", agentId: "ag", taskId: "t1" });
    expect(s.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(s.limits).toEqual(DEFAULT_LIMITS);
    const a = reg.admit(s.token);
    expect(a.ok && a.session.sessionId).toBe("sess-1");
    expect(reg.admit("acos-sess-nope")).toEqual({ ok: false, reason: "unknown_token" });
  });

  it("is idempotent per sessionId while live (retry-safe mint), new token after revoke", () => {
    const { reg } = harness();
    const a = reg.mint({ sessionId: "s", companyId: "c", agentId: "a" });
    const b = reg.mint({ sessionId: "s", companyId: "c", agentId: "a" });
    expect(b.token).toBe(a.token);
    reg.revoke("s");
    const c = reg.mint({ sessionId: "s", companyId: "c", agentId: "a" });
    expect(c.token).not.toBe(a.token);
    expect(reg.admit(a.token)).toEqual({ ok: false, reason: "unknown_token" });
    expect(reg.admit(c.token).ok).toBe(true);
  });

  it("revoke stops admission immediately but keeps usage for the final read", () => {
    const { reg } = harness();
    const s = reg.mint({ sessionId: "s", companyId: "c", agentId: "a" });
    reg.record("s", {
      requestId: "r1",
      model: "m",
      startedAt: 1,
      durationMs: 5,
      status: 200,
      usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 100 },
    });
    reg.revoke("s");
    expect(reg.admit(s.token)).toEqual({ ok: false, reason: "unknown_token" });
    expect(reg.summary("s")?.totals).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 100,
      totalTokens: 115,
    });
    expect(reg.summary("s")?.revokedAt).not.toBeNull();
  });

  it("wall-clock: refuses after maxWallMs", () => {
    const { reg, tick } = harness();
    const s = reg.mint({ sessionId: "s", companyId: "c", agentId: "a", limits: { maxWallMs: 1000 } });
    expect(reg.admit(s.token).ok).toBe(true);
    tick(1000);
    expect(reg.admit(s.token)).toEqual({ ok: false, reason: "expired" });
  });

  it("token budget: refuses once metered totals reach maxTotalTokens", () => {
    const { reg } = harness();
    const s = reg.mint({ sessionId: "s", companyId: "c", agentId: "a", limits: { maxTotalTokens: 50 } });
    reg.record("s", {
      requestId: "r1",
      model: null,
      startedAt: 1,
      durationMs: 1,
      status: 200,
      usage: { inputTokens: 30, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    });
    expect(reg.admit(s.token).ok).toBe(true);
    reg.record("s", {
      requestId: "r2",
      model: null,
      startedAt: 2,
      durationMs: 1,
      status: 200,
      usage: { inputTokens: 20, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    });
    expect(reg.admit(s.token)).toEqual({ ok: false, reason: "token_budget_exhausted" });
  });

  it("request budget counts in-flight requests too (no burst past the cap)", () => {
    const { reg } = harness();
    const s = reg.mint({ sessionId: "s", companyId: "c", agentId: "a", limits: { maxRequests: 2 } });
    const sess = reg.get("s")!;
    sess.inflight = 2;
    expect(reg.admit(s.token)).toEqual({ ok: false, reason: "request_budget_exhausted" });
  });

  it("reap forgets ended sessions after the grace period, never live ones", () => {
    const { reg, tick } = harness();
    reg.mint({ sessionId: "live", companyId: "c", agentId: "a" });
    reg.mint({ sessionId: "done", companyId: "c", agentId: "a" });
    reg.revoke("done");
    expect(reg.reap(60_000)).toEqual([]);
    tick(60_000);
    expect(reg.reap(60_000)).toEqual(["done"]);
    expect(reg.get("done")).toBeUndefined();
    expect(reg.get("live")).toBeDefined();
    expect(reg.liveCount()).toBe(1);
  });
});
