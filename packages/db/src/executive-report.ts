// Executive report on project completion (T49; 26 §9, 29 step 23–24).
// Demo 23: when a project's last open task closes, the project transitions to
// `completed` through the canonical machine. Demo 24: the CEO's report —
// outcome, REAL cost-ledger numbers and learnings — persists as an
// `executive_report` artifact and lands in the Founder's DM from the CEO.
// Deterministic rendering; no LLM in the money path.
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { parseEventPayload } from "@acos/events";
import { appendEvents, type NewEventInput, type Tx } from "./outbox.js";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { ChannelService, MessageService } from "./comms.js";
import { ProjectsService } from "./projects.js";
import { uuidv7 } from "@acos/domain";
import {
  agents,
  artifacts,
  costEntries,
  memories,
  projects,
  reviews,
  tasks,
} from "./schema/index.js";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

const TERMINAL_TASK_STATUSES = ["DONE", "CANCELLED", "FAILED", "REJECTED"];

export interface ExecutiveReportResult {
  artifactId: string;
  messageId: string | null;
  totalCostCents: number;
}

export class ExecutiveReportService {
  private readonly projectsService: ProjectsService;
  private readonly messageService: MessageService;
  private readonly channelService: ChannelService;

  constructor(private readonly db: GuardedDb) {
    this.projectsService = new ProjectsService(db);
    this.channelService = new ChannelService(db);
    this.messageService = new MessageService(db, this.channelService);
  }

  /**
   * Demo 23: a project completes when every one of its tasks is terminal and
   * at least one reached DONE. The canonical machine guards active→completed;
   * a second call is a no-op (the project is no longer `active`).
   */
  async maybeCompleteProject(ctx: CompanyContext, projectId: string): Promise<boolean> {
    const [project] = await this.db
      .select({ status: projects.status })
      .from(projects)
      .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, projectId)));
    if (!project || project.status !== "active") return false;

    const rows = await this.db
      .select({ status: tasks.status, n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.projectId, projectId)))
      .groupBy(tasks.status);
    const total = rows.reduce((sum, r) => sum + r.n, 0);
    if (total === 0) return false;
    const open = rows.filter((r) => !TERMINAL_TASK_STATUSES.includes(r.status));
    const done = rows.find((r) => r.status === "DONE")?.n ?? 0;
    if (open.length > 0 || done === 0) return false;

    await this.projectsService.transition(ctx, projectId, "completed");
    return true;
  }

  /**
   * Demo 24: gather outcome + the REAL cost ledger + learnings, render the
   * deterministic report, persist the artifact and message the Founder as
   * the CEO. Idempotent per project (one executive_report artifact).
   */
  async generateReport(ctx: CompanyContext, projectId: string): Promise<ExecutiveReportResult> {
    const [project] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, projectId)));
    if (!project) throw new Error(`project ${projectId} not found`);

    const [existing] = await this.db
      .select({ id: artifacts.id })
      .from(artifacts)
      .where(
        and(
          eq(artifacts.companyId, ctx.companyId),
          eq(artifacts.projectId, projectId),
          eq(artifacts.kind, "executive_report"),
        ),
      )
      .limit(1);
    if (existing) return { artifactId: existing.id, messageId: null, totalCostCents: 0 };

    // ---- outcome: task counts + merged deliveries ----
    const taskRows = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.projectId, projectId)));
    const count = (status: string) => taskRows.filter((t) => t.status === status).length;
    const merges = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(reviews)
      .where(
        and(
          eq(reviews.companyId, ctx.companyId),
          eq(reviews.projectId, projectId),
          isNotNull(reviews.mergedCommit),
        ),
      );

    // ---- cost: the REAL ledger (26 §11) — totals by kind + top agents ----
    const byKind = await this.db
      .select({ kind: costEntries.kind, cents: sql<number>`coalesce(sum(${costEntries.amountCents}), 0)::int` })
      .from(costEntries)
      .where(and(eq(costEntries.companyId, ctx.companyId), eq(costEntries.projectId, projectId)))
      .groupBy(costEntries.kind);
    const totalCostCents = byKind.reduce((sum, r) => sum + r.cents, 0);
    const byAgent = await this.db
      .select({
        agentId: costEntries.agentId,
        cents: sql<number>`coalesce(sum(${costEntries.amountCents}), 0)::int`,
      })
      .from(costEntries)
      .where(
        and(
          eq(costEntries.companyId, ctx.companyId),
          eq(costEntries.projectId, projectId),
          isNotNull(costEntries.agentId),
        ),
      )
      .groupBy(costEntries.agentId)
      .orderBy(desc(sql`sum(${costEntries.amountCents})`))
      .limit(3);
    const agentNames = new Map<string, string>();
    for (const row of byAgent) {
      if (!row.agentId) continue;
      const [agent] = await this.db
        .select({ name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, row.agentId)));
      if (agent) agentNames.set(row.agentId, agent.name);
    }

    // ---- learnings: project-scope memories (12 §8), top by importance ----
    const learnings = await this.db
      .select({ title: memories.title, summary: memories.summary, importance: memories.importance })
      .from(memories)
      .where(
        and(
          eq(memories.companyId, ctx.companyId),
          eq(memories.scope, "project"),
          eq(memories.scopeRef, projectId),
          inArray(memories.status, ["active", "candidate"]),
        ),
      )
      .orderBy(desc(memories.importance))
      .limit(5);

    const cents = (n: number) => `${(n / 100).toFixed(2)} USD (${n}¢)`;
    const contentMd = [
      `# Executive report — ${project.name}`,
      ``,
      `## Outcome`,
      `Objective: ${project.objectiveMd}`,
      `Tasks: ${taskRows.length} total — ${count("DONE")} done, ${count("FAILED")} failed, ${count("CANCELLED")} cancelled.`,
      `Merged deliveries: ${merges[0]?.n ?? 0}.`,
      ``,
      `## Cost`,
      `Total spend: ${cents(totalCostCents)}.`,
      ...byKind.map((row) => `- ${row.kind}: ${cents(row.cents)}`),
      ...(byAgent.length
        ? [
            `Top spenders:`,
            ...byAgent.map(
              (row) => `- ${agentNames.get(row.agentId ?? "") ?? "platform"}: ${cents(row.cents)}`,
            ),
          ]
        : []),
      ``,
      `## Learnings`,
      ...(learnings.length
        ? learnings.map((m) => `- **${m.title}** (importance ${m.importance.toFixed(2)}) — ${m.summary}`)
        : [`_No consolidated project memories yet._`]),
      ``,
      `— Generated deterministically from the ledger and memory rows on project completion.`,
    ].join("\n");

    const summaryLine = `${project.name}: ${count("DONE")}/${taskRows.length} tasks done, total spend ${cents(totalCostCents)}, ${learnings.length} learnings captured.`;

    let ceoId: string | null = null;
    try {
      ceoId = (await this.projectsService.topExecutive(ctx)).id;
    } catch {
      /* a company without an executive still gets the artifact */
    }
    const artifactId = uuidv7();
    await this.db.transaction(async (tx) => {
      await tx.insert(artifacts).values({
        id: artifactId,
        companyId: ctx.companyId,
        projectId,
        kind: "executive_report",
        title: `Executive report — ${project.name}`,
        contentMd,
        createdByAgentId: ceoId,
      });
      await emitDomainEvent(tx, ctx, {
        type: "artifact.created",
        actor: ceoId ? { kind: "agent", id: ceoId } : { kind: "system", id: null },
        projectId,
        payload: { artifactId, kind: "executive_report" },
      });
      await emitDomainEvent(tx, ctx, {
        type: "project.completed",
        actor: { kind: "system", id: null },
        projectId,
        payload: { outcomeSummary: summaryLine.slice(0, 500), reportArtifactId: artifactId },
      });
      await emitDomainEvent(tx, ctx, {
        type: "report.published",
        actor: ceoId ? { kind: "agent", id: ceoId } : { kind: "system", id: null },
        projectId,
        payload: { artifactId, period: "project" },
      });
    });

    // the CEO's message to the Founder (29 step 24) — best effort: a company
    // without an executive still gets the artifact + events
    let messageId: string | null = null;
    if (ceoId) {
      const dm = await this.channelService.getOrCreateDm(ctx, ceoId, null);
      const plan = await this.messageService.send(ctx, {
        channelId: dm.id,
        senderAgentId: ceoId,
        kind: "status",
        body: `Executive report: ${summaryLine}`,
        refs: [
          { kind: "artifact", id: artifactId },
          { kind: "project" as const, id: projectId },
        ],
        idempotencyKey: uuidv7(),
      });
      messageId = plan.message.id;
    }
    return { artifactId, messageId, totalCostCents };
  }

  /** The task-terminal hook (rides the memory-trigger durable, T49). */
  async onTaskTerminal(ctx: CompanyContext, taskId: string): Promise<void> {
    const [task] = await this.db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
    if (!task?.projectId) return;
    const completed = await this.maybeCompleteProject(ctx, task.projectId);
    if (completed) await this.generateReport(ctx, task.projectId);
  }
}
