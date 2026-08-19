// A5 — konteyner roll-up (07 §2).
//
// 07 §2 birebir: "`goal` and `initiative` … are containers; their status is
// derived-but-persisted — a nightly job plus **child-completion triggers**
// move a container to DONE when all children are terminal-successful, FAILED
// if any critical-path child FAILED without replacement."
//
// Tetikleyici kodda yoktu: `to === "DONE"` dalında çocuk kontrolü hiç
// yapılmıyordu. Pratik sonucu şuydu — CEO hedefi delege edip hemen
// `complete_task` diyor, hedef çocukların teslimatı beklenmeden kapanıyordu.
// Teslimat döngüsünün eksik olan "join"i tam olarak buydu.
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
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "../../src/index.js";
import {
  agents,
  companies,
  events,
  orgUnits,
  positions,
  taskAssignments,
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
let REVIEWER = "";
let counter = 0;

/** Bir iş görevini kanonik 07 §5 yolundan terminale taşır. */
async function driveToTerminal(taskId: string, target: "DONE" | "FAILED"): Promise<void> {
  await state.transition(ctx, taskId, "BACKLOG", { kind: "founder" });
  await state.transition(ctx, taskId, "PLANNED", { kind: "founder" });
  await state.assign(ctx, taskId, { agentId: OWNER }, { kind: "founder" });
  await state.transition(ctx, taskId, "IN_PROGRESS", { kind: "agent", agentId: OWNER });
  if (target === "FAILED") {
    await state.transition(ctx, taskId, "FAILED", { kind: "founder" });
    return;
  }
  await state.transition(ctx, taskId, "REVIEW", { kind: "agent", agentId: OWNER });
  await db.insert(taskAssignments).values({
    companyId,
    taskId,
    agentId: REVIEWER,
    role: "reviewer",
    reason: "test",
  });
  await state.transition(ctx, taskId, "QA", { kind: "agent", agentId: REVIEWER });
  await state.transition(ctx, taskId, "DONE", { kind: "system" });
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
    .values({ email: "founder@rollup.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "RollupCo", slug: "rollupco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  const hire = async (n: number, name: string) =>
    (
      await db
        .insert(agents)
        .values({
          companyId,
          employeeNumber: n,
          name,
          status: "active",
          positionId: position!.id,
          orgUnitId: unit!.id,
          seniority: "mid",
          autonomyLevel: 2,
          persona: "x",
        })
        .returning()
    )[0]!.id;
  OWNER = await hire(1, "Deniz Dev");
  REVIEWER = await hire(2, "Rana Reviewer");
}, 600_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

/** goal → initiative → epic → task zinciri (07 §2 kind merdiveni). */
async function makeTree(children: number) {
  counter += 1;
  const goal = await service.create(
    ctx,
    { kind: "goal", title: `Hedef ${counter}`, objective: "x" },
    { kind: "founder" },
  );
  const initiative = await service.create(
    ctx,
    { kind: "initiative", parentId: goal.id, title: `Girişim ${counter}`, objective: "x" },
    { kind: "founder" },
  );
  const epic = await service.create(
    ctx,
    { kind: "epic", parentId: initiative.id, title: `Epik ${counter}`, objective: "x" },
    { kind: "founder" },
  );
  const leaves = [];
  for (let i = 0; i < children; i += 1) {
    leaves.push(
      await service.create(
        ctx,
        { kind: "task", parentId: epic.id, title: `İş ${counter}-${i}`, objective: "x" },
        { kind: "founder" },
      ),
    );
  }
  return { goal, initiative, epic, leaves };
}

describe("konteyner roll-up (07 §2)", { timeout: 60_000 }, () => {
  it("iki çocuklu girişim: biri bitince açık kalır, ikincisi bitince kendisi kapanır", async () => {
    const { goal, initiative, epic, leaves } = await makeTree(2);
    // epic bir konteyner DEĞİL — kendi makinesini yürür; girişim ondan türer
    await driveToTerminal(leaves[0]!.id, "DONE");
    expect(await statusOf(epic.id)).not.toBe("DONE"); // ikinci çocuk sürüyor
    expect(await statusOf(initiative.id)).not.toBe("DONE");

    await driveToTerminal(leaves[1]!.id, "DONE");
    // epic'in çocukları bitti ama epic konteyner değil: kendi yolunu yürümeli
    await driveToTerminal(epic.id, "DONE");

    // …ve epic terminal olur olmaz girişim, ardından hedef türetilir
    expect(await statusOf(initiative.id)).toBe("DONE");
    expect(await statusOf(goal.id)).toBe("DONE");

    // task.completed olayı konteyner için de düşüyor (hafıza tetikleyicisi buna bakıyor)
    const completed = await db
      .select()
      .from(events)
      .where(
        and(
          eq(events.companyId, companyId),
          eq(events.type, "task.completed"),
          eq(events.taskId, goal.id),
        ),
      );
    expect(completed).toHaveLength(1);
  });

  it("ikamesiz FAILED çocuk konteyneri FAILED yapar", async () => {
    const { initiative, epic, leaves } = await makeTree(1);
    await driveToTerminal(leaves[0]!.id, "FAILED");
    await driveToTerminal(epic.id, "FAILED");
    expect(await statusOf(initiative.id)).toBe("FAILED");
  });

  it("konteyner elle DONE yapılamaz — çocuklarından türer", async () => {
    const { initiative } = await makeTree(1);
    await state.transition(ctx, initiative.id, "BACKLOG", { kind: "founder" });
    await state.transition(ctx, initiative.id, "PLANNED", { kind: "founder" });
    await state.assign(ctx, initiative.id, { agentId: OWNER }, { kind: "founder" });
    await state.transition(ctx, initiative.id, "IN_PROGRESS", { kind: "agent", agentId: OWNER });
    await state.transition(ctx, initiative.id, "REVIEW", { kind: "agent", agentId: OWNER });
    await db.insert(taskAssignments).values({
      companyId,
      taskId: initiative.id,
      agentId: REVIEWER,
      role: "reviewer",
      reason: "test",
    });
    await state.transition(ctx, initiative.id, "QA", { kind: "agent", agentId: REVIEWER });
    // CEO'nun "delege ettim, bitti" hamlesi — artık motor reddediyor
    await expect(
      state.transition(ctx, initiative.id, "DONE", { kind: "system" }),
    ).rejects.toThrow(/container/i);
  });

  it("çocuğu olmayan konteyner kendiliğinden kapanmaz", async () => {
    const { initiative, epic } = await makeTree(0);
    await driveToTerminal(epic.id, "DONE");
    // epic'in çocuğu yoktu ama kendisi bir iş kalemi; girişim ondan türedi
    expect(await statusOf(initiative.id)).toBe("DONE");
  });
});
