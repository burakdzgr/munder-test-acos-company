// T36 / M3 gate — demo steps 8–12, 14 (29 §3): a Founder objective (goal,
// owner CEO) cascades TOOLLESS through the hierarchy with the canonical
// scripts: CEO → initiative → CTO → epic → EM → two dev tasks delegated by
// @-mention → devs work and hand off to REVIEW. Sentinel ids resolve in the
// worker, delegation grooms DRAFT→PLANNED through the single status writer,
// every hop auto-starts the child workflow, budgets split pro-rata down the
// tree, messages land in task threads, and the Founder inbox stays EMPTY.
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { uuidv7 } from "@acos/domain";
import {
  TasksService,
  TaskStateService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agents,
  approvals,
  channels,
  companies,
  events,
  messages,
  modelProviders,
  orgEdges,
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
import { startAgentTaskWorkflow } from "../../src/client.js";
import { startPostgres, startTemporal } from "./helpers";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../../src/workflows/index.ts");
const scriptsDir = join(dirname(require.resolve("@acos/llm/package.json")), "testing/scripts");

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

let companyId = "";
const agentId: Record<string, string> = {};
let goalTaskId = "";

beforeAll(async () => {
  [pgContainer, temporal] = await Promise.all([startPostgres(), startTemporal()]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t36.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "CascadeCo", slug: "cascadeco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);

  const [eng] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Engineering", slug: "eng" })
    .returning();
  const [backend] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend", parentId: eng!.id })
    .returning();

  const positionId: Record<string, string> = {};
  for (const [title, role] of [
    ["CEO", "executive"],
    ["CTO", "executive"],
    ["Engineering Manager", "manager"],
    ["Backend Lead", "lead"],
    ["Backend Engineer", "member"],
  ] as const) {
    const [position] = await db
      .insert(positions)
      .values({ companyId, title, seniorityTrack: ["expert"], defaultRole: role })
      .returning();
    positionId[title] = position!.id;
  }

  // seed-name agents so the canonical delegation scripts match by agentName
  const roster: Array<[name: string, title: string, unitId: string, manager: string | null]> = [
    ["Aylin Vural", "CEO", eng!.id, null],
    ["Mert Aksoy", "CTO", eng!.id, "Aylin Vural"],
    ["Selin Koç", "Engineering Manager", eng!.id, "Mert Aksoy"],
    ["Kerem Yıldız", "Backend Lead", backend!.id, "Selin Koç"],
    ["Alex Demir", "Backend Engineer", backend!.id, "Kerem Yıldız"],
    ["Deniz Kaya", "Backend Engineer", backend!.id, "Kerem Yıldız"],
  ];
  let employeeNumber = 0;
  for (const [name, title, unitId, manager] of roster) {
    employeeNumber += 1;
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        employeeNumber,
        name,
        status: "active",
        positionId: positionId[title]!,
        orgUnitId: unitId,
        seniority: "expert",
        autonomyLevel: 4,
        persona: `${name}.`,
      })
      .returning();
    agentId[name] = agent!.id;
    if (manager) {
      await db.insert(orgEdges).values([
        { companyId, fromAgentId: agent!.id, kind: "reports_to", toAgentId: agentId[manager]! },
        { companyId, fromAgentId: agentId[manager]!, kind: "manages", toAgentId: agent!.id },
      ]);
    }
  }

  // the canonical scripts (packages/llm/testing/scripts), no baked-in ids —
  // exactly what the compose worker loads in LLM_MODE=scripted
  const scripts = readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => loadScript(readFileSync(join(scriptsDir, f), "utf8")));
  const [provider] = await db
    .insert(modelProviders)
    .values({ kind: "ollama", name: "scripted" })
    .returning();
  const adapter: ProviderAdapter = { ...createScriptedAdapter(scripts), providerId: provider!.id };
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
    startAgentWorkflow: async ({ companyId: cid, agentId: aid, taskId: tid }) => {
      await startAgentTaskWorkflow(client, "agentTaskWorkflow", {
        companyId: cid,
        agentId: aid,
        taskId: tid,
        sessionId: uuidv7(),
        attempt: 1,
      }).catch((err: unknown) => {
        if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") throw err;
      });
    },
  });
  worker = await Worker.create({
    connection: nativeConnection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.agentTasks,
    workflowsPath,
    activities: activities as unknown as Record<string, (...args: never[]) => unknown>,
  });
  workerRun = worker.run();
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

async function pollUntil<T>(probe: () => Promise<T | null>, what: string, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

describe("M3 gate: toolless delegation cascade (T36, demo steps 8–12/14)", () => {
  it("Founder objective cascades CEO→CTO→EM→devs; devs reach REVIEW; inbox stays empty", async () => {
    // step 8: Founder objective — goal task, groomed and assigned to the CEO
    const tasksService = new TasksService(guardedDb);
    const taskState = new TaskStateService(guardedDb);
    const goal = await tasksService.create(
      ctx,
      {
        kind: "goal",
        title: "Analyze this project and implement feature X",
        objective: "The Founder objective for the M3 gate.",
        budgetCents: 20_000,
      },
      { kind: "founder" },
    );
    goalTaskId = goal.id;
    await taskState.transition(ctx, goal.id, "BACKLOG", { kind: "founder" });
    await taskState.transition(ctx, goal.id, "PLANNED", { kind: "founder" });
    await taskState.assign(ctx, goal.id, { agentId: agentId["Aylin Vural"]! }, { kind: "founder" });

    // assignment starts the CEO workflow (the server does this in prod; the
    // test mirrors its starter) — every further hop auto-starts in-worker
    const ceoResult = await client.workflow.execute("agentTaskWorkflow", {
      taskQueue: TASK_QUEUES.agentTasks,
      workflowId: `agent-task.${goal.id}.${agentId["Aylin Vural"]}`,
      args: [
        {
          companyId,
          agentId: agentId["Aylin Vural"],
          taskId: goal.id,
          sessionId: uuidv7(),
          attempt: 1,
        },
      ],
    });
    expect(ceoResult).toMatchObject({ outcome: "completed" });

    // steps 9–12: the cascade lands both dev tasks in REVIEW
    const devTasks = await pollUntil(async () => {
      const rows = await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), eq(tasks.kind, "task")));
      return rows.length === 2 && rows.every((t) => t.status === "REVIEW") ? rows : null;
    }, "both dev tasks in REVIEW");

    // hierarchy: goal → initiative (CTO) → epic (EM) → 2 tasks (devs)
    const all = await db.select().from(tasks).where(eq(tasks.companyId, companyId));
    const initiative = all.find((t) => t.kind === "initiative")!;
    const epic = all.find((t) => t.kind === "epic")!;
    expect(initiative.parentId).toBe(goal.id);
    expect(epic.parentId).toBe(initiative.id);
    expect(initiative.ownerAgentId).toBe(agentId["Mert Aksoy"]);
    expect(epic.ownerAgentId).toBe(agentId["Selin Koç"]);
    expect(initiative.delegationDepth).toBe(1);
    expect(epic.delegationDepth).toBe(2);
    for (const dev of devTasks) expect(dev.parentId).toBe(epic.id);

    // step 11: owners by @-mention — endpoint→Alex, coverage→Deniz
    const byTitle = new Map(devTasks.map((t) => [t.title, t]));
    expect(byTitle.get("Implement the feature X service endpoint")!.ownerAgentId).toBe(
      agentId["Alex Demir"],
    );
    expect(byTitle.get("Write integration coverage for feature X")!.ownerAgentId).toBe(
      agentId["Deniz Kaya"],
    );

    // pro-rata budgets down the tree (07 §9): 80% pools, effort-weighted
    expect(initiative.budgetCents).toBe(16_000); // floor(20000×0.8×8/8)
    expect(epic.budgetCents).toBe(12_800); // floor(16000×0.8×5/5)
    expect(byTitle.get("Implement the feature X service endpoint")!.budgetCents).toBe(6_144); // ×3/5
    expect(byTitle.get("Write integration coverage for feature X")!.budgetCents).toBe(4_096); // ×2/5

    // step 12: per-role transitions — PLANNED→ASSIGNED by the delegating
    // manager, ASSIGNED→IN_PROGRESS→REVIEW by the owner
    for (const dev of devTasks) {
      const trail = await db
        .select()
        .from(events)
        .where(
          sql`${events.companyId} = ${companyId} AND ${events.type} = 'task.status.changed' AND ${events.taskId} = ${dev.id}`,
        )
        .orderBy(events.seq);
      const moves = trail.map((e) => {
        const p = e.payload as { from: string; to: string; byActor: { kind: string; id: string | null } };
        return `${p.from}→${p.to}:${p.byActor.kind}`;
      });
      expect(moves).toEqual([
        "DRAFT→BACKLOG:agent",
        "BACKLOG→PLANNED:agent",
        "PLANNED→ASSIGNED:agent",
        "ASSIGNED→IN_PROGRESS:agent",
        "IN_PROGRESS→REVIEW:agent",
      ]);
    }

    // step 14: real inter-agent communication — messages persisted in the
    // task threads (manager updates + both devs), all agent.message.sent
    const threadMessages = await db
      .select({ body: messages.body, channelId: messages.channelId })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(and(eq(messages.companyId, companyId), eq(channels.kind, "task_thread")));
    expect(threadMessages.length).toBeGreaterThanOrEqual(5); // CEO+CTO+EM+2 devs
    const sent = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyId} AND ${events.type} = 'agent.message.sent'`);
    expect(sent.length).toBe(threadMessages.length);

    // manager workflows completed too (CTO, EM)
    for (const [taskRow, owner] of [
      [initiative, "Mert Aksoy"],
      [epic, "Selin Koç"],
    ] as const) {
      const describeResult = await client.workflow
        .getHandle(`agent-task.${taskRow.id}.${agentId[owner]}`)
        .describe();
      expect(describeResult.status.name).toBe("COMPLETED");
    }

    // step 25 (M3 flavor): zero routine escalations — the Founder inbox is empty
    const approvalRows = await db.select().from(approvals).where(eq(approvals.companyId, companyId));
    expect(approvalRows).toHaveLength(0);
  }, 180_000);

  it("delegation grooming + assignment events carry the delegators as actors", async () => {
    // the initiative was groomed DRAFT→BACKLOG→PLANNED by the CEO (creator +
    // manager class) before assignment — permissions enforced, not bypassed
    const [initiative] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.kind, "initiative")));
    const trail = await db
      .select()
      .from(events)
      .where(
        sql`${events.companyId} = ${companyId} AND ${events.type} = 'task.status.changed' AND ${events.taskId} = ${initiative!.id}`,
      )
      .orderBy(events.seq);
    const actors = trail.map((e) => (e.payload as { byActor: { id: string | null } }).byActor.id);
    expect(actors.slice(0, 3)).toEqual([
      agentId["Aylin Vural"],
      agentId["Aylin Vural"],
      agentId["Aylin Vural"],
    ]);
    const assigned = await db
      .select()
      .from(events)
      .where(
        sql`${events.companyId} = ${companyId} AND ${events.type} = 'agent.task.assigned' AND ${events.taskId} = ${initiative!.id}`,
      );
    expect(assigned).toHaveLength(1);
    expect((assigned[0]!.payload as { agentId: string }).agentId).toBe(agentId["Mert Aksoy"]);
    expect(goalTaskId).not.toBe("");
  });
});
