// T36 / R1 resilience addendum (29 §3): kill the agent-worker mid-run on a
// toolless task — the workflow survives (Temporal history is the truth), a
// fresh worker resumes exactly where it stopped, and every step effect is
// exactly-once (no duplicated agent_steps / llm_calls, single session).
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker, type WorkerOptions } from "@temporalio/worker";
import { uuidv7 } from "@acos/domain";
import {
  ChannelService,
  MessageService,
  companyContext,
  createDb,
  createGuardedDb,
  deliverMessage,
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
import { createTemporalSignalPort } from "../../src/delivery.js";
import { startPostgres, startTemporal } from "./helpers";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../../src/workflows/index.ts");

const KILL_SCRIPT = `
match: { role: member, taskFixture: kill-resume }
steps:
  - action: update_task_status
    args: { status: IN_PROGRESS }
  - action: send_message
    args: { body: checkpoint before the worker dies }
  - action: wait_for
    args: { what: reply, timeoutMinutes: 60 }
  - action: request_review
    args: { summary: resumed on a fresh worker and finished }
`;

let pgContainer: Awaited<ReturnType<typeof startPostgres>>;
let temporal: Awaited<ReturnType<typeof startTemporal>>;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let nativeConnection: NativeConnection;
let clientConnection: Connection;
let client: Client;
let workerOptions: WorkerOptions;

let companyId = "";
let AGENT = "";
let taskId = "";
const sessionId = uuidv7();

beforeAll(async () => {
  [pgContainer, temporal] = await Promise.all([startPostgres(), startTemporal()]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t36r1.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "KillCo", slug: "killco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Ops", slug: "ops" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  AGENT = (
    await db
      .insert(agents)
      .values({
        companyId,
        employeeNumber: 1,
        name: "Kira Killtest",
        status: "active",
        positionId: position!.id,
        orgUnitId: unit!.id,
        seniority: "mid",
        autonomyLevel: 2,
        persona: "Survives worker crashes.",
      })
      .returning()
  )[0]!.id;
  taskId = (
    await db
      .insert(tasks)
      .values({
        companyId,
        number: 1,
        kind: "task",
        title: "Survive the worker kill",
        objective: "Toolless run for R1.",
        status: "ASSIGNED",
        ownerAgentId: AGENT,
        successCriteria: ["resumed"],
        context: { taskFixture: "kill-resume" },
      })
      .returning()
  )[0]!.id;

  const [provider] = await db
    .insert(modelProviders)
    .values({ kind: "ollama", name: "scripted" })
    .returning();
  const adapter: ProviderAdapter = {
    ...createScriptedAdapter([loadScript(KILL_SCRIPT)], { taskId }),
    providerId: provider!.id,
  };
  const router = new ModelRouter({ providers: new Map([[provider!.id, adapter]]), logCall: () => {} });

  nativeConnection = await NativeConnection.connect({ address: temporal.address });
  clientConnection = await Connection.connect({ address: temporal.address });
  client = new Client({ connection: clientConnection, namespace: "acos" });

  const activities = createAgentTaskActivities({
    guardedDb,
    router,
    routingFor: async () => ({
      bindings: [],
      profiles: [{ purpose: "reasoning", providerId: provider!.id, model: "scripted" }],
    }),
    signalPort: createTemporalSignalPort(client),
  });
  workerOptions = {
    connection: nativeConnection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.agentTasks,
    workflowsPath,
    activities: activities as unknown as Record<string, (...args: never[]) => unknown>,
  };
}, 300_000);

afterAll(async () => {
  await clientConnection?.close();
  await nativeConnection?.close();
  await pool?.end();
  await pgContainer?.stop();
  await temporal?.container.stop();
});

describe("R1: worker kill during a toolless run (T36)", () => {
  it("kill after progress → workflow survives → fresh worker resumes → exactly-once effects", async () => {
    // worker A drives the first steps, then dies
    const workerA = await Worker.create(workerOptions);
    const runA = workerA.run();
    const execution = client.workflow.execute("agentTaskWorkflow", {
      taskQueue: TASK_QUEUES.agentTasks,
      workflowId: `agent-task.${taskId}.${AGENT}`,
      args: [{ companyId, agentId: AGENT, taskId, sessionId, attempt: 1 }],
    });

    const deadline = Date.now() + 60_000;
    for (;;) {
      const [t] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
      if (t!.status === "WAITING") break; // steps 1–3 done, parked on wait_for
      if (Date.now() > deadline) throw new Error(`never reached WAITING (${t!.status})`);
      await new Promise((r) => setTimeout(r, 300));
    }
    workerA.shutdown();
    await runA; // A is fully gone — nothing is polling the task queue

    // the workflow is still alive in Temporal, task state intact in Postgres
    const handle = client.workflow.getHandle(`agent-task.${taskId}.${AGENT}`);
    expect((await handle.describe()).status.name).toBe("RUNNING");
    const [parked] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
    expect(parked!.status).toBe("WAITING");

    // worker B takes over; the pending reply wakes the wait and the script finishes
    const workerB = await Worker.create(workerOptions);
    const runB = workerB.run();
    const channelService = new ChannelService(guardedDb);
    const messageService = new MessageService(guardedDb, channelService);
    const dm = await channelService.getOrCreateDm(ctx, null, AGENT);
    const plan = await messageService.send(ctx, {
      channelId: dm.id,
      senderAgentId: null,
      kind: "text",
      body: "Reply that wakes the resumed workflow",
      idempotencyKey: uuidv7(),
    });
    await deliverMessage(guardedDb, ctx, plan, createTemporalSignalPort(client));

    const result = await execution;
    expect(result).toMatchObject({ outcome: "review_requested", steps: 4 });
    workerB.shutdown();
    await runB;

    // no lost or duplicated state: steps 1..4 exactly once, one llm call per
    // step (no repairs), a single session row, task at REVIEW
    const steps = await db
      .select({ stepNo: agentSteps.stepNo })
      .from(agentSteps)
      .where(and(eq(agentSteps.companyId, companyId), eq(agentSteps.agentSessionId, sessionId)))
      .orderBy(agentSteps.stepNo);
    expect(steps.map((s) => s.stepNo)).toEqual([1, 2, 3, 4]);
    const calls = await db
      .select()
      .from(llmCalls)
      .where(and(eq(llmCalls.companyId, companyId), eq(llmCalls.agentSessionId, sessionId)));
    expect(calls).toHaveLength(4);
    const sessions = await db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.companyId, companyId), eq(agentSessions.agentId, AGENT)));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe("completed");
    expect(sessions[0]!.stepsCount).toBe(4);
    const [finalTask] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
    expect(finalTask!.status).toBe("REVIEW");
    // the full trail is intact — nothing replayed twice into the outbox
    const trail = await db
      .select()
      .from(events)
      .where(
        sql`${events.companyId} = ${companyId} AND ${events.type} = 'task.status.changed' AND ${events.taskId} = ${taskId}`,
      )
      .orderBy(events.seq);
    expect(
      trail.map((e) => `${(e.payload as { from: string }).from}→${(e.payload as { to: string }).to}`),
    ).toEqual(["ASSIGNED→IN_PROGRESS", "IN_PROGRESS→WAITING", "WAITING→IN_PROGRESS", "IN_PROGRESS→REVIEW"]);
  }, 150_000);
});
