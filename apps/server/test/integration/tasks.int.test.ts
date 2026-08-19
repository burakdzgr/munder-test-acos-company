// T27 acceptance: transition-permission suite (owner / reviewer / manager /
// founder / system); forbidden transitions 409 at the API; DAG cycle check;
// per-company numbers; reassignment limit; DONE resolves dependents.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sql } from "drizzle-orm";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import { events } from "@acos/db/schema";
import { buildApp, type App } from "../../src/app.js";
import {
  TaskEngineError,
  TasksService,
  TaskStateService,
} from "../../src/modules/tasks/service.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const MASTER_KEY = Buffer.alloc(32, 13).toString("base64");
const ok = async () => {};

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let app: App;
let ctx: CompanyContext;
let tasksSvc: TasksService;
let stateSvc: TaskStateService;
let sessionCookie = "";
let csrfToken = "";
let companyId = "";
// org cast: owner OWEN reports to manager MIRA; RITA holds the reviewer
// position; PETE is an unrelated member (no privileges on OWEN's tasks)
let OWEN = "";
let MIRA = "";
let RITA = "";
let PETE = "";

const authHeaders = () => ({
  cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
  "x-csrf-token": csrfToken,
});

async function api(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    headers: authHeaders(),
    ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
  });
}

async function expectOk(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) {
  const response = await api(method, url, payload);
  expect(response.statusCode, `${method} ${url} → ${response.body}`).toBeLessThan(300);
  return response.json();
}

const agent = (agentId: string) => ({ kind: "agent" as const, agentId });

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  tasksSvc = new TasksService(guardedDb);
  stateSvc = new TaskStateService(guardedDb);
  app = await buildApp({
    healthCheckers: { postgres: ok, nats: ok, temporal: ok },
    logger: false,
    db,
    guardedDb,
    masterKey: MASTER_KEY,
  });
  await app.ready();

  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { email: "founder@t27.local", password: "correct-horse-battery", displayName: "F" },
  });
  for (const c of setup.cookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }
  const company = await expectOk("POST", "/api/v1/companies", {
    name: "TaskCo",
    slug: "taskco",
    currency: "USD",
  });
  companyId = company.id;
  ctx = companyContext(companyId);
  const base = `/api/v1/companies/${companyId}`;

  const dept = await expectOk("POST", `${base}/org/units`, {
    name: "Engineering",
    slug: "eng",
    kind: "department",
  });
  const managerPos = await expectOk("POST", `${base}/org/positions`, {
    title: "Engineering Manager",
    seniorityTrack: ["lead"],
    defaultRole: "manager",
  });
  const devPos = await expectOk("POST", `${base}/org/positions`, {
    title: "Backend Engineer",
    seniorityTrack: ["mid"],
    defaultRole: "member",
  });
  const reviewerPos = await expectOk("POST", `${base}/org/positions`, {
    title: "QA/Reviewer",
    seniorityTrack: ["senior"],
    defaultRole: "reviewer",
  });

  const hire = async (name: string, positionId: string, managerAgentId?: string) =>
    (
      await expectOk("POST", `${base}/agents`, {
        name,
        positionId,
        orgUnitId: dept.id,
        seniority: "mid",
        autonomyLevel: 2,
        persona: `${name}.`,
        ...(managerAgentId && { managerAgentId }),
        activate: true,
      })
    ).id as string;

  MIRA = await hire("Mira Manager", managerPos.id);
  OWEN = await hire("Owen Owner", devPos.id, MIRA);
  RITA = await hire("Rita Reviewer", reviewerPos.id, MIRA);
  PETE = await hire("Pete Peer", devPos.id, MIRA);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("hierarchy + numbering (07 §1–2)", () => {
  it("allocates gap-free per-company numbers and enforces the kind ladder", async () => {
    const base = `/api/v1/companies/${companyId}/tasks`;
    const goal = await expectOk("POST", base, {
      kind: "goal",
      title: "Ship feature X",
      objective: "Feature X live in prod.",
    });
    expect(goal.number).toBe(1);
    expect(goal.displayNumber).toBe("TASK-1");
    expect(goal.status).toBe("DRAFT");
    expect(goal.delegationDepth).toBe(0);

    const initiative = await expectOk("POST", base, {
      kind: "initiative",
      parentId: goal.id,
      title: "Backend workstream",
      objective: "APIs done.",
    });
    expect(initiative.number).toBe(2);
    expect(initiative.delegationDepth).toBe(1);

    // level skip: an epic directly under a goal is refused
    const skip = await api("POST", base, {
      kind: "epic",
      parentId: goal.id,
      title: "Bad epic",
      objective: "x",
    });
    expect(skip.statusCode).toBe(400);

    // an initiative cannot be parentless
    const orphan = await api("POST", base, {
      kind: "initiative",
      title: "Orphan",
      objective: "x",
    });
    expect(orphan.statusCode).toBe(400);

    // ad-hoc parentless task IS allowed (07 §2)
    const adHoc = await expectOk("POST", base, {
      kind: "task",
      title: "Ad-hoc maintenance",
      objective: "Fix the thing.",
    });
    expect(adHoc.delegationDepth).toBe(0);
    expect(adHoc.number).toBe(3);
  });
});

describe("transition permissions (07 §5) — the acceptance matrix", () => {
  let taskId = "";

  it("founder grooms DRAFT→BACKLOG→PLANNED; non-manager peers cannot assign", async () => {
    const base = `/api/v1/companies/${companyId}/tasks`;
    const task = await expectOk("POST", base, {
      kind: "task",
      title: "Implement login",
      objective: "Login works.",
    });
    taskId = task.id;
    await expectOk("POST", `${base}/${taskId}/transitions`, { to: "BACKLOG" });
    await expectOk("POST", `${base}/${taskId}/transitions`, { to: "PLANNED" });

    // PETE (plain member) may not assign a planned task
    await expect(
      stateSvc.assign(ctx, taskId, { agentId: OWEN }, agent(PETE)),
    ).rejects.toMatchObject({ code: "TASK_TRANSITION_INVALID" });
  });

  it("manager assigns (PLANNED→ASSIGNED); owner starts and submits for review", async () => {
    const task = await stateSvc.assign(ctx, taskId, { agentId: OWEN }, agent(MIRA));
    expect(task.status).toBe("ASSIGNED");
    expect(task.ownerAgentId).toBe(OWEN);

    // only the owner (or system) starts — the manager may not
    await expect(
      stateSvc.transition(ctx, taskId, "IN_PROGRESS", agent(MIRA)),
    ).rejects.toMatchObject({ code: "TASK_TRANSITION_INVALID" });
    await stateSvc.transition(ctx, taskId, "IN_PROGRESS", agent(OWEN));

    // IN_PROGRESS→REVIEW is owner-only: reviewer and manager are refused
    await expect(
      stateSvc.transition(ctx, taskId, "REVIEW", agent(RITA)),
    ).rejects.toMatchObject({ code: "TASK_TRANSITION_INVALID" });
    await expect(
      stateSvc.transition(ctx, taskId, "REVIEW", agent(MIRA)),
    ).rejects.toMatchObject({ code: "TASK_TRANSITION_INVALID" });
    await stateSvc.transition(ctx, taskId, "REVIEW", agent(OWEN));
  });

  it("no developer approves their own work: owner refused, reviewer accepted", async () => {
    // the owner may NOT review their own submission
    await expect(
      stateSvc.transition(ctx, taskId, "QA", agent(OWEN)),
    ).rejects.toMatchObject({ code: "TASK_TRANSITION_INVALID" });
    // a plain peer without reviewer capability is refused
    await expect(
      stateSvc.transition(ctx, taskId, "QA", agent(PETE)),
    ).rejects.toMatchObject({ code: "TASK_TRANSITION_INVALID" });
    // the founder is not a reviewer either — 409 at the API (demo step 12)
    const founderTry = await api(
      "POST",
      `/api/v1/companies/${companyId}/tasks/${taskId}/transitions`,
      { to: "QA" },
    );
    expect(founderTry.statusCode).toBe(409);
    expect(founderTry.json().code).toBe("task_transition_invalid");

    // reviewer requests changes, owner reworks, reviewer then accepts to QA
    await stateSvc.transition(ctx, taskId, "CHANGES_REQUESTED", agent(RITA));
    await stateSvc.transition(ctx, taskId, "IN_PROGRESS", agent(OWEN));
    await stateSvc.transition(ctx, taskId, "REVIEW", agent(OWEN));
    await stateSvc.transition(ctx, taskId, "QA", agent(RITA));

    // QA verdict must also come from a non-owner with qa capability
    await expect(
      stateSvc.transition(ctx, taskId, "DONE", agent(OWEN)),
    ).rejects.toMatchObject({ code: "TASK_TRANSITION_INVALID" });
    const done = await stateSvc.transition(ctx, taskId, "DONE", agent(RITA));
    expect(done.status).toBe("DONE");
    expect(done.closedAt).not.toBeNull();
  });

  it("illegal machine transitions are refused with 409 regardless of role", async () => {
    const reopen = await api(
      "POST",
      `/api/v1/companies/${companyId}/tasks/${taskId}/transitions`,
      { to: "IN_PROGRESS" },
    );
    expect(reopen.statusCode).toBe(409);
  });

  it("only manager-or-above cancels; APPROVAL verdicts stay with the engine", async () => {
    const base = `/api/v1/companies/${companyId}/tasks`;
    const task = await expectOk("POST", base, {
      kind: "task",
      title: "Cancelable",
      objective: "x",
    });
    // owner-less DRAFT task: a plain member cannot cancel
    await expect(
      stateSvc.transition(ctx, task.id, "CANCELLED", agent(PETE)),
    ).rejects.toMatchObject({ code: "TASK_TRANSITION_INVALID" });
    const cancelled = await stateSvc.transition(ctx, task.id, "CANCELLED", agent(MIRA));
    expect(cancelled.status).toBe("CANCELLED");

    // APPROVAL→DONE is approval-engine-only — even the founder is refused
    const approvalTask = await expectOk("POST", base, {
      kind: "task",
      title: "Approval-bound",
      objective: "x",
    });
    await db.execute(
      sql`UPDATE tasks SET status = 'APPROVAL' WHERE id = ${approvalTask.id} AND company_id = ${companyId}`,
    );
    const founderApprove = await api(
      "POST",
      `${base}/${approvalTask.id}/transitions`,
      { to: "DONE" },
    );
    expect(founderApprove.statusCode).toBe(409);
  });

  it("emits the full task.status.changed trail with byActor", async () => {
    const rows = await db
      .select()
      .from(events)
      .where(
        sql`${events.companyId} = ${companyId} AND ${events.type} = 'task.status.changed' AND ${events.taskId} = ${taskId}`,
      )
      .orderBy(events.seq);
    const trail = rows.map((r) => {
      const p = r.payload as { from: string; to: string; byActor: { kind: string } };
      return `${p.from}→${p.to}:${p.byActor.kind}`;
    });
    expect(trail).toEqual([
      "DRAFT→BACKLOG:founder",
      "BACKLOG→PLANNED:founder",
      "PLANNED→ASSIGNED:agent",
      "ASSIGNED→IN_PROGRESS:agent",
      "IN_PROGRESS→REVIEW:agent",
      "REVIEW→CHANGES_REQUESTED:agent",
      "CHANGES_REQUESTED→IN_PROGRESS:agent",
      "IN_PROGRESS→REVIEW:agent",
      "REVIEW→QA:agent",
      "QA→DONE:agent",
    ]);
  });
});

describe("dependency DAG (07 §3)", () => {
  it("rejects cycles with 409 and resolves dependents on DONE", async () => {
    const base = `/api/v1/companies/${companyId}/tasks`;
    const a = await expectOk("POST", base, { kind: "task", title: "A", objective: "a" });
    const b = await expectOk("POST", base, { kind: "task", title: "B", objective: "b" });
    const c = await expectOk("POST", base, { kind: "task", title: "C", objective: "c" });

    await expectOk("POST", `${base}/${b.id}/dependencies`, { dependsOnTaskId: a.id });
    await expectOk("POST", `${base}/${c.id}/dependencies`, { dependsOnTaskId: b.id });
    // c → b → a; adding a → c closes the loop
    const cycle = await api("POST", `${base}/${a.id}/dependencies`, { dependsOnTaskId: c.id });
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json().code).toBe("dependency_cycle_detected");
    // self-dependency refused
    const self = await api("POST", `${base}/${a.id}/dependencies`, { dependsOnTaskId: a.id });
    expect(self.statusCode).toBe(409);

    // drive A to DONE (founder grooms; manager assigns; owner + reviewer close)
    await expectOk("POST", `${base}/${a.id}/transitions`, { to: "BACKLOG" });
    await expectOk("POST", `${base}/${a.id}/transitions`, { to: "PLANNED" });
    await stateSvc.assign(ctx, a.id, { agentId: OWEN }, agent(MIRA));
    await stateSvc.transition(ctx, a.id, "IN_PROGRESS", agent(OWEN));
    await stateSvc.transition(ctx, a.id, "REVIEW", agent(OWEN));
    await stateSvc.transition(ctx, a.id, "QA", agent(RITA));
    await stateSvc.transition(ctx, a.id, "DONE", agent(RITA));

    const deps = await expectOk("GET", `${base}/${b.id}/dependencies`);
    expect(deps.blockedBy[0].resolvedAt).not.toBeNull();
    const resolvedEvents = await db
      .select()
      .from(events)
      .where(
        sql`${events.companyId} = ${companyId} AND ${events.type} = 'task.dependency.resolved' AND ${events.taskId} = ${b.id}`,
      );
    expect(resolvedEvents).toHaveLength(1);
  });
});

describe("reassignment limit (07 §8)", () => {
  it("trips exactly at 3 reassignments", async () => {
    const base = `/api/v1/companies/${companyId}/tasks`;
    const task = await expectOk("POST", base, { kind: "task", title: "Hot potato", objective: "x" });
    await expectOk("POST", `${base}/${task.id}/transitions`, { to: "BACKLOG" });
    await expectOk("POST", `${base}/${task.id}/transitions`, { to: "PLANNED" });
    await stateSvc.assign(ctx, task.id, { agentId: OWEN }, agent(MIRA)); // initial — not a reassignment
    await stateSvc.assign(ctx, task.id, { agentId: PETE }, agent(MIRA)); // 1
    await stateSvc.assign(ctx, task.id, { agentId: OWEN }, agent(MIRA)); // 2
    const third = await stateSvc.assign(ctx, task.id, { agentId: PETE }, agent(MIRA)); // 3
    expect(third.reassignmentCount).toBe(3);
    await expect(
      stateSvc.assign(ctx, task.id, { agentId: OWEN }, agent(MIRA)),
    ).rejects.toMatchObject({ code: "TASK_REASSIGNMENT_LIMIT" });
  });
});

describe("tree endpoint", () => {
  it("returns the recursive subtree with children nested", async () => {
    const base = `/api/v1/companies/${companyId}/tasks`;
    const goal = await expectOk("POST", base, { kind: "goal", title: "Tree goal", objective: "x" });
    const initiative = await expectOk("POST", base, {
      kind: "initiative",
      parentId: goal.id,
      title: "Tree initiative",
      objective: "x",
    });
    await expectOk("POST", base, {
      kind: "epic",
      parentId: initiative.id,
      title: "Tree epic",
      objective: "x",
    });
    const tree = await expectOk("GET", `${base}/${goal.id}/tree`);
    expect(tree.root.title).toBe("Tree goal");
    expect(tree.root.children[0].title).toBe("Tree initiative");
    expect(tree.root.children[0].children[0].title).toBe("Tree epic");
  });
});

describe("service-level error typing", () => {
  it("depth beyond 5 is refused", async () => {
    // build goal→initiative→epic→task→subtask = depths 0..4; a child of the
    // subtask has no legal kind — depth 5 is only reachable via delegation
    // (T28); here the ladder itself bounds the tree, so assert the guard
    // directly on a synthetic parent
    const goal = await tasksSvc.create(
      ctx,
      { kind: "goal", title: "Depth goal", objective: "x" },
      { kind: "founder" },
    );
    await db.execute(
      sql`UPDATE tasks SET delegation_depth = 5 WHERE id = ${goal.id} AND company_id = ${companyId}`,
    );
    await expect(
      tasksSvc.create(
        ctx,
        { kind: "initiative", parentId: goal.id, title: "Too deep", objective: "x" },
        { kind: "founder" },
      ),
    ).rejects.toMatchObject({ code: "TASK_HIERARCHY_INVALID" });
    expect(new TaskEngineError("TASK_NOT_FOUND", "x").name).toBe("TaskEngineError");
  });
});

// Arşiv (07 §5.6): Founder panoyu temizleyebilmeli ama HİÇBİR ŞEY
// SİLİNMEMELİ. Bu testlerin varlık sebebi somut: canlı panoda 3 tamamlanmış
// göreve karşı 32 iptal birikmişti ve pano okunmaz hâle gelmişti; çözüm
// silmek olsaydı olay zinciri ve o görevlerden doğan anılar sakat kalırdı.
describe("pano arşivi", () => {
  it("arşivlenen görev varsayılan panodan çıkar, satır ve olaylar durur", async () => {
    const task = await tasksSvc.create(
      ctx,
      { kind: "goal", title: "Arşivlenecek hedef", objective: "x" },
      { kind: "founder" },
    );
    await stateSvc.transition(ctx, task.id, "CANCELLED", { kind: "founder" });

    const eventsBefore = await db.execute(
      sql`SELECT count(*)::int AS n FROM events WHERE company_id = ${companyId}`,
    );

    const archived = await tasksSvc.setArchived(ctx, task.id, true);
    expect(archived?.archivedAt).not.toBeNull();

    const active = await tasksSvc.list(ctx, {});
    expect(active.some((t) => t.id === task.id)).toBe(false);

    const inArchive = await tasksSvc.list(ctx, { include: "archived" });
    expect(inArchive.some((t) => t.id === task.id)).toBe(true);

    const all = await tasksSvc.list(ctx, { include: "all" });
    expect(all.some((t) => t.id === task.id)).toBe(true);

    // hiçbir olay silinmedi — arşiv bir görünüm niteliği, veri kaybı değil
    const eventsAfter = await db.execute(
      sql`SELECT count(*)::int AS n FROM events WHERE company_id = ${companyId}`,
    );
    expect((eventsAfter.rows[0] as { n: number }).n).toBe(
      (eventsBefore.rows[0] as { n: number }).n,
    );
  });

  it("geri getirilebilir", async () => {
    const task = await tasksSvc.create(
      ctx,
      { kind: "goal", title: "Geri gelecek hedef", objective: "x" },
      { kind: "founder" },
    );
    await stateSvc.transition(ctx, task.id, "CANCELLED", { kind: "founder" });
    await tasksSvc.setArchived(ctx, task.id, true);
    await tasksSvc.setArchived(ctx, task.id, false);

    const active = await tasksSvc.list(ctx, {});
    expect(active.some((t) => t.id === task.id)).toBe(true);
  });

  it("bir haftadan eski kapanışlar kendiliğinden panodan düşer", async () => {
    const task = await tasksSvc.create(
      ctx,
      { kind: "goal", title: "Eski kapanış", objective: "x" },
      { kind: "founder" },
    );
    await stateSvc.transition(ctx, task.id, "CANCELLED", { kind: "founder" });
    // kapanış zamanını geriye al — solma kuralı closed_at üzerinden işler
    await db.execute(
      sql`UPDATE tasks SET closed_at = now() - interval '9 days'
          WHERE id = ${task.id} AND company_id = ${companyId}`,
    );

    const active = await tasksSvc.list(ctx, {});
    expect(active.some((t) => t.id === task.id)).toBe(false);
    const inArchive = await tasksSvc.list(ctx, { include: "archived" });
    expect(inArchive.some((t) => t.id === task.id)).toBe(true);
  });

  it("açık görev, kapanmamışsa panoda kalır (solma yalnız kapanışa bakar)", async () => {
    const task = await tasksSvc.create(
      ctx,
      { kind: "goal", title: "Açık kalan hedef", objective: "x" },
      { kind: "founder" },
    );
    const active = await tasksSvc.list(ctx, {});
    expect(active.some((t) => t.id === task.id)).toBe(true);
  });
});
