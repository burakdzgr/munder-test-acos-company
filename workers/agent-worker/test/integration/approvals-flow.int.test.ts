// T35 acceptance (worker side): an R3-style escalate BLOCKS the workflow
// durably until the Founder verdict arrives as the approvalVerdict signal
// (approved path resumes and completes), and on silence the workflow's own
// expiry timer closes the approval — approval.expired fires and the agent
// takes the rejected-semantics branch.
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { uuidv7 } from "@acos/domain";
import {
  ApprovalsService,
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
  companies,
  events,
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
import { startPostgres, startTemporal } from "./helpers";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../../src/workflows/index.ts");

// escalate → durable wait; approved ⇒ complete, expired ⇒ abandon
const script = (fixture: string) => `
match: { role: escalator-dev, taskFixture: ${fixture} }
steps:
  - action: update_task_status
    args: { status: IN_PROGRESS }
  - action: escalate
    args:
      reason: Vendor signup needs Founder authority
      attempted: [asked the lead, checked standing policies]
      recommendation: approve the vendor
  - action: complete_task
    args: { summary: approved-and-done }
    onSignal: { approvalVerdict: approved }
  - action: abandon
    args: { reason: approval expired — treating as rejected }
    onSignal: { approvalVerdict: expired }
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
let worker: Worker;
let workerRun: Promise<void>;
let approvalsService: ApprovalsService;

let companyId = "";
let AGENT = "";
let founderUserId = "";
let approvedTaskId = "";
let expiryTaskId = "";

beforeAll(async () => {
  [pgContainer, temporal] = await Promise.all([startPostgres(), startTemporal()]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  approvalsService = new ApprovalsService(guardedDb);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t35w.local", passwordHash: "x", displayName: "F" })
    .returning();
  founderUserId = founder!.id;
  const [company] = await db
    .insert(companies)
    .values({ name: "EscalateCo", slug: "escalateco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Ops", slug: "ops" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "escalator-dev" })
    .returning();
  AGENT = (
    await db
      .insert(agents)
      .values({
        companyId,
        employeeNumber: 1,
        name: "Esca Later",
        status: "active",
        positionId: position!.id,
        orgUnitId: unit!.id,
        seniority: "mid",
        autonomyLevel: 2,
        persona: "Escalates.",
      })
      .returning()
  )[0]!.id;

  const mkTask = async (number: number, fixture: string, deadline: Date | null) =>
    (
      await db
        .insert(tasks)
        .values({
          companyId,
          number,
          kind: "task",
          title: `Escalation ${fixture}`,
          objective: "Needs Founder authority.",
          status: "ASSIGNED",
          ownerAgentId: AGENT,
          successCriteria: ["approved"],
          deadline,
          context: { taskFixture: fixture },
        })
        .returning()
    )[0]!.id;
  approvedTaskId = await mkTask(1, "needs-approval", null);
  // deadline caps the derived expiry (19 §6) — the workflow's own timer
  // must close the approval ~4s after creation
  expiryTaskId = await mkTask(2, "expires-silently", new Date(Date.now() + 20_000));

  const [provider] = await db
    .insert(modelProviders)
    .values({ kind: "ollama", name: "scripted" })
    .returning();
  // one scripted adapter per fixture so each expands with its own taskId;
  // routed by the [taskFixture:…] marker in the working set
  const adapterA = createScriptedAdapter([loadScript(script("needs-approval"))], {
    taskId: approvedTaskId,
  });
  const adapterB = createScriptedAdapter([loadScript(script("expires-silently"))], {
    taskId: expiryTaskId,
  });
  const adapter: ProviderAdapter = {
    providerId: provider!.id,
    complete: (input) => {
      const text = input.messages.map((m) => m.content).join("\n");
      return text.includes("[taskFixture:needs-approval]")
        ? adapterA.complete(input)
        : adapterB.complete(input);
    },
    embed: (input) => adapterA.embed(input),
  };
  const router = new ModelRouter({
    providers: new Map([[provider!.id, adapter]]),
    logCall: () => {},
  });

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

async function waitFor<T>(
  probe: () => Promise<T | null | undefined>,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

describe("escalate → Approval Engine → workflow resume (T35)", () => {
  it("blocks the workflow on a pending approval until the Founder verdict, then completes", async () => {
    const sessionId = uuidv7();
    const execution = client.workflow.execute("agentTaskWorkflow", {
      taskQueue: TASK_QUEUES.agentTasks,
      workflowId: `agent-task.${approvedTaskId}.${AGENT}`,
      args: [{ companyId, agentId: AGENT, taskId: approvedTaskId, sessionId, attempt: 1 }],
    });

    // the approval row appears pending and the task parks in WAITING
    const approval = await waitFor(
      async () =>
        (
          await db
            .select()
            .from(approvals)
            .where(and(eq(approvals.companyId, companyId), eq(approvals.taskId, approvedTaskId)))
        )[0],
      "pending approval row",
    );
    expect(approval.status).toBe("pending");
    expect(approval.workflowId).toBe(`agent-task.${approvedTaskId}.${AGENT}`);
    await waitFor(async () => {
      const [t] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, approvedTaskId));
      return t!.status === "WAITING" ? t : null;
    }, "task WAITING");

    // the workflow is genuinely blocked — still RUNNING with no verdict
    const handle = client.workflow.getHandle(`agent-task.${approvedTaskId}.${AGENT}`);
    expect((await handle.describe()).status.name).toBe("RUNNING");

    // Founder verdict → DB commit first, then the signal (19 §7)
    const result = await approvalsService.verdict(ctx, approval.id, "approved", {
      userId: founderUserId,
      note: "Vendor cleared.",
    });
    expect(result.signal).toMatchObject({ verdict: "approved" });
    await handle.signal("approvalVerdict", {
      approvalId: approval.id,
      verdict: "approved",
      note: "Vendor cleared.",
    });

    const outcome = await execution;
    expect(outcome).toMatchObject({ outcome: "completed" });

    const [row] = await db.select().from(approvals).where(eq(approvals.id, approval.id));
    expect(row!.status).toBe("approved");
    const approvedEvents = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyId} AND ${events.type} = 'approval.approved'`);
    expect(approvedEvents).toHaveLength(1);
    // the wait round-trip is visible in the status trail
    const trail = await db
      .select()
      .from(events)
      .where(
        sql`${events.companyId} = ${companyId} AND ${events.type} = 'task.status.changed' AND ${events.taskId} = ${approvedTaskId}`,
      )
      .orderBy(events.seq);
    // Son ayak `complete_task`'ın kendisi: 07 §5'te bir görev DONE'a doğrudan
    // gitmez, önce REVIEW'a çıkar (repoda DONE'a yazan üç yol var: git.merge,
    // inceleme zinciri, onay motoru). Beklenti bunu içermiyordu ve bu test
    // 2026-08-15 öncesinden beri kırıktı — `test` görevi entegrasyon
    // suite'ini koşmadığı için sessizce.
    expect(
      trail.map((e) => `${(e.payload as { from: string }).from}→${(e.payload as { to: string }).to}`),
    ).toEqual([
      "ASSIGNED→IN_PROGRESS",
      "IN_PROGRESS→WAITING",
      "WAITING→IN_PROGRESS",
      "IN_PROGRESS→REVIEW",
    ]);
  }, 120_000);

  it("on silence the workflow's expiry timer closes the approval — approval.expired + rejected semantics", async () => {
    const sessionId = uuidv7();
    const execution = client.workflow.execute("agentTaskWorkflow", {
      taskQueue: TASK_QUEUES.agentTasks,
      workflowId: `agent-task.${expiryTaskId}.${AGENT}`,
      args: [{ companyId, agentId: AGENT, taskId: expiryTaskId, sessionId, attempt: 1 }],
    });

    // no verdict is ever delivered — the deadline-capped expiry (~20s) fires
    const outcome = await execution;
    expect(outcome).toMatchObject({ outcome: "abandoned" });

    const [row] = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.taskId, expiryTaskId)));
    expect(row!.status).toBe("expired");
    const expired = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyId} AND ${events.type} = 'approval.expired'`);
    expect(expired).toHaveLength(1);
  }, 120_000);
});
