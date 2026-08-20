// A7 canlı koşumu (2026-08-19) iki kusuru aynı anda gösterdi ve ikisi de
// GOAL görevinin BLOCKED'a park etmesiyle sonuçlandı:
//
//   1. Oturum açılırken görev ASSIGNED→IN_PROGRESS'e HİÇ taşınmıyordu. CEO on
//      bir adım çalışırken görev ASSIGNED kaldı; `status === "IN_PROGRESS"`
//      koşuluna bağlı olan wait_for/onay/guard parklarının hepsi sessizce
//      no-op oldu.
//   2. update_task_status, TaskEngineError'ı YENİDEN FIRLATIYORDU. Model
//      ASSIGNED'ken WAITING istedi (makinede olmayan kenar) → aktivite düştü
//      → iş akışı çöktü → crash handler hedef görevi BLOCKED'a parkladı.
//
// Sözleşme: (1) sahibinin oturumu görevi IN_PROGRESS'e alır, (2) yanlış durum
// seçimi yapılandırılmış GÖZLEM döner, döngüyü öldürmez.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
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
  orgUnits,
  positions,
  tasks,
  users,
} from "@acos/db/schema";
import type { ModelRouter } from "@acos/llm";
import { createAgentTaskActivities } from "../../src/activities/agent-task.js";
import { startPostgres } from "./helpers";

describe("agent loop status contract (07 §5)", () => {
  let pgContainer: Awaited<ReturnType<typeof startPostgres>> | undefined;
  let pool: Pool | undefined;
  let db: Db;
  let guardedDb: GuardedDb;
  let ctx: CompanyContext;
  let companyId: string;
  let OWNER: string;
  let OTHER: string;
  let ownedTaskId: string;
  let foreignTaskId: string;
  let activities: ReturnType<typeof createAgentTaskActivities>;

  beforeAll(async () => {
    pgContainer = await startPostgres();
    await runMigrations(pgContainer.getConnectionUri());
    pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
    pool.on("error", () => {});
    db = createDb(pool);
    guardedDb = createGuardedDb(pool);

    const [founder] = await db
      .insert(users)
      .values({ email: "founder@loop.local", passwordHash: "x", displayName: "F" })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: "LoopCo", slug: "loopco", createdByUserId: founder!.id })
      .returning();
    companyId = company!.id;
    ctx = companyContext(companyId);
    await db
      .insert(companyMembers)
      .values({ companyId, userId: founder!.id, role: "founder" });
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
    OWNER = await mkAgent(1, "Olive Owner");
    OTHER = await mkAgent(2, "Otto Other");

    // yüksek numaralar: TasksService kendi sayacından üretir, raw seed
    // onunla çakışmamalı
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
        })
        .returning();
      return task!.id;
    };
    ownedTaskId = await mkTask(911, OWNER);
    foreignTaskId = await mkTask(912, OWNER);

    activities = createAgentTaskActivities({
      guardedDb,
      router: null as unknown as ModelRouter, // bu yollar LLM'e hiç uğramaz
      routingFor: async () => ({ bindings: [], profiles: [] }),
    });
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    await pgContainer?.stop();
  }, 120_000);

  const statusOf = async (id: string) => {
    const [row] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, id)));
    return row?.status;
  };

  it("oturum açılışı sahibinin ASSIGNED görevini IN_PROGRESS'e alır", async () => {
    const sessionId = crypto.randomUUID();
    await activities.startAgentSessionActivity({
      companyId,
      agentId: OWNER,
      taskId: ownedTaskId,
      sessionId,
      workflowId: `wf-${sessionId}`,
      runId: `run-${sessionId}`,
      attempt: 1,
    });
    expect(await statusOf(ownedTaskId)).toBe("IN_PROGRESS");
  });

  it("sahibi OLMAYAN ajanın oturumu görevi çekip almaz", async () => {
    const sessionId = crypto.randomUUID();
    await activities.startAgentSessionActivity({
      companyId,
      agentId: OTHER, // inceleme/QA oturumu: sahiplik değişmez
      taskId: foreignTaskId,
      sessionId,
      workflowId: `wf-${sessionId}`,
      runId: `run-${sessionId}`,
      attempt: 1,
    });
    expect(await statusOf(foreignTaskId)).toBe("ASSIGNED");
  });

  it("makine dışı durum seçimi GÖZLEM döner, aktiviteyi düşürmez", async () => {
    // canlı koşumdaki tam senaryo: ASSIGNED → WAITING kenarı yok
    const result = await activities.executeActionActivity({
      companyId,
      agentId: OWNER,
      taskId: foreignTaskId,
      sessionId: crypto.randomUUID(),
      stepId: crypto.randomUUID(),
      action: { type: "update_task_status", taskId: foreignTaskId, to: "WAITING" },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("TASK_TRANSITION_INVALID");
    expect(String(result.detail)).toContain("ASSIGNED");
    expect(result.currentStatus).toBe("ASSIGNED");
    // görev olduğu yerde kalır — tek yazar sözleşmesi (INV-13) bozulmadı
    expect(await statusOf(foreignTaskId)).toBe("ASSIGNED");
  });

  it("aynı hedefe ikinci çağrı hâlâ idempotent başarı (R1 replay)", async () => {
    const result = await activities.executeActionActivity({
      companyId,
      agentId: OWNER,
      taskId: ownedTaskId,
      sessionId: crypto.randomUUID(),
      stepId: crypto.randomUUID(),
      action: { type: "update_task_status", taskId: ownedTaskId, to: "IN_PROGRESS" },
    });
    expect(result.ok).toBe(true);
    expect(result.replayed).toBe(true);
  });
});
