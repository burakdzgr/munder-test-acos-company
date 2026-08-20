// driveSession over fakes: the session-boundary guarantees (INV-19: wall-clock
// + token ceilings), the close/revoke discipline (always, even on failure), the
// identity contract (only the broker token + gateway token reach the container),
// and outcome mapping from the task's control-plane status.
import { describe, expect, it } from "vitest";
import { driveSession, outcomeForStatus, type DriveInput, type DriveOptions, type DrivePorts } from "./drive.js";
import type { AdmissionPort, BrokerPort, GatewaySessionPort, SandboxSessionPort, TaskStatePort } from "./ports.js";

function harness(over: {
  taskStatuses?: string[]; // successive answers; last one repeats
  cliExitsAfterPolls?: number | null; // null = never exits on its own
  admitAfter?: number; // admission attempts refused before admitted
  brokerSaturatedTimes?: number;
  gatewayFails?: boolean;
  totalTokensPerPoll?: number;
  exitCodeOnExit?: number;
} = {}) {
  const log: string[] = [];
  let clock = 1_000_000;
  const calls: string[] = [];
  let statusPolls = 0;
  let running = false;
  let taskIdx = 0;
  const statuses = over.taskStatuses ?? ["IN_PROGRESS"];
  let admitAttempts = 0;
  let brokerAttempts = 0;
  let released = 0;
  let revokedBroker = 0;
  const revokedGateway: string[] = [];
  let openedEnv: Record<string, string> | null = null;
  let tokens = 0;

  const admission: AdmissionPort = {
    admit: async () => {
      admitAttempts++;
      if (admitAttempts <= (over.admitAfter ?? 0)) return { admitted: false, retryAfterMs: 10 };
      return { admitted: true, release: async () => void released++ };
    },
  };
  const broker: BrokerPort = {
    mint: async (input) => {
      brokerAttempts++;
      calls.push(`broker.mint:${input.sessionId}`);
      if (brokerAttempts <= (over.brokerSaturatedTimes ?? 0)) return { ok: false, saturated: true, retryAfterMs: 10 };
      return { ok: true, mint: { token: "acos-sess-TOKEN", baseUrl: "http://broker:3779", expiresAt: clock + 10_000 } };
    },
    summary: async () => ({
      sessionId: "s",
      requestCount: 1,
      totals: { inputTokens: tokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens: tokens },
    }),
    revoke: async () => {
      revokedBroker++;
      calls.push("broker.revoke");
      return {
        sessionId: "s",
        requestCount: 3,
        totals: { inputTokens: 30, outputTokens: 9, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens: 39 },
        requests: [],
      };
    },
  };
  const gateway: GatewaySessionPort = {
    mint: async () => {
      calls.push("gateway.mint");
      if (over.gatewayFails) throw new Error("gateway_unavailable");
      return { token: "gw-TOKEN", mcpSessionId: "mcps-1", mcpUrl: "http://server:3000/mcp/v1", expiresAt: null };
    },
    revoke: async (mcpSessionId, companyId) => {
      revokedGateway.push(`${mcpSessionId}@${companyId}`);
      calls.push("gateway.revoke");
    },
  };
  const sandbox: SandboxSessionPort = {
    open: async (input) => {
      calls.push("sandbox.open");
      openedEnv = { ...input.env };
      running = true;
      return { opened: true };
    },
    status: async () => {
      statusPolls++;
      if (over.cliExitsAfterPolls !== null && over.cliExitsAfterPolls !== undefined && statusPolls > over.cliExitsAfterPolls) running = false;
      return { running, exitCode: running ? null : (over.exitCodeOnExit ?? 0) };
    },
    end: async () => {
      calls.push("sandbox.end");
      running = false;
      return { running: false, exitCode: 130 };
    },
  };
  const task: TaskStatePort = {
    status: async () => {
      const s = statuses[Math.min(taskIdx, statuses.length - 1)]!;
      taskIdx++;
      return s;
    },
  };
  const ports: DrivePorts = { admission, broker, gateway, sandbox, task };
  const input: DriveInput = {
    companyId: "co",
    agentId: "ag",
    taskId: "task",
    agentSessionId: "sess-1",
    terminalSessionId: "term-1",
    workspaceId: "ws-1",
    cwd: "/work",
    brief: "do it",
    model: "sonnet",
    sessionMode: "interactive",
    limits: { maxTotalTokens: 1000, maxWallMs: 5_000, maxRequests: 50 },
    cols: 100,
    rows: 30,
  };
  const opts: DriveOptions = {
    pollMs: 100,
    admissionWaitMs: 1_000,
    endGraceMs: 50,
    nowMs: () => clock,
    sleep: async (ms) => {
      clock += ms;
      tokens += over.totalTokensPerPoll ?? 0;
    },
    log: (m) => log.push(m),
  };
  return {
    ports,
    input,
    opts,
    state: () => ({ calls, released, revokedBroker, revokedGateway, openedEnv: openedEnv as Record<string, string> | null, log, statusPolls }),
  };
}

describe("driveSession — the agent turn as one brokered CLI session (ADR-022)", () => {
  it("happy path: admit → mint broker → mint gateway → open with ONLY capability tokens → CLI exits → revoke both → outcome from task status", async () => {
    const h = harness({ taskStatuses: ["IN_PROGRESS", "DONE"], cliExitsAfterPolls: 1 });
    const r = await driveSession(h.ports, h.input, h.opts);
    const s = h.state();
    expect(s.calls.slice(0, 3)).toEqual(["broker.mint:sess-1", "gateway.mint", "sandbox.open"]);
    expect(s.openedEnv).toMatchObject({
      ANTHROPIC_BASE_URL: "http://broker:3779",
      ANTHROPIC_AUTH_TOKEN: "acos-sess-TOKEN",
      ACOS_MCP_URL: "http://server:3000/mcp/v1",
      ACOS_GATEWAY_URL: "http://server:3000",
      ACOS_GATEWAY_TOKEN: "gw-TOKEN",
      ACOS_PROMPT: "do it",
      ACOS_MODEL: "sonnet",
      ACOS_SESSION_MODE: "interactive",
    });
    // no raw credential shape anywhere in the container env
    expect(JSON.stringify(s.openedEnv)).not.toMatch(/sk-ant-(?!sess)/);
    expect(r.endedBy).toBe("cli_exit");
    expect(r.outcome).toBe("completed");
    expect(s.revokedBroker).toBe(1);
    expect(s.revokedGateway).toEqual(["mcps-1@co"]); // revoke by mcpSessionId + companyId (T30 §1.1)
    // INTERNAL_API_TOKEN never enters the container (T30 §1.1 security seam)
    expect(Object.keys(s.openedEnv ?? {})).not.toContain("INTERNAL_API_TOKEN");
    expect(s.released).toBe(1);
    expect(r.usage?.requestCount).toBe(3);
  });

  it("a CLI that dies non-zero within seconds is reported as entry_failed (environment defect), not a quiet abandon", async () => {
    const h = harness({ cliExitsAfterPolls: 0, exitCodeOnExit: 127 });
    const r = await driveSession(h.ports, h.input, h.opts);
    expect(r.endedBy).toBe("entry_failed");
    expect(r.exitCode).toBe(127);
    expect(r.outcome).toBe("guard_stopped");
    expect(h.state().log.some((l) => l.includes("ENTRY FAILED"))).toBe(true);
    expect(h.state().revokedBroker).toBe(1);
  });

  it("task handoff (REVIEW) while the CLI is still alive → runtime ends the session → review_requested", async () => {
    const h = harness({ taskStatuses: ["IN_PROGRESS", "REVIEW"], cliExitsAfterPolls: null });
    const r = await driveSession(h.ports, h.input, h.opts);
    expect(r.endedBy).toBe("task_terminal");
    expect(r.outcome).toBe("review_requested");
    expect(h.state().calls).toContain("sandbox.end");
    expect(r.exitCode).toBe(130);
  });

  it("wall-clock ceiling ends a never-ending session → guard_stopped (INV-19 at the session boundary)", async () => {
    const h = harness({ cliExitsAfterPolls: null });
    const r = await driveSession(h.ports, h.input, h.opts);
    expect(r.endedBy).toBe("wall_clock");
    expect(r.outcome).toBe("guard_stopped");
    expect(h.state().revokedBroker).toBe(1);
  });

  it("token ceiling ends the session → guard_stopped", async () => {
    const h = harness({ cliExitsAfterPolls: null, totalTokensPerPoll: 600 });
    const r = await driveSession(h.ports, h.input, h.opts);
    expect(r.endedBy).toBe("token_budget");
    expect(r.outcome).toBe("guard_stopped");
  });

  it("admission refusals are waited out (cap honoured), then the session starts", async () => {
    const h = harness({ admitAfter: 3, taskStatuses: ["DONE"], cliExitsAfterPolls: 0 });
    const r = await driveSession(h.ports, h.input, h.opts);
    expect(r.endedBy).toBe("cli_exit");
    expect(h.state().calls[0]).toBe("broker.mint:sess-1");
  });

  it("admission never granted within the window → guard_stopped/admission_timeout, nothing opened, nothing to revoke", async () => {
    const h = harness({ admitAfter: 1_000 });
    const r = await driveSession(h.ports, h.input, h.opts);
    expect(r.endedBy).toBe("admission_timeout");
    expect(h.state().calls).toEqual([]);
  });

  it("broker saturated past the window → broker_saturated; slot released", async () => {
    const h = harness({ brokerSaturatedTimes: 1_000 });
    const r = await driveSession(h.ports, h.input, h.opts);
    expect(r.endedBy).toBe("broker_saturated");
    expect(h.state().calls).not.toContain("sandbox.open");
    expect(h.state().released).toBe(1);
  });

  it("gateway mint failure → throws, but the broker token is revoked and the slot released (no un-audited session ever opens)", async () => {
    const h = harness({ gatewayFails: true });
    await expect(driveSession(h.ports, h.input, h.opts)).rejects.toThrow("gateway_unavailable");
    const s = h.state();
    expect(s.calls).not.toContain("sandbox.open");
    expect(s.revokedBroker).toBe(1);
    expect(s.released).toBe(1);
  });
});

describe("outcomeForStatus", () => {
  it("maps control-plane statuses to turn outcomes", () => {
    expect(outcomeForStatus("DONE", "cli_exit")).toBe("completed");
    expect(outcomeForStatus("REVIEW", "task_terminal")).toBe("review_requested");
    expect(outcomeForStatus("QA", "task_terminal")).toBe("review_requested");
    expect(outcomeForStatus("BLOCKED", "task_terminal")).toBe("help_requested");
    expect(outcomeForStatus("WAITING", "cli_exit")).toBe("help_requested");
    expect(outcomeForStatus("IN_PROGRESS", "cli_exit")).toBe("abandoned");
    expect(outcomeForStatus("IN_PROGRESS", "wall_clock")).toBe("guard_stopped");
  });
});
