// T49 acceptance (26 §9, 29 steps 23–24): when a project's last task closes,
// the project transitions to `completed` through the canonical machine
// (demo 23) and the CEO's executive report — outcome, REAL cost-ledger
// numbers, learnings — persists as an executive_report artifact and lands in
// the Founder DM (demo 24). The terminal-task hook rides the memory-trigger
// consumer; report generation is deterministic and idempotent.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, asc, eq } from "drizzle-orm";
import { uuidv7 } from "@acos/domain";
import {
  ExecutiveReportService,
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
  artifacts,
  channels,
  companies,
  costEntries,
  events,
  memories,
  messages,
  orgUnits,
  positions,
  projects,
  tasks,
  users,
} from "@acos/db/schema";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let service: ExecutiveReportService;
let taskState: TaskStateService;

let companyId = "";
let ceoAgentId = "";
let devAgentId = "";
let projectId = "";
let task1 = "";
let task2 = "";

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
  guardedDb = createGuardedDb(pool);
  service = new ExecutiveReportService(guardedDb);
  taskState = new TaskStateService(guardedDb);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t49.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "ReportCo", slug: "reportco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unitRow] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Exec", slug: "exec" })
    .returning();
  const mkAgent = async (role: string, name: string, employeeNumber: number) => {
    const [position] = await db
      .insert(positions)
      .values({ companyId, title: `${role}-pos`, seniorityTrack: ["senior"], defaultRole: role })
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
        seniority: "senior",
        autonomyLevel: 3,
        persona: `${name}.`,
      })
      .returning();
    return agent!.id;
  };
  ceoAgentId = await mkAgent("executive", "CEO Cansu", 1);
  devAgentId = await mkAgent("member", "Dev Doruk", 2);

  projectId = uuidv7();
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Phoenix",
    slug: "phoenix",
    objectiveMd: "Deliver the CSV exporter.",
    status: "active",
    createdByUserId: founder!.id,
  });
  const mkTask = async (number: number, status: string) => {
    const [task] = await db
      .insert(tasks)
      .values({
        companyId,
        number,
        kind: "task",
        title: `Phoenix task ${number}`,
        objective: "x",
        status,
        ownerAgentId: devAgentId,
        projectId,
        context: {},
      })
      .returning();
    return task!.id;
  };
  task1 = await mkTask(1, "DONE");
  task2 = await mkTask(2, "QA");

  // the REAL ledger (26 §11 shape): llm + tool + compute entries
  const entry = (kind: string, amountCents: number, agentId: string | null) =>
    db.insert(costEntries).values({
      companyId,
      kind,
      ref: `${kind}:${uuidv7()}`,
      agentId,
      taskId: task1,
      projectId,
      amountCents,
    });
  await entry("llm", 188, devAgentId);
  await entry("compute", 46, devAgentId);
  await entry("tool", 0, devAgentId);
  await entry("llm", 61, ceoAgentId); // reviewer-style attribution

  // a consolidated project learning (T44) the report must cite
  await db.insert(memories).values({
    companyId,
    scope: "project",
    scopeRef: projectId,
    type: "failure",
    title: "CSV export must stream",
    content: "Buffering OOMs at 100k rows.",
    summary: "Stream rows, never buffer.",
    entities: {},
    importance: 0.75,
    confidence: 0.9,
    status: "active",
  });
}, 300_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("executive report on project completion (demo 23–24)", { timeout: 60_000 }, () => {
  it("does not complete the project while a task is still open", async () => {
    await service.onTaskTerminal(ctx, task1);
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project!.status).toBe("active");
  });

  it("last task closing completes the project and generates the CEO report with REAL ledger numbers", async () => {
    // the last open task reaches DONE through the canonical writer
    await taskState.transition(ctx, task2, "DONE", { kind: "system" });
    await service.onTaskTerminal(ctx, task2);

    // demo 23: project completed through the machine
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    expect(project!.status).toBe("completed");

    // demo 24: the artifact — outcome, cost, learnings
    const [artifact] = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.companyId, companyId), eq(artifacts.kind, "executive_report")));
    expect(artifact).toBeDefined();
    expect(artifact!.projectId).toBe(projectId);
    expect(artifact!.createdByAgentId).toBe(ceoAgentId);
    const md = artifact!.contentMd!;
    expect(md).toContain("# Executive report — Phoenix");
    expect(md).toContain("2 total — 2 done, 0 failed");
    // REAL cost ledger numbers: 188+46+0+61 = 295¢
    expect(md).toContain("(295¢)");
    expect(md).toContain("llm: 2.49 USD (249¢)");
    expect(md).toContain("compute: 0.46 USD (46¢)");
    expect(md).toContain("Dev Doruk"); // top spender resolved by name
    expect(md).toContain("CSV export must stream"); // the learning is cited

    // the CEO's message to the Founder in their DM
    const [dm] = await db
      .select()
      .from(channels)
      .where(and(eq(channels.companyId, companyId), eq(channels.kind, "dm")));
    expect(dm).toBeDefined();
    const dmMessages = await db
      .select()
      .from(messages)
      .where(and(eq(messages.companyId, companyId), eq(messages.channelId, dm!.id)));
    expect(dmMessages).toHaveLength(1);
    expect(dmMessages[0]!.senderAgentId).toBe(ceoAgentId);
    expect(dmMessages[0]!.body).toContain("total spend 2.95 USD");
    expect(JSON.stringify(dmMessages[0]!.refs)).toContain(artifact!.id);

    // events: project.completed carries the report artifact id
    const completed = await eventsOfType("project.completed");
    expect(completed).toHaveLength(1);
    expect((completed[0]!.payload as { reportArtifactId?: string }).reportArtifactId).toBe(
      artifact!.id,
    );
    expect((await eventsOfType("report.published")).length).toBe(1);
  });

  it("the hook is idempotent: replaying the terminal signal creates no duplicates", async () => {
    await service.onTaskTerminal(ctx, task2);
    const reports = await db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.companyId, companyId), eq(artifacts.kind, "executive_report")));
    expect(reports).toHaveLength(1);
    expect((await eventsOfType("project.completed")).length).toBe(1);
  });
});
