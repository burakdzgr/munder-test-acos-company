// T46 acceptance (12 §6, _DECISIONS §10): the promotion rule end-to-end —
// evidence thresholds → candidate copy + derived_from + proposal → approver
// verdict → active copy + memory.promoted (originals stay active). Negative
// tests: a single incident never generalizes, and consolidation can NEVER
// create company-scope memory (promotion is the only path). Contradiction
// resolution: loser superseded + supersedes edge, descendants flagged.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, asc, eq } from "drizzle-orm";
import { uuidv7 } from "@acos/domain";
import {
  MemoryConsolidationService,
  MemoryPromotionService,
  PromotionError,
  appendEvents,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  seedPromotionPolicies,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "../../src/index.js";
import { users } from "../../src/schema/identity.js";
import { agents, orgEdges } from "../../src/schema/agents.js";
import { orgUnits, positions } from "../../src/schema/org.js";
import { projects } from "../../src/schema/projects.js";
import { tasks } from "../../src/schema/tasks.js";
import { events } from "../../src/schema/events.js";
import {
  memories,
  memoryEvidence,
  memoryPromotions,
  memoryRelations,
  memoryVersions,
} from "../../src/schema/memory.js";
import { policies } from "../../src/schema/governance.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guarded: GuardedDb;
let ctx: CompanyContext;
let service: MemoryPromotionService;

let companyId = "";
let devAgentId = "";
let leadAgentId = "";
let managerAgentId = "";
let projectA = "";
let projectB = "";
let taskCounter = 0;

async function seedTask(projectId: string): Promise<{ taskId: string; eventId: string }> {
  taskCounter += 1;
  const [task] = await db
    .insert(tasks)
    .values({
      companyId,
      number: taskCounter,
      kind: "task",
      title: `Promotion task ${taskCounter}`,
      objective: "Evidence source.",
      status: "DONE",
      ownerAgentId: devAgentId,
      projectId,
      context: {},
    })
    .returning();
  let eventId = "";
  await guarded.transaction(async (tx) => {
    const appended = await appendEvents(tx, ctx, [
      {
        type: "task.completed",
        actor: { kind: "agent", id: devAgentId },
        taskId: task!.id,
        projectId,
        agentId: devAgentId,
        payload: { resultSummary: "done" },
      },
    ]);
    eventId = appended[0]!.id;
  });
  return { taskId: task!.id, eventId };
}

async function insertMemory(input: {
  scope: "agent" | "project";
  scopeRef: string;
  type?: string;
  title: string;
  confidence?: number;
  status?: string;
}): Promise<string> {
  const id = uuidv7();
  await db.insert(memories).values({
    id,
    companyId,
    scope: input.scope,
    scopeRef: input.scopeRef,
    type: input.type ?? "failure",
    title: input.title,
    content: `content: ${input.title}`,
    summary: `summary: ${input.title}`,
    entities: {},
    importance: 0.7,
    confidence: input.confidence ?? 0.8,
    status: input.status ?? "active",
  });
  return id;
}

async function addEvidence(memoryId: string, refs: Array<{ kind?: string; ref: string; weight?: number }>) {
  for (const item of refs) {
    await db.insert(memoryEvidence).values({
      companyId,
      memoryId,
      kind: item.kind ?? "event",
      ref: item.ref,
      weight: item.weight ?? 1,
    });
  }
}

async function eventsOfType(type: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.companyId, companyId), eq(events.type, type)))
    .orderBy(asc(events.seq));
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guarded = createGuardedDb(pool);
  service = new MemoryPromotionService(guarded);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t46.local", passwordHash: "x", displayName: "F" })
    .returning();
  const { companies } = await import("../../src/schema/companies.js");
  const [company] = await db
    .insert(companies)
    .values({ name: "PromoCo", slug: "promoco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unitRow] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Eng", slug: "eng" })
    .returning();
  const roles: Array<["member" | "lead" | "manager", string]> = [
    ["member", "Dev Deniz"],
    ["lead", "Lead Lale"],
    ["manager", "Manager Mert"],
  ];
  const ids: string[] = [];
  for (const [i, [role, name]] of roles.entries()) {
    const [position] = await db
      .insert(positions)
      .values({ companyId, title: role, seniorityTrack: ["mid"], defaultRole: role })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        employeeNumber: i + 1,
        name,
        status: "active",
        positionId: position!.id,
        orgUnitId: unitRow!.id,
        seniority: "mid",
        autonomyLevel: 2,
        persona: `${name}.`,
      })
      .returning();
    ids.push(agent!.id);
  }
  [devAgentId, leadAgentId, managerAgentId] = ids as [string, string, string];
  // dev → lead → manager (the lead is the owning approver, 12 §6.2)
  await db.insert(orgEdges).values([
    { companyId, kind: "reports_to", fromAgentId: devAgentId, toAgentId: leadAgentId },
    { companyId, kind: "reports_to", fromAgentId: leadAgentId, toAgentId: managerAgentId },
  ]);

  const mkProject = async (name: string) => {
    const id = uuidv7();
    await db.insert(projects).values({
      id,
      companyId,
      name,
      slug: name.toLowerCase(),
      objectiveMd: "x",
      status: "active",
      createdByUserId: founder!.id,
    });
    return id;
  };
  projectA = await mkProject("Alpha");
  projectB = await mkProject("Beta");

  await seedPromotionPolicies(guarded, ctx);
}, 300_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("promotion engine (12 §6)", { timeout: 60_000 }, () => {
  it("seeds the three binding default rules idempotently", async () => {
    const rows = await db
      .select()
      .from(policies)
      .where(and(eq(policies.companyId, companyId), eq(policies.kind, "memory_promotion")));
    expect(rows).toHaveLength(3);
    const again = await seedPromotionPolicies(guarded, ctx);
    expect(again).toBe(0); // idempotent — no duplicates
  });

  it("agent→project end-to-end: ≥3 evidence across ≥2 tasks → candidate copy + derived_from; lead approves → active + memory.promoted; original stays active", async () => {
    const t1 = await seedTask(projectA);
    const t2 = await seedTask(projectA);
    const source = await insertMemory({
      scope: "agent",
      scopeRef: devAgentId,
      type: "failure",
      title: "OOM on buffered export",
    });
    await addEvidence(source, [
      { ref: t1.eventId },
      { ref: t2.eventId },
      { kind: "statement", ref: "seen it twice in review threads", weight: 0.7 },
    ]);

    const result = await service.evaluateCompany(ctx);
    expect(result.proposed).toBe(1);

    const [promotion] = await db
      .select()
      .from(memoryPromotions)
      .where(and(eq(memoryPromotions.companyId, companyId), eq(memoryPromotions.sourceMemoryId, source)));
    expect(promotion).toMatchObject({
      targetScope: "project",
      targetRef: projectA,
      status: "proposed",
      evidenceCount: 3,
      distinctTaskCount: 2,
      approverAgentId: leadAgentId, // the owning lead (12 §6.2)
    });
    expect(promotion!.rulePolicyId).not.toBeNull();

    const copy = (
      await db.select().from(memories).where(eq(memories.id, promotion!.targetMemoryId!))
    )[0]!;
    expect(copy).toMatchObject({ scope: "project", scopeRef: projectA, status: "candidate", type: "failure" });
    const relations = await db
      .select()
      .from(memoryRelations)
      .where(and(eq(memoryRelations.fromMemoryId, copy.id), eq(memoryRelations.kind, "derived_from")));
    expect(relations).toHaveLength(1);
    expect(relations[0]!.toMemoryId).toBe(source);
    expect((await eventsOfType("memory.promotion.proposed")).length).toBeGreaterThanOrEqual(1);

    // re-evaluation must not duplicate the open proposal
    const rerun = await service.evaluateCompany(ctx);
    expect(rerun.proposed).toBe(0);

    // the wrong agent cannot decide; the designated lead can
    await expect(
      service.decide(ctx, promotion!.id, { verdict: "approved", approverAgentId: devAgentId }),
    ).rejects.toMatchObject({ code: "PROMOTION_WRONG_APPROVER" });
    const decided = await service.decide(ctx, promotion!.id, {
      verdict: "approved",
      approverAgentId: leadAgentId,
    });
    expect(decided.status).toBe("active");

    const after = (await db.select().from(memories).where(eq(memories.id, copy.id)))[0]!;
    expect(after.status).toBe("active");
    const original = (await db.select().from(memories).where(eq(memories.id, source)))[0]!;
    expect(original.status).toBe("active"); // promotion copies, never moves
    const promoted = await eventsOfType("memory.promoted");
    expect(
      promoted.some((e) => (e.payload as { newMemoryId?: string }).newMemoryId === copy.id),
    ).toBe(true);
    const versions = await db
      .select()
      .from(memoryVersions)
      .where(eq(memoryVersions.memoryId, copy.id))
      .orderBy(asc(memoryVersions.version));
    expect(versions.map((v) => v.changeReason)).toEqual([
      "promotion_proposal",
      "promotion_approved",
    ]);
  });

  it("a single incident never generalizes: 3 evidence rows from ONE task propose nothing", async () => {
    const t = await seedTask(projectA);
    const source = await insertMemory({
      scope: "agent",
      scopeRef: devAgentId,
      type: "failure",
      title: "single flaky run",
    });
    // 3 rows, all anchored to the same task+event — distinct_tasks = 1 < 2
    await addEvidence(source, [
      { ref: t.eventId },
      { ref: t.eventId, weight: 0.9 },
      { kind: "statement", ref: "one observation", weight: 0.8 },
    ]);
    const result = await service.evaluateCompany(ctx);
    expect(result.proposed).toBe(0);
    const rows = await db
      .select()
      .from(memoryPromotions)
      .where(and(eq(memoryPromotions.companyId, companyId), eq(memoryPromotions.sourceMemoryId, source)));
    expect(rows).toHaveLength(0);
  });

  it("low-weight evidence (< 0.6) does not count toward the threshold", async () => {
    const t1 = await seedTask(projectA);
    const t2 = await seedTask(projectA);
    const source = await insertMemory({
      scope: "agent",
      scopeRef: devAgentId,
      type: "procedural",
      title: "weak evidence procedure",
    });
    await addEvidence(source, [
      { ref: t1.eventId },
      { ref: t2.eventId },
      { kind: "statement", ref: "hearsay", weight: 0.5 }, // below the floor
    ]);
    const result = await service.evaluateCompany(ctx);
    expect(result.proposed).toBe(0); // only 2 rows ≥ 0.6
  });

  it("project→company: ≥4 evidence across ≥2 projects → manager-approved company copy; 1 project proposes nothing", async () => {
    // qualifying: evidence events span Alpha AND Beta
    const a1 = await seedTask(projectA);
    const a2 = await seedTask(projectA);
    const b1 = await seedTask(projectB);
    const b2 = await seedTask(projectB);
    const source = await insertMemory({
      scope: "project",
      scopeRef: projectA,
      type: "procedural",
      title: "always pin dependency versions",
    });
    await addEvidence(source, [
      { ref: a1.eventId },
      { ref: a2.eventId },
      { ref: b1.eventId },
      { ref: b2.eventId },
    ]);

    // negative control: evidence from one project only
    const single = await insertMemory({
      scope: "project",
      scopeRef: projectA,
      type: "procedural",
      title: "single-project habit",
    });
    const a3 = await seedTask(projectA);
    const a4 = await seedTask(projectA);
    const a5 = await seedTask(projectA);
    const a6 = await seedTask(projectA);
    await addEvidence(single, [
      { ref: a3.eventId },
      { ref: a4.eventId },
      { ref: a5.eventId },
      { ref: a6.eventId },
    ]);

    const result = await service.evaluateCompany(ctx);
    expect(result.proposed).toBe(1);

    const [promotion] = await db
      .select()
      .from(memoryPromotions)
      .where(and(eq(memoryPromotions.companyId, companyId), eq(memoryPromotions.sourceMemoryId, source)));
    expect(promotion).toMatchObject({
      targetScope: "company",
      targetRef: null,
      status: "proposed",
      approverAgentId: managerAgentId,
    });
    const copy = (
      await db.select().from(memories).where(eq(memories.id, promotion!.targetMemoryId!))
    )[0]!;
    expect(copy).toMatchObject({ scope: "company", scopeRef: null, status: "candidate" });

    const singleRows = await db
      .select()
      .from(memoryPromotions)
      .where(and(eq(memoryPromotions.companyId, companyId), eq(memoryPromotions.sourceMemoryId, single)));
    expect(singleRows).toHaveLength(0);

    // manager approves → company-scope knowledge is live
    await service.decide(ctx, promotion!.id, { verdict: "approved", approverAgentId: managerAgentId });
    const live = (await db.select().from(memories).where(eq(memories.id, copy.id)))[0]!;
    expect(live.status).toBe("active");
  });

  it("consolidation can NEVER create company scope — promotion is the only path (12 §6.1)", async () => {
    const consolidation = new MemoryConsolidationService(guarded);
    await expect(
      consolidation.persistCandidate(ctx, {
        scope: "company",
        scopeRef: "",
        type: "semantic",
        title: "sneaky company fact",
        content: "x",
        summary: "x",
        entities: {},
        importance: 0.9,
        confidence: 0.9,
        sourceEventId: null,
        createdByAgentId: null,
        embedding: null,
        embeddingModel: null,
        evidence: [],
        relations: [],
      }),
    ).rejects.toMatchObject({ code: "MEMORY_SCOPE_FORBIDDEN" });
  });

  it("reject path: the copy is rejected with the note in a version row; original untouched", async () => {
    const t1 = await seedTask(projectB);
    const t2 = await seedTask(projectB);
    const source = await insertMemory({
      scope: "agent",
      scopeRef: devAgentId,
      type: "decision",
      title: "questionable shortcut",
    });
    await addEvidence(source, [
      { ref: t1.eventId },
      { ref: t2.eventId },
      { kind: "statement", ref: "maybe", weight: 0.7 },
    ]);
    await service.evaluateCompany(ctx);
    const [promotion] = await db
      .select()
      .from(memoryPromotions)
      .where(and(eq(memoryPromotions.companyId, companyId), eq(memoryPromotions.sourceMemoryId, source)));
    const decided = await service.decide(ctx, promotion!.id, {
      verdict: "rejected",
      approverAgentId: leadAgentId,
      note: "too specific to one repo",
    });
    expect(decided.status).toBe("rejected");
    const versions = await db
      .select()
      .from(memoryVersions)
      .where(eq(memoryVersions.memoryId, promotion!.targetMemoryId!))
      .orderBy(asc(memoryVersions.version));
    expect(versions[1]!.changeReason).toContain("promotion_rejected");
    expect(versions[1]!.changeReason).toContain("too specific");
    // double-decide guarded
    await expect(
      service.decide(ctx, promotion!.id, { verdict: "approved", approverAgentId: leadAgentId }),
    ).rejects.toMatchObject({ code: "PROMOTION_ALREADY_DECIDED" });
  });

  it("contradiction resolution: loser superseded + supersedes edge; promoted descendants flagged, never auto-archived", async () => {
    const winner = await insertMemory({
      scope: "project",
      scopeRef: projectA,
      type: "failure",
      title: "retry with backoff",
    });
    const loser = await insertMemory({
      scope: "project",
      scopeRef: projectA,
      type: "failure",
      title: "never retry",
    });
    const [contradiction] = await db
      .insert(memoryRelations)
      .values({
        companyId,
        fromMemoryId: winner,
        toMemoryId: loser,
        kind: "contradicts",
        createdBy: "system",
      })
      .returning({ id: memoryRelations.id });
    // a descendant previously promoted FROM the loser
    const descendant = await insertMemory({
      scope: "project",
      scopeRef: projectB,
      type: "failure",
      title: "never retry (promoted)",
    });
    await db.insert(memoryRelations).values({
      companyId,
      fromMemoryId: descendant,
      toMemoryId: loser,
      kind: "derived_from",
      createdBy: "system",
    });

    const result = await service.resolveContradiction(ctx, {
      relationId: contradiction!.id,
      winnerMemoryId: winner,
      resolvedByAgentId: leadAgentId,
      note: "backoff is the standard",
    });
    expect(result.loserMemoryId).toBe(loser);
    expect(result.flaggedDescendants).toEqual([descendant]);

    const loserRow = (await db.select().from(memories).where(eq(memories.id, loser)))[0]!;
    expect(loserRow.status).toBe("superseded");
    const descendantRow = (await db.select().from(memories).where(eq(memories.id, descendant)))[0]!;
    expect(descendantRow.status).toBe("active"); // flagged for review, never auto-archived
    const supersedes = await db
      .select()
      .from(memoryRelations)
      .where(
        and(
          eq(memoryRelations.fromMemoryId, winner),
          eq(memoryRelations.toMemoryId, loser),
          eq(memoryRelations.kind, "supersedes"),
        ),
      );
    expect(supersedes).toHaveLength(1);
    const superseded = await eventsOfType("memory.superseded");
    expect(
      superseded.some((e) => (e.payload as { memoryId?: string }).memoryId === loser),
    ).toBe(true);

    // winner must be part of the pair
    await expect(
      service.resolveContradiction(ctx, {
        relationId: contradiction!.id,
        winnerMemoryId: descendant,
        resolvedByAgentId: leadAgentId,
      }),
    ).rejects.toBeInstanceOf(PromotionError);
  });
});
