// T28 acceptance: depth trips exactly at 5 and reassignment exactly at 3
// (then forced manager intervention); delegation follows reporting lines with
// WIP capacity checks; pro-rata budget inheritance (80/20, conservation);
// budget.exceeded pauses non-critical agents and budget.restored resumes them.
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
import { agents, budgets, events, tasks } from "@acos/db/schema";
import { buildApp, type App } from "../../src/app.js";
import { CostService } from "../../src/modules/costs/service.js";
import { DelegationService } from "../../src/modules/tasks/delegation.js";
import {
  TasksService,
  TaskStateService,
} from "../../src/modules/tasks/service.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const MASTER_KEY = Buffer.alloc(32, 17).toString("base64");
const ok = async () => {};

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let app: App;
let ctx: CompanyContext;
let tasksSvc: TasksService;
let stateSvc: TaskStateService;
let delegation: DelegationService;
let costs: CostService;
let sessionCookie = "";
let csrfToken = "";
let companyId = "";
let CEO = "";
let MIRA = ""; // manager (manages OWEN, PETE, RITA)
let OWEN = ""; // member
let PETE = ""; // member
let RITA = ""; // reviewer (lead seniority track → breaker-critical)

const authHeaders = () => ({
  cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
  "x-csrf-token": csrfToken,
});

async function expectOk(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    headers: authHeaders(),
    ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
  });
  expect(response.statusCode, `${method} ${url} → ${response.body}`).toBeLessThan(300);
  return response.json();
}

const agentActor = (agentId: string) => ({ kind: "agent" as const, agentId });

async function eventsOfType(type: string) {
  return db
    .select()
    .from(events)
    .where(sql`${events.companyId} = ${companyId} AND ${events.type} = ${type}`)
    .orderBy(events.seq);
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  tasksSvc = new TasksService(guardedDb);
  stateSvc = new TaskStateService(guardedDb);
  delegation = new DelegationService(guardedDb, tasksSvc, stateSvc);
  costs = new CostService(guardedDb);
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
    payload: { email: "founder@t28.local", password: "correct-horse-battery", displayName: "F" },
  });
  for (const c of setup.cookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }
  const company = await expectOk("POST", "/api/v1/companies", {
    name: "DelegCo",
    slug: "delegco",
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
  const execPos = await expectOk("POST", `${base}/org/positions`, {
    title: "CEO",
    seniorityTrack: ["executive"],
    defaultRole: "executive",
  });
  const managerPos = await expectOk("POST", `${base}/org/positions`, {
    title: "Engineering Manager",
    seniorityTrack: ["lead", "expert"],
    defaultRole: "manager",
  });
  const devPos = await expectOk("POST", `${base}/org/positions`, {
    title: "Backend Engineer",
    seniorityTrack: ["junior", "mid"],
    defaultRole: "member",
  });
  const reviewerPos = await expectOk("POST", `${base}/org/positions`, {
    title: "QA/Reviewer",
    seniorityTrack: ["senior", "lead"],
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

  CEO = await hire("Cem CEO", execPos.id);
  MIRA = await hire("Mira Manager", managerPos.id, CEO);
  OWEN = await hire("Owen Owner", devPos.id, MIRA);
  PETE = await hire("Pete Peer", devPos.id, MIRA);
  RITA = await hire("Rita Reviewer", reviewerPos.id, MIRA);
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

/** founder grooms a fresh PLANNED task */
async function plannedTask(title: string, extra: Record<string, unknown> = {}) {
  const base = `/api/v1/companies/${companyId}/tasks`;
  const task = await expectOk("POST", base, { kind: "task", title, objective: title, ...extra });
  await expectOk("POST", `${base}/${task.id}/transitions`, { to: "BACKLOG" });
  await expectOk("POST", `${base}/${task.id}/transitions`, { to: "PLANNED" });
  return task as { id: string; number: number };
}

describe("delegation depth trips exactly at 5 (07 §2/§8)", () => {
  it("depth 5 is created, depth 6 is refused", async () => {
    const root = await tasksSvc.create(
      ctx,
      { kind: "task", title: "Depth root", objective: "x" },
      { kind: "founder" },
    );
    await db.execute(
      sql`UPDATE tasks SET delegation_depth = 4 WHERE id = ${root.id} AND company_id = ${companyId}`,
    );
    const child = await delegation.createChildTask(ctx, MIRA, {
      parentTaskId: root.id,
      kind: "subtask",
      title: "Depth 5 — allowed",
      objective: "x",
    });
    expect(child.delegationDepth).toBe(5);

    await db.execute(
      sql`UPDATE tasks SET kind = 'task', delegation_depth = 5 WHERE id = ${child.id} AND company_id = ${companyId}`,
    );
    await expect(
      delegation.createChildTask(ctx, MIRA, {
        parentTaskId: child.id,
        kind: "subtask",
        title: "Depth 6 — refused",
        objective: "x",
      }),
    ).rejects.toMatchObject({ code: "TASK_HIERARCHY_INVALID" });
  });
});

describe("delegation follows reporting lines (07 §6)", () => {
  it("manager delegates into the manages closure; members cannot; CEO never to ICs", async () => {
    const t1 = await plannedTask("Line check 1");
    const result = await delegation.delegateTask(ctx, MIRA, t1.id, OWEN);
    expect(result.ok).toBe(true);

    const t2 = await plannedTask("Line check 2");
    await expect(delegation.delegateTask(ctx, OWEN, t2.id, PETE)).rejects.toMatchObject({
      code: "TASK_TRANSITION_INVALID",
    });

    await expect(delegation.delegateTask(ctx, CEO, t2.id, OWEN)).rejects.toMatchObject({
      code: "TASK_TRANSITION_INVALID", // CEO-level delegates to executives, never ICs
    });
    const toManager = await delegation.delegateTask(ctx, CEO, t2.id, MIRA);
    expect(toManager.ok).toBe(true);
  });
});

describe("WIP capacity model (07 §6.1)", () => {
  it("member WIP limit 2 blocks the 3rd active task and offers candidates", async () => {
    // OWEN already owns one IN_PROGRESS-able task from the previous suite —
    // bring him to exactly 2 active
    const owned = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.companyId} = ${companyId} AND ${tasks.ownerAgentId} = ${OWEN} AND ${tasks.status} = 'ASSIGNED'`);
    for (const t of owned) await stateSvc.transition(ctx, t.id, "IN_PROGRESS", agentActor(OWEN));
    while (true) {
      const active = await db.execute(
        sql`SELECT count(*)::int AS n FROM tasks WHERE company_id = ${companyId} AND owner_agent_id = ${OWEN} AND status IN ('IN_PROGRESS','REVIEW','CHANGES_REQUESTED','QA_FAILED','REJECTED')`,
      );
      if (Number((active.rows[0] as { n: number }).n) >= 2) break;
      const extra = await plannedTask(`Owen load ${Date.now() % 100000}`);
      const delegated = await delegation.delegateTask(ctx, MIRA, extra.id, OWEN);
      expect(delegated.ok).toBe(true);
      await stateSvc.transition(ctx, extra.id, "IN_PROGRESS", agentActor(OWEN));
    }

    const overflow = await plannedTask("Owen overflow");
    const refused = await delegation.delegateTask(ctx, MIRA, overflow.id, OWEN);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe("WIP_LIMIT");
      expect(refused.candidates.map((c) => c.agentId)).toContain(PETE);
      // candidates carry load info for the manager's re-plan step
      expect(refused.candidates[0]).toHaveProperty("activeWip");
    }
  });
});

describe("pro-rata budget inheritance (07 §9 — 80/20)", () => {
  it("splits floor(B×0.8×w/Σw), conserves the pool, later children draw the remainder", async () => {
    const base = `/api/v1/companies/${companyId}/tasks`;
    const parent = await expectOk("POST", base, {
      kind: "epic",
      parentId: (
        await expectOk("POST", base, {
          kind: "initiative",
          parentId: (
            await expectOk("POST", base, { kind: "goal", title: "Budget goal", objective: "x" })
          ).id,
          title: "Budget initiative",
          objective: "x",
        })
      ).id,
      title: "Budget epic",
      objective: "x",
      budgetCents: 10_000,
    });

    const mkChild = (title: string, effort: number) =>
      delegation.createChildTask(ctx, MIRA, {
        parentTaskId: parent.id,
        kind: "task",
        title,
        objective: title,
        estimatedEffort: effort,
      });
    const c1 = await mkChild("Child 5", 5);
    const c2 = await mkChild("Child 3", 3);
    const c3 = await mkChild("Child 2", 2);
    for (const c of [c1, c2, c3]) {
      await stateSvc.transition(ctx, c.id, "BACKLOG", agentActor(MIRA));
      await stateSvc.transition(ctx, c.id, "PLANNED", agentActor(MIRA));
    }

    const d1 = await delegation.delegateTask(ctx, MIRA, c1.id, PETE);
    expect(d1.ok && d1.task.budgetCents).toBe(4_000); // floor(10000×0.8×5/10)
    const d2 = await delegation.delegateTask(ctx, MIRA, c2.id, RITA);
    expect(d2.ok && d2.task.budgetCents).toBe(2_400);
    const d3 = await delegation.delegateTask(ctx, MIRA, c3.id, MIRA);
    expect(d3.ok && d3.task.budgetCents).toBe(1_600);

    // conservation: Σ allocations = 8000 = 0.8 × B; 20% reserve intact
    const budgetRows = await db
      .select()
      .from(budgets)
      .where(sql`${budgets.companyId} = ${companyId} AND ${budgets.scopeKind} = 'task'`);
    const allocated = budgetRows.reduce((sum, b) => sum + b.limitCents, 0);
    expect(allocated).toBe(8_000);
    expect(budgetRows.every((b) => b.kind === "hard" && b.period === "total")).toBe(true);

    // a 4th child finds the pool exhausted → no inherited budget
    const late = await delegation.createChildTask(ctx, MIRA, {
      parentTaskId: parent.id,
      kind: "task",
      title: "Late child",
      objective: "x",
      estimatedEffort: 8,
    });
    await stateSvc.transition(ctx, late.id, "BACKLOG", agentActor(MIRA));
    await stateSvc.transition(ctx, late.id, "PLANNED", agentActor(MIRA));
    const d4 = await delegation.delegateTask(ctx, MIRA, late.id, PETE);
    expect(d4.ok).toBe(true);
    if (d4.ok) expect(d4.task.budgetCents).toBeNull();
  });
});

describe("reassignment trips exactly at 3 → forced manager intervention (07 §8)", () => {
  it("4th move refused, P1 intervention task created, force_reassign succeeds", async () => {
    const task = await plannedTask("Hot potato 28");
    await stateSvc.assign(ctx, task.id, { agentId: OWEN }, agentActor(MIRA)); // initial
    await stateSvc.assign(ctx, task.id, { agentId: PETE }, agentActor(MIRA)); // 1
    await stateSvc.assign(ctx, task.id, { agentId: OWEN }, agentActor(MIRA)); // 2
    await stateSvc.assign(ctx, task.id, { agentId: PETE }, agentActor(MIRA)); // 3

    // RITA has WIP headroom — the refusal must come from the reassignment
    // limit, not capacity
    await expect(delegation.delegateTask(ctx, MIRA, task.id, RITA)).rejects.toMatchObject({
      code: "TASK_REASSIGNMENT_LIMIT",
    });

    // the hot-potato guard filed a P1 task for the manager
    const intervention = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.companyId} = ${companyId} AND ${tasks.context}->>'interventionFor' = ${task.id}`);
    expect(intervention).toHaveLength(1);
    expect(intervention[0]!.priority).toBe("P1");
    const [flagged] = await db
      .select()
      .from(tasks)
      .where(sql`${tasks.companyId} = ${companyId} AND ${tasks.id} = ${task.id}`);
    expect((flagged!.context as Record<string, unknown>).needsManagerIntervention).toBe(true);

    // explicit force by a Manager+ moves it; the count stays at the cap
    const forced = await delegation.delegateTask(ctx, MIRA, task.id, RITA, { force: true });
    expect(forced.ok).toBe(true);
    if (forced.ok) {
      expect(forced.task.ownerAgentId).toBe(RITA);
      expect(forced.task.reassignmentCount).toBe(3);
    }
    // but force is manager-only: a member cannot use it
    await expect(
      stateSvc.assign(ctx, task.id, { agentId: PETE }, agentActor(OWEN), { force: true }),
    ).rejects.toMatchObject({ code: "TASK_REASSIGNMENT_LIMIT" });
  });

  it("T40: requiredCapabilities nobody matches must not empty the delegate pool", async () => {
    // Kevin'in E4 kosusundaki STALL'un birebir modeli: model gorevin
    // yeteneklerini kendi sozcukleriyle yaziyor ("backend","nodejs",...) ama
    // sirketin eslesme yuzeyi org_unit slug'i + pozisyon basligi + agent_skills
    // ve Agent Factory ile kurulan sirkette agent_skills BOS. Hicbir aday
    // hicbir etiketi tutturamiyor. Eskiden bu, havuzu bosaltip
    // NO_ELIGIBLE_DELEGATE veriyordu; yani ekibi OLAN bir lead'e "once ekibi
    // kur" deniyor ve is hic delege edilmiyordu.
    const root = await tasksSvc.create(
      ctx,
      { kind: "task", title: "T40 root", objective: "x" },
      { kind: "founder" },
    );
    const impossible = await delegation.createChildTask(ctx, MIRA, {
      parentTaskId: root.id,
      kind: "subtask",
      title: "Nobody matches these",
      objective: "x",
      requiredCapabilities: ["quantum-cryogenics", "cobol-on-cogs"],
    });
    const target = await delegation.resolveDelegateTarget(ctx, MIRA, "", impossible.id);
    expect(target).not.toBeNull();
    expect([OWEN, PETE, RITA, MIRA]).toContain(target);

    // KORUNAN taraf: raporu OLMAYAN bir yoneticinin havuzu hala bos — "once
    // ekibi kur" (agent.hire) anlamini yalnizca gercekten kadrosuz hal tasir.
    const orphanTarget = await delegation.resolveDelegateTarget(ctx, OWEN, "", impossible.id);
    expect(orphanTarget).toBeNull();
  });
});

describe("company circuit breaker (26 §5) — the policy hook", () => {
  it("hard company breach pauses non-critical agents; budget.restored resumes them", async () => {
    await costs.setBudget(ctx, {
      scopeKind: "company",
      period: "daily",
      limitCents: 1_000,
      kind: "hard",
    });
    // RITA owns a task in REVIEW → breaker-protected even without track
    const reviewTask = await plannedTask("Rita governance");
    await stateSvc.assign(ctx, reviewTask.id, { agentId: RITA }, agentActor(MIRA));
    await stateSvc.transition(ctx, reviewTask.id, "IN_PROGRESS", agentActor(RITA));
    await stateSvc.transition(ctx, reviewTask.id, "REVIEW", agentActor(RITA));

    // below the limit — no breach event
    await costs.recordCost(ctx, { kind: "llm", ref: "call-1", amountCents: 600, agentId: OWEN });
    expect(await eventsOfType("budget.exceeded")).toHaveLength(0);

    // the crossing write trips the breaker
    await costs.recordCost(ctx, { kind: "llm", ref: "call-2", amountCents: 600, agentId: OWEN });
    const exceeded = await eventsOfType("budget.exceeded");
    expect(exceeded).toHaveLength(1);
    const payload = exceeded[0]!.payload as { scope: string; pausedAgentIds: string[] };
    expect(payload.scope).toBe("company");

    const rows = await db
      .select()
      .from(agents)
      .where(sql`${agents.companyId} = ${companyId}`);
    const statusOf = (id: string) => rows.find((a) => a.id === id)!.status;
    // members pause; executive/lead tracks and the REVIEW-owner stay up
    expect(statusOf(OWEN)).toBe("paused");
    expect(statusOf(PETE)).toBe("paused");
    expect(statusOf(CEO)).toBe("active");
    expect(statusOf(MIRA)).toBe("active");
    expect(statusOf(RITA)).toBe("active");
    expect(payload.pausedAgentIds.sort()).toEqual([OWEN, PETE].sort());

    // a second crossing is not re-emitted (already above the limit)
    await costs.recordCost(ctx, { kind: "llm", ref: "call-3", amountCents: 100, agentId: OWEN });
    expect(await eventsOfType("budget.exceeded")).toHaveLength(1);

    // restore: limit raised → breaker-paused agents resume automatically
    const [companyBudget] = await db
      .select()
      .from(budgets)
      .where(sql`${budgets.companyId} = ${companyId} AND ${budgets.scopeKind} = 'company'`);
    await costs.restoreBudget(ctx, companyBudget!.id, 100_000);
    const after = await db
      .select()
      .from(agents)
      .where(sql`${agents.companyId} = ${companyId}`);
    expect(after.find((a) => a.id === OWEN)!.status).toBe("active");
    expect(after.find((a) => a.id === PETE)!.status).toBe("active");
    expect(await eventsOfType("budget.restored")).toHaveLength(1);
    expect((await eventsOfType("agent.resumed")).length).toBeGreaterThanOrEqual(2);
  });

  it("task-scope hard breach emits budget.exceeded without pausing; soft emits warning", async () => {
    const scoped = await plannedTask("Scoped budget");
    await costs.setBudget(ctx, {
      scopeKind: "task",
      scopeRef: scoped.id,
      period: "total",
      limitCents: 500,
      kind: "hard",
    });
    await costs.recordCost(ctx, { kind: "tool", ref: "tool-1", amountCents: 700, taskId: scoped.id });
    const exceeded = await eventsOfType("budget.exceeded");
    const taskBreach = exceeded.filter((e) => (e.payload as { scope: string }).scope === "task");
    expect(taskBreach).toHaveLength(1);
    expect((taskBreach[0]!.payload as { pausedAgentIds: string[] }).pausedAgentIds).toEqual([]);

    await costs.setBudget(ctx, {
      scopeKind: "agent",
      scopeRef: PETE,
      period: "daily",
      limitCents: 50,
      kind: "soft",
    });
    await costs.recordCost(ctx, { kind: "llm", ref: "call-4", amountCents: 80, agentId: PETE });
    const warnings = await eventsOfType("budget.warning");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    // soft breach never pauses
    const [pete] = await db
      .select()
      .from(agents)
      .where(sql`${agents.companyId} = ${companyId} AND ${agents.id} = ${PETE}`);
    expect(pete!.status).toBe("active");
  });

  it("spend lands in the ledger and on the task row", async () => {
    const [entryCount] = (
      await db.execute(sql`SELECT count(*)::int AS n FROM cost_entries WHERE company_id = ${companyId}`)
    ).rows as [{ n: number }];
    expect(Number(entryCount.n)).toBeGreaterThanOrEqual(5);
    const recorded = await eventsOfType("cost.entry.recorded");
    expect(recorded.length).toBeGreaterThanOrEqual(5);
  });
});
