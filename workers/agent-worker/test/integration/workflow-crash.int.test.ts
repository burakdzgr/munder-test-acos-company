// 33 §2.2 failure handler — workflow crash is a control-plane event, not a
// silent death. Golden-path probe evidence (2026-08-19): a CEO whose loop
// died on a terminal LLM error left its GOAL task ASSIGNED forever — no
// FAILED/BLOCKED transition, no notification anywhere; the company sat dead.
//
// Two layers under test:
//   1. workflow: an unhandled activity error triggers ONE
//      reportWorkflowCrashActivity call (with the real cause, not Temporal's
//      generic "Activity task failed"), the session still closes as `failed`,
//      and the workflow itself still fails.
//   2. activity: task lands in BLOCKED through the single writer, the manager
//      gets agent.escalated + an idle-manager P1 wake task; a root agent
//      (no reports_to) escalates to the Founder as a notification row.
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { ApplicationFailure } from "@temporalio/common";
import { uuidv7 } from "@acos/domain";
import { TASK_QUEUES } from "@acos/config";
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
  agents,
  companies,
  companyMembers,
  events,
  notifications,
  orgEdges,
  orgUnits,
  positions,
  projects,
  tasks,
  users,
} from "@acos/db/schema";
import type { ModelRouter } from "@acos/llm";
import { createAgentTaskActivities } from "../../src/activities/agent-task.js";
import { startPostgres } from "./helpers";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../../src/workflows/index.ts");

// ---------------------------------------------------------------------------
// 1) workflow layer — TestWorkflowEnvironment + stub activities
// ---------------------------------------------------------------------------

const COMPANY = "018f0000-0000-7000-8000-00000000cra5";
const AGENT = "018f0000-0000-7000-8000-0000000000a1";
const TASK = "018f0000-0000-7000-8000-0000000000b1";

function makeCrashingStub() {
  const calls = {
    crashReports: [] as Array<{ taskId: string; reason: string }>,
    sessionClosed: [] as string[],
  };
  const activities = {
    // E4/T31: the workflow asks the runtime first (patched "t31-cli-runtime");
    // this stub models the full Worker surface, so it answers "steps" like the
    // base set does — otherwise "not registered" masks the crash under test.
    async resolveAgentRuntimeActivity() {
      return { kind: "steps" as const, reason: "stub" };
    },
    async startAgentSessionActivity() {},
    async getGuardSnapshotActivity() {
      return {
        budgetCents: null,
        spentCents: 0,
        remainingCents: null,
        estimatedNextStepCents: 0,
        deadline: null,
      };
    },
    async buildWorkingSetActivity() {
      return { messages: [{ role: "user", content: "step" }], digest: "d" };
    },
    async callModelActivity(): Promise<never> {
      // terminal LLM hatası (probe kanıtındaki ScriptLoadError sınıfı)
      throw ApplicationFailure.nonRetryable(
        "ScriptLoadError: no script matches role=executive",
        "LlmError",
      );
    },
    async persistStepActivity() {
      return { inserted: true };
    },
    async executeActionActivity() {
      return { ok: true };
    },
    async resumeFromWaitActivity() {},
    async guardEscalateActivity() {},
    async triageInboxActivity() {
      return { verdict: "ignore" as const };
    },
    async markInboxReadActivity() {},
    async reportWorkflowCrashActivity(input: { taskId: string; reason: string }) {
      calls.crashReports.push({ taskId: input.taskId, reason: input.reason });
    },
    async closeAgentSessionActivity(input: { status: string }) {
      calls.sessionClosed.push(input.status);
    },
  };
  return { activities, calls };
}

describe("agentTaskWorkflow crash path (33 §2.2)", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 300_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it("unhandled activity error → one crash report with the real cause, session failed, workflow fails", async () => {
    const stub = makeCrashingStub();
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUES.agentTasks,
      workflowsPath,
      activities: stub.activities as never,
    });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("agentTaskWorkflow", {
        taskQueue: TASK_QUEUES.agentTasks,
        workflowId: `crash-${uuidv7()}`,
        args: [
          { companyId: COMPANY, agentId: AGENT, taskId: TASK, sessionId: uuidv7(), attempt: 1 },
        ],
      });
      await expect(handle.result()).rejects.toThrow();
    });

    expect(stub.calls.crashReports).toHaveLength(1);
    expect(stub.calls.crashReports[0]!.taskId).toBe(TASK);
    // Temporal'ın jenerik "Activity task failed" mesajı değil, cause zinciri
    expect(stub.calls.crashReports[0]!.reason).toContain("ScriptLoadError");
    // finally hâlâ koşuyor: oturum failed olarak kapanır (mevcut davranış korunur)
    expect(stub.calls.sessionClosed).toEqual(["failed"]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 2) activity layer — real Postgres, real single-writer transitions
// ---------------------------------------------------------------------------

describe("reportWorkflowCrashActivity (33 §2.2, DB)", { timeout: 300_000 }, () => {
  let pgContainer: Awaited<ReturnType<typeof startPostgres>>;
  let pool: Pool;
  let db: Db;
  let guardedDb: GuardedDb;
  let ctx: CompanyContext;
  let activities: ReturnType<typeof createAgentTaskActivities>;
  const started: Array<{ agentId: string; taskId: string }> = [];

  let companyId = "";
  let founderUserId = "";
  let MANAGER = "";
  let WORKER_AGENT = "";
  let workerTaskId = "";
  let projectId = "";
  let managerTaskId = "";
  const workerSessionId = uuidv7();
  const managerSessionId = uuidv7();

  beforeAll(async () => {
    pgContainer = await startPostgres();
    await runMigrations(pgContainer.getConnectionUri());
    pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
    pool.on("error", () => {});
    db = createDb(pool);
    guardedDb = createGuardedDb(pool);

    const [founder] = await db
      .insert(users)
      .values({ email: "founder@crash.local", passwordHash: "x", displayName: "F" })
      .returning();
    founderUserId = founder!.id;
    const [company] = await db
      .insert(companies)
      .values({ name: "CrashCo", slug: "crashco", createdByUserId: founderUserId })
      .returning();
    companyId = company!.id;
    ctx = companyContext(companyId);
    await db
      .insert(companyMembers)
      .values({ companyId, userId: founderUserId, role: "founder" });
    const [unit] = await db
      .insert(orgUnits)
      .values({ companyId, kind: "department", name: "Eng", slug: "eng" })
      .returning();
    const [position] = await db
      .insert(positions)
      .values({ companyId, title: "Engineer", seniorityTrack: ["mid"], defaultRole: "backend-dev" })
      .returning();
    const mkAgent = async (n: number, name: string) => {
      const [agent] = await db
        .insert(agents)
        .values({
          companyId,
          employeeNumber: n,
          name,
          status: "active",
          positionId: position!.id,
          orgUnitId: unit!.id,
          seniority: "mid",
          autonomyLevel: 3,
          persona: name,
        })
        .returning();
      return agent!.id;
    };
    MANAGER = await mkAgent(1, "Mia Manager");
    WORKER_AGENT = await mkAgent(2, "Wes Worker");
    await db.insert(orgEdges).values({
      companyId,
      kind: "reports_to",
      fromAgentId: WORKER_AGENT,
      toAgentId: MANAGER,
    });

    // Coken gorev bir PROJEYE ait olmali: uyandirma gorevinin projeyi kalitip
    // kalitmadigi ancak boyle olculebilir (projesiz fixture'da iddia bos olurdu).
    const [project] = await db
      .insert(projects)
      .values({ companyId, slug: "crash-proj", name: "Crash Project", objectiveMd: "crash fixture", createdByUserId: founderUserId })
      .returning();
    projectId = project!.id;

    const mkTask = async (n: number, owner: string) => {
      const [task] = await db
        .insert(tasks)
        .values({
          companyId,
          number: n,
          kind: "task",
          title: `T${n}`,
          objective: "o",
          status: "ASSIGNED",
          ownerAgentId: owner,
          projectId,
        })
        .returning();
      return task!.id;
    };
    // yüksek numaralar: TasksService.create kendi sayacından (task_number
    // sequence, 1'den) numara üretir — raw seed onunla çakışmamalı
    workerTaskId = await mkTask(901, WORKER_AGENT);
    managerTaskId = await mkTask(902, MANAGER);

    activities = createAgentTaskActivities({
      guardedDb,
      router: null as unknown as ModelRouter, // crash path never calls the LLM
      routingFor: async () => ({ bindings: [], profiles: [] }),
      startAgentWorkflow: async (input) => {
        started.push({ agentId: input.agentId, taskId: input.taskId });
      },
    });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await pgContainer?.stop();
  });

  it("ASSIGNED task → BLOCKED; manager escalated + woken with a P1 task", async () => {
    await activities.reportWorkflowCrashActivity({
      companyId,
      agentId: WORKER_AGENT,
      taskId: workerTaskId,
      sessionId: workerSessionId,
      reason: "LlmError: provider gone",
    });

    const [task] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, workerTaskId)));
    expect(task!.status).toBe("BLOCKED");

    const escalations = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyId} AND ${events.type} = 'agent.escalated'`);
    const mine = escalations
      .map((e) => e.payload as { toAgentId?: string; reason?: string })
      .filter((p) => p.reason?.includes("provider gone"));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.toAgentId).toBe(MANAGER);

    // boştaki yönetici P1 müdahale göreviyle uyandırıldı
    const [helpTask] = await db
      .select({
        id: tasks.id,
        status: tasks.status,
        priority: tasks.priority,
        projectId: tasks.projectId,
        parentId: tasks.parentId,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.ownerAgentId, MANAGER), eq(tasks.priority, "P1")));
    expect(helpTask).toBeDefined();
    expect(helpTask!.status).toBe("ASSIGNED");
    // Uyandirma gorevi PARENT'SIZ kalir — is kirilimninin cocugu degil (07 §2
    // tur merdiveni), ebeveynlemek rollup'lari bozardi...
    expect(helpTask!.parentId).toBeNull();
    // ...ama PROJESIZ de kalmaz: coken gorevin projesini kalitir, yoksa
    // WorkspaceService.provision (workspaces.project_id NOT NULL) yoneticiye
    // workspace acamaz ve harcama proje rollup'ina islenmez.
    expect(helpTask!.projectId).toBe(projectId);
    expect(started).toContainEqual({ agentId: MANAGER, taskId: helpTask!.id });

    // idempotent: aynı oturum için ikinci çağrı patlamaz ve kopya üretmez
    await activities.reportWorkflowCrashActivity({
      companyId,
      agentId: WORKER_AGENT,
      taskId: workerTaskId,
      sessionId: workerSessionId,
      reason: "LlmError: provider gone",
    });
    const p1s = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.ownerAgentId, MANAGER), eq(tasks.priority, "P1")));
    expect(p1s).toHaveLength(1);
  });

  it("root agent (no reports_to) → BLOCKED + Founder notification", async () => {
    await activities.reportWorkflowCrashActivity({
      companyId,
      agentId: MANAGER,
      taskId: managerTaskId,
      sessionId: managerSessionId,
      reason: "ScriptLoadError: no script matches role=executive",
    });

    const [task] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, managerTaskId)));
    expect(task!.status).toBe("BLOCKED");

    const rows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.companyId, companyId), eq(notifications.userId, founderUserId)));
    const crash = rows.filter((r) => r.kind === "agent_crash");
    expect(crash).toHaveLength(1);
    expect(crash[0]!.bodyMd).toContain("ScriptLoadError");
  });
});
