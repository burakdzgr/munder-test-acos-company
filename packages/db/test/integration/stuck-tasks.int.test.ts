// A6 — stuck-task sweep (09 §9, 07 §8).
//
// 09 §9 Schedules tablosu bu sweep'i adıyla listeliyor: `stuck-task-sweep`,
// 30 dakikada bir, "detects ASSIGNED-too-long / WAITING-past-SLA tasks →
// manager notifications". Kodda yoktu.
//
// Pratik sonucu: iş yalnız üç yoldan ilerliyordu (HTTP route, delegate_task,
// intake). Bir görev WAITING'e park edilirse onu geri alan hiçbir mekanizma
// yoktu; sahibinin workflow'u öldüyse görev sonsuza kadar orada kalıyor ve
// bunu gösteren tek bir işaret bile üretilmiyordu.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import {
  TasksService,
  TaskStateService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  sweepStuckTasks,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "../../src/index.js";
import {
  agentSessions,
  agents,
  companies,
  events,
  orgEdges,
  orgUnits,
  positions,
  tasks,
  users,
} from "../../src/schema/index.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let service: TasksService;
let state: TaskStateService;
let companyId = "";
let OWNER = "";
let MANAGER = "";
let counter = 0;

/** Bir görevi ASSIGNED'a taşır. */
async function assignedTask(title: string) {
  counter += 1;
  const task = await service.create(
    ctx,
    { kind: "task", title: `${title} ${counter}`, objective: "x" },
    { kind: "founder" },
  );
  await state.transition(ctx, task.id, "BACKLOG", { kind: "founder" });
  await state.transition(ctx, task.id, "PLANNED", { kind: "founder" });
  await state.assign(ctx, task.id, { agentId: OWNER }, { kind: "founder" });
  return task;
}

const statusOf = async (taskId: string) =>
  (
    await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)))
  )[0]!.status;

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  service = new TasksService(guardedDb);
  state = new TaskStateService(guardedDb);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@stuck.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "StuckCo", slug: "stuckco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  const [devPos] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  const [mgrPos] = await db
    .insert(positions)
    .values({ companyId, title: "EM", seniorityTrack: ["lead"], defaultRole: "manager" })
    .returning();
  const hire = async (n: number, name: string, positionId: string) =>
    (
      await db
        .insert(agents)
        .values({
          companyId,
          employeeNumber: n,
          name,
          status: "active",
          positionId,
          orgUnitId: unit!.id,
          seniority: "mid",
          autonomyLevel: 2,
          persona: "x",
        })
        .returning()
    )[0]!.id;
  OWNER = await hire(1, "Deniz Dev", devPos!.id);
  MANAGER = await hire(2, "Kerem Manager", mgrPos!.id);
  await db
    .insert(orgEdges)
    .values({ companyId, fromAgentId: OWNER, kind: "reports_to", toAgentId: MANAGER });
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("stuck-task sweep (09 §9, 07 §8)", { timeout: 60_000 }, () => {
  it("wait_for süresi dolan WAITING görevi BLOCKED'a alır ve eskalasyon üretir", async () => {
    const task = await assignedTask("Yardım bekleyen iş");
    await state.transition(ctx, task.id, "IN_PROGRESS", { kind: "agent", agentId: OWNER });
    await state.transition(ctx, task.id, "WAITING", { kind: "agent", agentId: OWNER });

    // henüz süre dolmadı — sweep dokunmamalı
    const early = await sweepStuckTasks(db, guardedDb);
    expect(early.findings.filter((f) => f.taskId === task.id)).toHaveLength(0);
    expect(await statusOf(task.id)).toBe("WAITING");

    // 07 §8: wait_for (varsayılan 2 saat) dolduğunda
    const later = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    const finding = result.findings.find((f) => f.taskId === task.id);
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe("waiting_past_sla");
    expect(finding!.managerAgentId).toBe(MANAGER); // reports_to bir üst
    expect(await statusOf(task.id)).toBe("BLOCKED");

    // eskalasyon olayı düştü — Founder'ın bildirim yüzeyi bunu dinliyor
    const escalations = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.companyId, companyId),
          eq(events.type, "agent.escalated"),
          eq(events.taskId, task.id),
        ),
      );
    expect(escalations).toHaveLength(1);
  });

  it("uzun süredir ASSIGNED duran görevi bildirir ve ölü döngüyü işaretler", async () => {
    const task = await assignedTask("Başlamayan iş");
    const later = new Date(Date.now() + 60 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    const finding = result.findings.find((f) => f.taskId === task.id);
    expect(finding).toBeDefined();
    expect(finding!.kind).toBe("assigned_too_long");
    // canlı oturumu yok → çağıran workflow'u yeniden başlatmalı
    expect(finding!.needsWorkflowRestart).toBe(true);
    // ASSIGNED bir durum değişimi DEĞİL: görev yerinde kalır, yalnız bildirilir
    expect(await statusOf(task.id)).toBe("ASSIGNED");
  });

  it("canlı oturumu olan görev için yeniden başlatma istenmez", async () => {
    const task = await assignedTask("Çalışan iş");
    await db.insert(agentSessions).values({
      companyId,
      agentId: OWNER,
      taskId: task.id,
      workflowId: `agent-task.${task.id}.${OWNER}`,
      runId: "01a0052e-0000-7000-8000-000000000099",
      status: "running",
    });
    const later = new Date(Date.now() + 60 * 60 * 1000);
    const result = await sweepStuckTasks(db, guardedDb, { now: later });
    const finding = result.findings.find((f) => f.taskId === task.id);
    expect(finding).toBeDefined();
    expect(finding!.needsWorkflowRestart).toBe(false);
  });
});
