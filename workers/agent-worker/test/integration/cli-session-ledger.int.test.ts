// E4/T31 — the CLI session's spend lands in the ledger (K1, live finding 2026-08-21).
//
// Observed on the integrated stack: three real CLI turns ran, the broker metered
// them, agent_sessions got tokens_in/out — but `llm_calls` stayed EMPTY because
// the scripted stack has no `claude-cli`/anthropic model_providers row and the
// activity silently skipped the rows. Contract (this test):
//   (1) runCliSessionActivity writes one llm_calls row per broker request,
//       tagged agent_session_id + context_telemetry.runtime='cli', canonical
//       purpose 'reasoning', and creates the `claude-cli` provider row when the
//       stack never seeded one;
//   (2) a re-run for the same session (Temporal retry) does NOT duplicate rows;
//   (3) agent_sessions.steps_count == metered request count and tokens roll up —
//       the DB-only equality Jim's verifier asserts.
// The broker/gateway/sandbox are fakes; Postgres is real (Testcontainers); the
// workspace is the LIGHT session kind (goal task) so only /internal/v1/workspaces
// is served by the fake sandbox-manager HTTP.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { companyContext, createDb, createGuardedDb, runMigrations, type Db, type GuardedDb } from "@acos/db";
import { agentSessions, agents, companies, llmCalls, modelProviders, orgUnits, positions, projects, tasks, users } from "@acos/db/schema";
import { createCliSessionActivities } from "../../src/cli-session/activities.js";
import type { BrokerPort, BrokerSessionSummary, GatewaySessionPort, SandboxSessionPort } from "../../src/cli-session/ports.js";
import { startPostgres } from "./helpers";

describe("CLI session ledger (E4/T31 K1)", { timeout: 300_000 }, () => {
  let pgContainer: Awaited<ReturnType<typeof startPostgres>> | undefined;
  let pool: Pool | undefined;
  let db: Db;
  let guardedDb: GuardedDb;
  let fakeSandbox: Server;
  let sandboxUrl = "";
  let companyId = "";
  let agentId = "";
  let taskId = "";
  const sessionId = "01a0ffff-0000-7000-8000-000000000001";

  const usage = (i: number, o: number, cr: number) => ({ inputTokens: i, outputTokens: o, cacheCreationInputTokens: 0, cacheReadInputTokens: cr });
  const summary: BrokerSessionSummary = {
    sessionId,
    requestCount: 3,
    totals: { inputTokens: 30, outputTokens: 12, cacheCreationInputTokens: 0, cacheReadInputTokens: 500, totalTokens: 542 },
    requests: [
      { requestId: `${sessionId}:1:1`, model: "claude-sonnet-5", startedAt: 1, durationMs: 900, status: 200, usage: usage(10, 4, 100) },
      { requestId: `${sessionId}:2:2`, model: "claude-sonnet-5", startedAt: 2, durationMs: 800, status: 200, usage: usage(10, 4, 200) },
      { requestId: `${sessionId}:3:3`, model: "claude-sonnet-5", startedAt: 3, durationMs: 700, status: 429, usage: usage(10, 4, 200) },
    ],
  };
  const broker: BrokerPort = {
    mint: async () => ({ ok: true, mint: { token: "acos-sess-test", baseUrl: "http://broker:3779", expiresAt: 1 } }),
    summary: async () => summary,
    revoke: async () => summary,
  };
  const gateway: GatewaySessionPort = {
    mint: async () => ({ token: "gw-test", mcpSessionId: "mcps-test", mcpUrl: "http://server:3000/mcp/v1", expiresAt: null }),
    revoke: async () => {},
  };
  let polls = 0;
  const sandboxSessions: SandboxSessionPort = {
    open: async () => ({ opened: true }),
    // first poll: running; the task is moved to DONE below so the driver closes on handoff
    status: async () => ({ running: polls++ < 1, exitCode: polls > 1 ? 0 : null }),
    end: async () => ({ running: false, exitCode: 0 }),
  };

  beforeAll(async () => {
    pgContainer = await startPostgres();
    await runMigrations(pgContainer.getConnectionUri());
    pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
    pool.on("error", () => {});
    db = createDb(pool);
    guardedDb = createGuardedDb(pool);

    // fake sandbox-manager: only the workspace create is needed for a session-kind workspace
    fakeSandbox = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.writeHead(201, { "content-type": "application/json" });
        if (req.url === "/internal/v1/workspaces") {
          const ws = JSON.parse(body) as { workspaceId: string };
          return res.end(JSON.stringify({ workspaceId: ws.workspaceId, containerId: "deadbeef", isolation: "coding", status: "running", createdAt: new Date().toISOString() }));
        }
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => fakeSandbox.listen(0, "127.0.0.1", r));
    sandboxUrl = `http://127.0.0.1:${(fakeSandbox.address() as AddressInfo).port}`;

    const [founder] = await db.insert(users).values({ email: "founder@cli-ledger.local", passwordHash: "x", displayName: "F" }).returning();
    const [company] = await db.insert(companies).values({ name: "CliLedgerCo", slug: "cliledgerco", createdByUserId: founder!.id }).returning();
    companyId = company!.id;
    const [project] = await db
      .insert(projects)
      .values({ companyId, slug: "clip", name: "CliP", objectiveMd: "health endpoint", status: "ready", createdByUserId: founder!.id })
      .returning();
    const [unit] = await db.insert(orgUnits).values({ companyId, kind: "team", name: "Exec", slug: "exec" }).returning();
    const [pos] = await db.insert(positions).values({ companyId, title: "CEO", seniorityTrack: ["senior"], defaultRole: "manager" }).returning();
    const [agent] = await db
      .insert(agents)
      .values({ companyId, employeeNumber: 901, name: "Aylin", status: "active", positionId: pos!.id, orgUnitId: unit!.id, seniority: "senior", autonomyLevel: 3, persona: "x" })
      .returning();
    agentId = agent!.id;
    const [task] = await db
      .insert(tasks)
      .values({ companyId, projectId: project!.id, number: 1, kind: "goal", title: "Deliver /health", objective: "200 + status ok", status: "IN_PROGRESS", ownerAgentId: agentId })
      .returning();
    taskId = task!.id;
    await db.insert(agentSessions).values({ id: sessionId, companyId, agentId, taskId, workflowId: "wf-1", runId: "run-1", status: "running", currentActivity: "WORKING" });
  }, 300_000);

  afterAll(async () => {
    await new Promise<void>((r) => fakeSandbox?.close(() => r()));
    await pool?.end();
    await pgContainer?.stop();
  }, 300_000);

  it("writes session-level llm_calls (creating the claude-cli provider row), idempotently, and rolls totals into agent_sessions", async () => {
    const activities = createCliSessionActivities({
      guardedDb,
      config: {
        runtime: "cli",
        sessionMode: "print",
        workspaceKind: "auto",
        workspaceImage: "acos/workspace-node:e4",
        model: undefined,
        limits: { maxTotalTokens: 1_000_000, maxWallMs: 60_000, maxRequests: 50 },
        admissionWaitMs: 1_000,
        pollMs: 10,
        endGraceMs: 10,
        cols: 80,
        rows: 24,
      },
      broker,
      gateway,
      sandboxSessions,
      sandboxHttp: { baseUrl: sandboxUrl, token: "internal-test" },
      log: () => {},
    });
    // the agent "completes" its task through the gateway while the CLI is live
    const ctx = companyContext(companyId);
    setTimeout(() => {
      void guardedDb.update(tasks).set({ status: "DONE" }).where(eq(tasks.id, taskId));
    }, 5);

    expect((await db.select().from(modelProviders).where(eq(modelProviders.name, "claude-cli"))).length).toBe(0);
    const result = await activities.runCliSessionActivity({ companyId, agentId, taskId, sessionId });
    expect(["completed", "abandoned"]).toContain(result.outcome); // DONE → completed; timing-tolerant
    expect(result.requests).toBe(3);
    expect(result.tokensIn).toBe(30);
    expect(result.tokensOut).toBe(12);

    // (1) rows + provider row
    const providers = await db.select().from(modelProviders).where(eq(modelProviders.name, "claude-cli"));
    expect(providers).toHaveLength(1);
    expect(providers[0]!.kind).toBe("anthropic");
    const rows = await db.select().from(llmCalls).where(eq(llmCalls.companyId, companyId));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.agentSessionId).toBe(sessionId);
      expect(r.agentId).toBe(agentId);
      expect(r.taskId).toBe(taskId);
      expect(r.purpose).toBe("reasoning");
      expect(r.providerId).toBe(providers[0]!.id);
      expect((r.contextTelemetry as { runtime?: string }).runtime).toBe("cli");
    }
    expect(rows.map((r) => r.status).sort()).toEqual(["ok", "ok", "rate_limited"]);
    expect(rows.reduce((n, r) => n + r.tokensCached, 0)).toBe(500);

    // (3) accounting equality the verifier asserts DB-only
    const [session] = await db.select().from(agentSessions).where(eq(agentSessions.id, sessionId));
    expect(session!.stepsCount).toBe(3);
    expect(session!.tokensIn).toBe(30);
    expect(session!.tokensOut).toBe(12);

    // (2) a retry of the same session writes nothing twice
    polls = 0;
    await activities.runCliSessionActivity({ companyId, agentId, taskId, sessionId });
    expect((await db.select().from(llmCalls).where(eq(llmCalls.companyId, companyId))).length).toBe(3);
    expect((await db.select().from(modelProviders).where(eq(modelProviders.name, "claude-cli"))).length).toBe(1);
    void ctx;
  });
});
