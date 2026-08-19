// T47 acceptance (13 §5–6, demo step 22): the REAL single-writers produce
// skill evidence — review acceptance (REVIEW→QA) appends review_accepted,
// terminal task outcomes append task_success/failure — and agent_skills
// levels/confidence recompute deterministically; the promotion recommendation
// flow emits its events and applies seniority effects.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, asc, eq } from "drizzle-orm";
import { uuidv7 } from "@acos/domain";
import {
  PROMOTION_REVIEW_NOTE_PREFIX,
  ReviewsService,
  SkillsService,
  TaskStateService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
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
import { agentSkills, skillEvidence, skills } from "../../src/schema/skills.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guarded: GuardedDb;
let ctx: CompanyContext;
let taskState: TaskStateService;
let reviewsService: ReviewsService;
let skillsService: SkillsService;

let companyId = "";
let devAgentId = "";
let leadAgentId = "";
let projectId = "";
let taskCounter = 0;

const TAGS = ["backend-development", "testing"];
let repositoryId = "";

async function seedTaggedTask(status = "ASSIGNED"): Promise<string> {
  taskCounter += 1;
  const [task] = await db
    .insert(tasks)
    .values({
      companyId,
      number: taskCounter,
      kind: "task",
      title: `Skill task ${taskCounter}`,
      objective: "Produce evidence.",
      status,
      ownerAgentId: devAgentId,
      projectId,
      context: { skills: TAGS },
    })
    .returning();
  // reviews require a live task workspace (15 §2, T43)
  const { workspaces } = await import("../../src/schema/workspaces-costs.js");
  await db.insert(workspaces).values({
    companyId,
    projectId,
    taskId: task!.id,
    repositoryId,
    agentId: devAgentId,
    isolationLevel: "coding",
    image: "acos/workspace-node",
    branch: `task/${taskCounter}-skill`,
    status: "in_use",
  });
  return task!.id;
}

async function evidenceFor(agentId: string, skillName: string) {
  return db
    .select({
      kind: skillEvidence.kind,
      weight: skillEvidence.weight,
      ref: skillEvidence.ref,
    })
    .from(skillEvidence)
    .innerJoin(agentSkills, eq(skillEvidence.agentSkillId, agentSkills.id))
    .innerJoin(skills, eq(agentSkills.skillId, skills.id))
    .where(
      and(
        eq(skillEvidence.companyId, companyId),
        eq(agentSkills.agentId, agentId),
        eq(skills.name, skillName),
      ),
    )
    .orderBy(asc(skillEvidence.createdAt));
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
  taskState = new TaskStateService(guarded);
  reviewsService = new ReviewsService(guarded);
  skillsService = new SkillsService(guarded);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t47.local", passwordHash: "x", displayName: "F" })
    .returning();
  const { companies } = await import("../../src/schema/companies.js");
  const [company] = await db
    .insert(companies)
    .values({ name: "SkillCo", slug: "skillco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unitRow] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Eng", slug: "eng" })
    .returning();
  const mkAgent = async (role: string, name: string, employeeNumber: number) => {
    const [position] = await db
      .insert(positions)
      .values({ companyId, title: `${role}-pos`, seniorityTrack: ["mid"], defaultRole: role })
      .returning();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId,
        employeeNumber,
        name,
        status: "active",
        positionId: position!.id,
        orgUnitId: unitRow!.id,
        seniority: "mid",
        autonomyLevel: 2,
        persona: `${name}.`,
      })
      .returning();
    return agent!.id;
  };
  devAgentId = await mkAgent("member", "Skill Dev", 1);
  leadAgentId = await mkAgent("lead", "Skill Lead", 2);
  await db.insert(orgEdges).values({
    companyId,
    kind: "reports_to",
    fromAgentId: devAgentId,
    toAgentId: leadAgentId,
  });
  projectId = uuidv7();
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "SkillProj",
    slug: "skillproj",
    objectiveMd: "x",
    status: "active",
    createdByUserId: founder!.id,
  });
  const { repositories } = await import("../../src/schema/projects.js");
  const [repo] = await db
    .insert(repositories)
    .values({
      companyId,
      projectId,
      name: "skillproj",
      barePath: `/data/repos/${projectId}.git`,
    })
    .returning();
  repositoryId = repo!.id;
}, 300_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("skill evidence hooks (13 §5, demo 22)", { timeout: 60_000 }, () => {
  it("review acceptance (REVIEW→QA) + task DONE append evidence per skill tag and recompute", async () => {
    const taskId = await seedTaggedTask();
    const owner = { kind: "agent" as const, agentId: devAgentId };
    await taskState.transition(ctx, taskId, "IN_PROGRESS", owner);
    await taskState.transition(ctx, taskId, "REVIEW", owner);

    const { review } = await reviewsService.requestReview(ctx, {
      taskId,
      authorAgentId: devAgentId,
    });
    await reviewsService.start(ctx, review.id, review.reviewerAgentId!);
    const verdict = await reviewsService.verdict(ctx, review.id, {
      reviewerAgentId: review.reviewerAgentId!,
      verdict: "approved",
      note: "clean work",
    });
    expect(verdict.taskStatus).toBe("QA");

    // review_accepted (+0.5) per tag, ref = the review id (13 §5.1)
    for (const tag of TAGS) {
      const rows = await evidenceFor(devAgentId, tag);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "review_accepted",
        weight: 0.5,
        ref: `review:${review.id}`,
      });
    }

    await taskState.transition(ctx, taskId, "DONE", { kind: "system" });
    for (const tag of TAGS) {
      const rows = await evidenceFor(devAgentId, tag);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({ kind: "task_success", weight: 0.3, ref: `task:${taskId}` });
    }

    // agent_skills recomputed: 2 rows, S=0.8 < 3.0 ⇒ still level 1
    const [row] = await db
      .select()
      .from(agentSkills)
      .innerJoin(skills, eq(agentSkills.skillId, skills.id))
      .where(and(eq(agentSkills.agentId, devAgentId), eq(skills.name, TAGS[0]!)));
    expect(row!.agent_skills.level).toBe(1);
    expect(row!.agent_skills.evidenceCount).toBe(2);
    expect(row!.agent_skills.confidence).toBeGreaterThan(0);
    expect((await eventsOfType("skill.created")).length).toBe(2);
    expect((await eventsOfType("skill.evidence.recorded")).length).toBe(4);
  });

  it("FAILED task appends negative failure evidence; untagged tasks are a no-op", async () => {
    const taskId = await seedTaggedTask();
    await taskState.transition(ctx, taskId, "IN_PROGRESS", {
      kind: "agent",
      agentId: devAgentId,
    });
    await taskState.transition(ctx, taskId, "FAILED", { kind: "founder" }, { note: "broke main" });
    const rows = await evidenceFor(devAgentId, TAGS[0]!);
    expect(rows.at(-1)).toMatchObject({ kind: "failure", weight: -0.4 });

    // untagged task: no evidence rows are produced
    taskCounter += 1;
    const [plain] = await db
      .insert(tasks)
      .values({
        companyId,
        number: taskCounter,
        kind: "task",
        title: "Untagged",
        objective: "x",
        status: "IN_PROGRESS",
        ownerAgentId: leadAgentId,
        context: {},
      })
      .returning();
    await taskState.transition(ctx, plain!.id, "FAILED", { kind: "founder" });
    const leadRows = await db
      .select()
      .from(agentSkills)
      .where(eq(agentSkills.agentId, leadAgentId));
    expect(leadRows).toHaveLength(0);
  });

  it("sustained high-value evidence levels up (agent.skill.updated) and the matrix reflects it", async () => {
    // push backend-development over the level-2 and level-3 thresholds
    for (let i = 0; i < 14; i++) {
      await skillsService.appendEvidence(ctx, {
        agentId: devAgentId,
        skillName: TAGS[0]!,
        kind: "review_accepted",
        ref: `review:${uuidv7()}`,
      });
    }
    const result = await skillsService.appendEvidence(ctx, {
      agentId: devAgentId,
      skillName: TAGS[0]!,
      kind: "production_result",
      weight: 0.7,
      ref: `event:${uuidv7()}`,
    });
    expect(result.score).toBeGreaterThanOrEqual(8);
    expect(result.level).toBe(3);

    const updated = await eventsOfType("agent.skill.updated");
    expect(updated.length).toBeGreaterThanOrEqual(1);
    const last = updated.at(-1)!.payload as { toLevel?: number };
    expect(last.toLevel).toBe(3);

    const matrix = await skillsService.matrix(ctx);
    const cell = matrix.find(
      (m) => m.agentId === devAgentId && m.skillName === TAGS[0]!,
    )!;
    expect(cell.level).toBe(3);
    expect(cell.evidenceCount).toBeGreaterThanOrEqual(17);
  });

  it("level 4 stays artifact-gated through the service too", async () => {
    for (let i = 0; i < 30; i++) {
      await skillsService.appendEvidence(ctx, {
        agentId: devAgentId,
        skillName: TAGS[0]!,
        kind: "review_accepted",
        ref: `review:${uuidv7()}`,
      });
    }
    const without = await skillsService.appendEvidence(ctx, {
      agentId: devAgentId,
      skillName: TAGS[0]!,
      kind: "task_success",
      ref: `task:${uuidv7()}`,
    });
    expect(without.score).toBeGreaterThanOrEqual(16);
    expect(without.level).toBe(3); // no promotion_review artifact yet

    const withArtifact = await skillsService.appendEvidence(ctx, {
      agentId: devAgentId,
      skillName: TAGS[0]!,
      kind: "manager_eval",
      ref: `artifact:${uuidv7()}`,
      note: `${PROMOTION_REVIEW_NOTE_PREFIX}${uuidv7()}`,
    });
    expect(withArtifact.level).toBe(4);
  });

  it("promotion recommendation: event + founder gate for lead+, seniority effects on apply", async () => {
    const senior = await skillsService.recommendPromotion(ctx, {
      agentId: devAgentId,
      byAgentId: leadAgentId,
      toSeniority: "senior",
      evidenceRefs: ["skill_evidence sample"],
    });
    expect(senior).toMatchObject({ founderGated: false, fromSeniority: "mid" });
    const lead = await skillsService.recommendPromotion(ctx, {
      agentId: devAgentId,
      byAgentId: leadAgentId,
      toSeniority: "lead",
    });
    expect(lead.founderGated).toBe(true); // Approval Center request (19 §3)
    const recommended = await eventsOfType("agent.promotion.recommended");
    expect(recommended.length).toBe(2);

    await skillsService.applyPromotion(ctx, { agentId: devAgentId, toSeniority: "senior" });
    const [agent] = await db
      .select({ seniority: agents.seniority, autonomyLevel: agents.autonomyLevel })
      .from(agents)
      .where(eq(agents.id, devAgentId));
    expect(agent).toMatchObject({ seniority: "senior", autonomyLevel: 3 }); // 13 §6.2 defaults
    const promoted = await eventsOfType("agent.promoted");
    expect(promoted).toHaveLength(1);
  });
});
