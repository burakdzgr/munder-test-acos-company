// T32 acceptance: the scripted loop drives a task ASSIGNED→IN_PROGRESS→REVIEW
// through the real workflow on a real Temporal server; step order and
// stepId-derived idempotency keys are asserted, and a replayed persist is a
// no-op (exactly-once effects, 08 §11).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, asc, eq, sql } from "drizzle-orm";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { uuidv5, uuidv7 } from "@acos/domain";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agentSessions,
  agentSteps,
  agents,
  companies,
  events,
  llmCalls,
  modelProviders,
  orgUnits,
  positions,
  tasks,
  users,
} from "@acos/db/schema";
import { ModelRouter, type ProviderAdapter } from "@acos/llm";
import { createScriptedAdapter, loadScript } from "@acos/llm/testing";
import { TASK_QUEUES } from "@acos/config";
import { createAgentTaskActivities } from "../../src/activities/agent-task.js";
import { workflowIds } from "../../src/client.js";
import { startPostgres, startTemporal } from "./helpers";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../../src/workflows/index.ts");

let pgContainer: Awaited<ReturnType<typeof startPostgres>>;
let temporal: Awaited<ReturnType<typeof startTemporal>>;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let nativeConnection: NativeConnection;
let clientConnection: Connection;
let client: Client;
let worker: Worker;
let workerRun: Promise<void>;
let activities: ReturnType<typeof createAgentTaskActivities>;

let companyId = "";
let OWEN = "";
let taskId = "";
const sessionId = uuidv7();

beforeAll(async () => {
  [pgContainer, temporal] = await Promise.all([startPostgres(), startTemporal()]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  // ---- seed: company, position(role=backend-dev), agent, ASSIGNED task ----
  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t32.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "LoopCo", slug: "loopco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Eng", slug: "eng" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({
      companyId,
      title: "Backend Engineer",
      seniorityTrack: ["mid"],
      defaultRole: "backend-dev", // matches the canonical script's role key
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      employeeNumber: 1,
      name: "Owen Owner",
      status: "active",
      positionId: position!.id,
      orgUnitId: unit!.id,
      seniority: "mid",
      autonomyLevel: 2,
      persona: "Backend engineer.",
    })
    .returning();
  OWEN = agent!.id;
  const [task] = await db
    .insert(tasks)
    .values({
      companyId,
      number: 1,
      kind: "task",
      title: "Implement CSV export",
      objective: "CSV export works.",
      status: "ASSIGNED",
      ownerAgentId: OWEN,
      successCriteria: ["exports CSV"],
      context: { taskFixture: "implement-feature" },
    })
    .returning();
  taskId = task!.id;

  // ---- scripted router behind a real provider row (llm_calls FK) ----
  const [provider] = await db
    .insert(modelProviders)
    .values({ kind: "ollama", name: "scripted" })
    .returning();
  const scriptsDir = join(dirname(require.resolve("@acos/llm/package.json")), "testing/scripts");
  const script = loadScript(
    readFileSync(join(scriptsDir, "backend-dev.task-implement.yaml"), "utf8"),
  );
  const adapter: ProviderAdapter = {
    ...createScriptedAdapter([script], { taskId }),
    providerId: provider!.id,
  };
  const router = new ModelRouter({
    providers: new Map([[provider!.id, adapter]]),
    logCall: () => {},
  });
  activities = createAgentTaskActivities({
    guardedDb,
    router,
    routingFor: async () => ({
      bindings: [],
      profiles: [{ purpose: "reasoning", providerId: provider!.id, model: "scripted" }],
    }),
  });

  nativeConnection = await NativeConnection.connect({ address: temporal.address });
  worker = await Worker.create({
    connection: nativeConnection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.agentTasks,
    workflowsPath,
    activities: activities as unknown as Record<string, (...args: never[]) => unknown>,
  });
  workerRun = worker.run();
  clientConnection = await Connection.connect({ address: temporal.address });
  client = new Client({ connection: clientConnection, namespace: "acos" });
}, 300_000);

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await clientConnection?.close();
  await nativeConnection?.close();
  await pool?.end();
  await pgContainer?.stop();
  await temporal?.container.stop();
});

describe("agentTaskWorkflow core loop (T32)", () => {
  it("scripted loop drives ASSIGNED→IN_PROGRESS→REVIEW and stops at request_review", async () => {
    const result = await client.workflow.execute("agentTaskWorkflow", {
      taskQueue: TASK_QUEUES.agentTasks,
      workflowId: workflowIds.agentTask(taskId, OWEN),
      args: [{ companyId, agentId: OWEN, taskId, sessionId, attempt: 1 }],
    });
    expect(result).toEqual({ outcome: "review_requested", steps: 4 });

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)));
    expect(task!.status).toBe("REVIEW");

    // the exact status trail, driven by the agent through the single writer
    const trail = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyId} AND ${events.type} = 'task.status.changed'`)
      .orderBy(events.seq);
    expect(
      trail.map((e) => {
        const p = e.payload as { from: string; to: string; byActor: { kind: string; id: string | null } };
        return `${p.from}→${p.to}:${p.byActor.kind}:${p.byActor.id}`;
      }),
    ).toEqual([
      `ASSIGNED→IN_PROGRESS:agent:${OWEN}`,
      `IN_PROGRESS→REVIEW:agent:${OWEN}`,
    ]);
  }, 180_000);

  it("persists steps in order with stepId = uuidv5(stepNo, sessionId) idempotency keys", async () => {
    const steps = await db
      .select()
      .from(agentSteps)
      .where(and(eq(agentSteps.companyId, companyId), eq(agentSteps.agentSessionId, sessionId)))
      .orderBy(asc(agentSteps.stepNo));
    expect(steps.map((s) => s.actionKind)).toEqual([
      "update_task_status",
      "use_tool",
      "use_tool",
      "request_review",
    ]);
    for (const step of steps) {
      expect(step.id).toBe(uuidv5(String(step.stepNo), sessionId)); // 08 §2
      expect(step.agentId).toBe(OWEN);
      expect(step.taskId).toBe(taskId);
    }
    // scripted tool steps carried the stubbed observation the branches key on
    expect((steps[1]!.observation as { exitCode: number }).exitCode).toBe(0);

    // llm_calls accounting: exactly one row per step, keyed off the stepId
    const calls = await db
      .select()
      .from(llmCalls)
      .where(and(eq(llmCalls.companyId, companyId), eq(llmCalls.agentSessionId, sessionId)));
    expect(calls).toHaveLength(4);
    const expectedCallIds = new Set(
      steps.map((s) => uuidv5("llm:0", uuidv5(String(s.stepNo), sessionId))),
    );
    expect(new Set(calls.map((c) => c.id))).toEqual(expectedCallIds);
  });

  it("session lifecycle: running→completed with counters + presence events", async () => {
    const [session] = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.companyId, companyId), eq(agentSessions.id, sessionId)));
    expect(session!.status).toBe("completed");
    expect(session!.stepsCount).toBe(4);
    expect(session!.endedAt).not.toBeNull();
    expect(session!.tokensIn).toBeGreaterThan(0);

    const types = (
      await db
        .select({ type: events.type })
        .from(events)
        .where(sql`${events.companyId} = ${companyId}`)
    ).map((r) => r.type);
    expect(types).toContain("agent.task.started");
    expect(types).toContain("agent.session.ended");
    expect(types.filter((t) => t === "agent.status.changed")).toHaveLength(2); // WORKING + IDLE
  });

  it("a replayed persistStepActivity is a no-op (exactly-once effects)", async () => {
    const stepId = uuidv5("1", sessionId);
    const [before] = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.companyId, companyId), eq(agentSessions.id, sessionId)));
    const replay = await activities.persistStepActivity({
      companyId,
      agentId: OWEN,
      taskId,
      sessionId,
      stepId,
      stepNo: 1,
      action: { type: "update_task_status", taskId, to: "IN_PROGRESS", note: "replay" },
      observation: { ok: true },
      usage: { inputTokens: 999, outputTokens: 999, cachedInputTokens: 0 },
      costCents: 999,
      durationMs: 1,
    });
    expect(replay).toEqual({ inserted: false });
    const stepCount = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentSteps)
      .where(and(eq(agentSteps.companyId, companyId), eq(agentSteps.agentSessionId, sessionId)));
    expect(Number(stepCount[0]!.n)).toBe(4);
    const [after] = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.companyId, companyId), eq(agentSessions.id, sessionId)));
    expect(after!.tokensIn).toBe(before!.tokensIn); // counters untouched
    expect(after!.costCents).toBe(before!.costCents);
  });
});
