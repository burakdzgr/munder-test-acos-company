// Project runtime core (T42; 14 §1–4, _DECISIONS §19). Lives in @acos/db for
// the shared-single-implementation reason (task-engine pattern): the server's
// REST module and the intake workflow's activities persist through the SAME
// service — state machine guards, artifact rules and routing cannot diverge.
//
// Recorded deviations, bounded by the canonical schema (20 §6):
// - `projects` has no kind/desired_outcome/settings/health columns — kind is
//   derived from the repository row (origin_url null ⇒ greenfield), outcome
//   folds into objective_md, health lands with the dashboards (T49).
// - intake→active is performed by the routing step with FOUNDER authority
//   (the import command) rather than a CTO agent action (14 §1.2) — the CTO
//   grooming chain still runs as tasks.
import { and, desc, eq } from "drizzle-orm";
import { projectMachine, type ProjectStatus } from "@acos/domain";
import { parseEventPayload } from "@acos/events";
import { appendEvents, type EventActor, type NewEventInput, type Tx } from "./outbox.js";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { TasksService, TaskStateService } from "./task-engine.js";
import { agents, artifacts, positions, orgEdges, projects, repositories, tasks } from "./schema/index.js";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

export type ProjectRow = typeof projects.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;

const SYSTEM_ACTOR: EventActor = { kind: "system", id: null };

export class ProjectError extends Error {
  constructor(
    public readonly code:
      | "PROJECT_NOT_FOUND"
      | "PROJECT_SLUG_TAKEN"
      | "PROJECT_INVALID_TRANSITION"
      | "PROJECT_NO_EXECUTIVE"
      | "ARTIFACT_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

export function projectSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "project";
}

export interface CreateProjectInput {
  githubConnectionId?: string | null | undefined;
  name: string;
  objective: string;
  constraints?: string | undefined;
  createdByUserId: string;
  slug?: string | undefined;
}

export class ProjectsService {
  private readonly taskState: TaskStateService;
  private readonly tasksService: TasksService;

  constructor(private readonly db: GuardedDb) {
    this.taskState = new TaskStateService(db);
    this.tasksService = new TasksService(db);
  }

  /** Create (proposed) and immediately enter intake (14 §2) — one tx. */
  async create(ctx: CompanyContext, input: CreateProjectInput): Promise<ProjectRow> {
    const slug = input.slug ?? projectSlug(input.name);
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.companyId, ctx.companyId), eq(projects.slug, slug)))
        .limit(1);
      if (existing) throw new ProjectError("PROJECT_SLUG_TAKEN", `slug "${slug}" already in use`);
      const [row] = await tx
        .insert(projects)
        .values({
          companyId: ctx.companyId,
          slug,
          name: input.name,
          objectiveMd: input.objective,
          constraintsMd: input.constraints ?? null,
          status: "draft",
          githubConnectionId: input.githubConnectionId ?? null,
          createdByUserId: input.createdByUserId,
        })
        .returning();
      const refs = { projectId: row!.id };
      await emitDomainEvent(tx, ctx, {
        type: "project.created",
        actor: { kind: "founder", id: null },
        ...refs,
        payload: { projectId: row!.id, name: input.name, objective: input.objective },
      });
      await emitDomainEvent(tx, ctx, {
        type: "project.status.changed",
        actor: { kind: "founder", id: null },
        ...refs,
        payload: { from: "proposed", to: "intake", byActor: { kind: "founder", id: null } },
      });
      await emitDomainEvent(tx, ctx, {
        type: "project.intake.started",
        actor: { kind: "system", id: null },
        ...refs,
        payload: { projectId: row!.id, analysisPlan: [] },
      });
      return row!;
    });
  }

  async get(ctx: CompanyContext, projectId: string): Promise<ProjectRow> {
    const [row] = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, projectId)))
      .limit(1);
    if (!row) throw new ProjectError("PROJECT_NOT_FOUND", `project ${projectId} not found`);
    return row;
  }

  async list(ctx: CompanyContext): Promise<ProjectRow[]> {
    return this.db
      .select()
      .from(projects)
      .where(eq(projects.companyId, ctx.companyId))
      .orderBy(desc(projects.createdAt));
  }

  async repository(ctx: CompanyContext, projectId: string) {
    const [row] = await this.db
      .select()
      .from(repositories)
      .where(and(eq(repositories.companyId, ctx.companyId), eq(repositories.projectId, projectId)))
      .limit(1);
    return row ?? null;
  }

  /** Canonical machine guard (P5) + project.status.changed (+lifecycle events). */
  async transition(
    ctx: CompanyContext,
    projectId: string,
    to: ProjectStatus,
    actor: EventActor = SYSTEM_ACTOR,
  ): Promise<ProjectRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, projectId)))
        .for("update");
      if (!row) throw new ProjectError("PROJECT_NOT_FOUND", `project ${projectId} not found`);
      const from = row.status as ProjectStatus;
      if (!projectMachine.canTransition(from, to)) {
        throw new ProjectError(
          "PROJECT_INVALID_TRANSITION",
          `project ${projectId}: illegal ${from} → ${to}`,
        );
      }
      const [updated] = await tx
        .update(projects)
        .set({ status: to, ...(to === "archived" && { archivedAt: new Date() }) })
        .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, projectId)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "project.status.changed",
        actor,
        projectId,
        payload: { from, to, byActor: actor },
      });
      if (to === "archived") {
        await emitDomainEvent(tx, ctx, {
          type: "project.archived",
          actor,
          projectId,
          payload: { reason: "archived" },
        });
      }
      return updated!;
    });
  }

  /** Stage-1 bookkeeping: repositories row + project.imported (idempotent). */
  async recordIngest(
    ctx: CompanyContext,
    projectId: string,
    ingest: {
      barePath: string;
      defaultBranch: string;
      sourceRef: string | null;
    },
  ) {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(repositories)
        .where(and(eq(repositories.companyId, ctx.companyId), eq(repositories.projectId, projectId)))
        .limit(1);
      if (existing) return existing;
      const [row] = await tx
        .insert(repositories)
        .values({
          companyId: ctx.companyId,
          projectId,
          name: "origin",
          barePath: ingest.barePath,
          defaultBranch: ingest.defaultBranch,
          originUrl: ingest.sourceRef,
          ...(ingest.sourceRef && { importedAt: new Date() }),
        })
        .returning();
      if (ingest.sourceRef) {
        await emitDomainEvent(tx, ctx, {
          type: "project.imported",
          actor: SYSTEM_ACTOR,
          projectId,
          payload: { projectId, sourceRef: ingest.sourceRef, repoPath: ingest.barePath },
        });
      }
      return row!;
    });
  }

  /** P6: exactly one versioned Intake Report artifact, even degraded runs. */
  /** TASK 8: Requirement Analyzer çıktısı — JSON, artifacts(kind=document). */
  async saveRequirementAnalysis(
    ctx: CompanyContext,
    projectId: string,
    analysis: Record<string, unknown>,
  ): Promise<ArtifactRow> {
    return this.db.transaction(async (tx) => {
      const [artifact] = await tx
        .insert(artifacts)
        .values({
          companyId: ctx.companyId,
          projectId,
          kind: "document",
          title: "Requirement Analysis",
          contentMd: JSON.stringify(analysis, null, 2),
          meta: { type: "requirement_analysis" },
        })
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "artifact.created",
        actor: SYSTEM_ACTOR,
        projectId,
        payload: { artifactId: artifact!.id, kind: "document" },
      });
      return artifact!;
    });
  }

  async saveIntakeReport(
    ctx: CompanyContext,
    projectId: string,
    input: { title: string; markdown: string; meta?: Record<string, unknown> | undefined },
  ): Promise<ArtifactRow> {
    return this.db.transaction(async (tx) => {
      const [project] = await tx
        .select()
        .from(projects)
        .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, projectId)))
        .for("update");
      if (!project) throw new ProjectError("PROJECT_NOT_FOUND", `project ${projectId} not found`);
      if (project.intakeReportArtifactId) {
        const [existing] = await tx
          .select()
          .from(artifacts)
          .where(
            and(
              eq(artifacts.companyId, ctx.companyId),
              eq(artifacts.id, project.intakeReportArtifactId),
            ),
          );
        if (existing) return existing; // idempotent replay
      }
      const [artifact] = await tx
        .insert(artifacts)
        .values({
          companyId: ctx.companyId,
          projectId,
          kind: "intake_report",
          title: input.title,
          contentMd: input.markdown,
          meta: input.meta ?? {},
        })
        .returning();
      await tx
        .update(projects)
        .set({ intakeReportArtifactId: artifact!.id })
        .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, projectId)));
      await emitDomainEvent(tx, ctx, {
        type: "artifact.created",
        actor: SYSTEM_ACTOR,
        projectId,
        payload: { artifactId: artifact!.id, kind: "intake_report" },
      });
      return artifact!;
    });
  }

  async artifact(ctx: CompanyContext, artifactId: string): Promise<ArtifactRow> {
    const [row] = await this.db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.companyId, ctx.companyId), eq(artifacts.id, artifactId)))
      .limit(1);
    if (!row) throw new ProjectError("ARTIFACT_NOT_FOUND", `artifact ${artifactId} not found`);
    return row;
  }

  /**
   * The top executive: default_role=executive with no active reports_to.
   *
   * `positionTitle` rides along because the caller almost always needs it and
   * the join is already here — the Founder-facing surfaces have to say *what*
   * this person is ("CEO"), not just who.
   */
  async topExecutive(
    ctx: CompanyContext,
  ): Promise<{ id: string; name: string; positionTitle: string }> {
    const rows = await this.db
      .select({
        id: agents.id,
        name: agents.name,
        employeeNumber: agents.employeeNumber,
        positionTitle: positions.title,
      })
      .from(agents)
      .innerJoin(positions, eq(agents.positionId, positions.id))
      .where(
        and(
          eq(agents.companyId, ctx.companyId),
          eq(agents.status, "active"),
          eq(positions.defaultRole, "executive"),
        ),
      );
    for (const row of rows.sort((a, b) => a.employeeNumber - b.employeeNumber)) {
      const [managed] = await this.db
        .select({ id: orgEdges.id })
        .from(orgEdges)
        .where(
          and(
            eq(orgEdges.companyId, ctx.companyId),
            eq(orgEdges.fromAgentId, row.id),
            eq(orgEdges.kind, "reports_to"),
          ),
        )
        .limit(1);
      if (!managed) return { id: row.id, name: row.name, positionTitle: row.positionTitle };
    }
    throw new ProjectError("PROJECT_NO_EXECUTIVE", "no active top executive to route intake to");
  }

  /**
   * Stage 5 (14 §3.4): GOAL task → the top executive, report attached; the
   * delegation cascade (CEO→CTO→leads) runs as normal agent loops. Acts with
   * FOUNDER authority — the import command is the authorization (recorded).
   * Idempotent per project (one routed GOAL).
   */
  async routeIntake(
    ctx: CompanyContext,
    projectId: string,
    input: {
      objective: string;
      reportArtifactId: string | null;
      findingsSummary: string;
      budgetCents?: number | undefined;
    },
  ): Promise<{ goalTaskId: string; ceoAgentId: string; created: boolean }> {
    const ceo = await this.topExecutive(ctx);
    // P1-1 (2026-08-19): idempotanlık ANAHTARI (proje) değil, (proje, hedef
    // metni). Eskiden proje başına TEK goal görevi vardı ve ikinci Founder
    // hedefi sessizce BİRİNCİYİ geri döndürüyordu — yeni iş hiç doğmuyor,
    // çağıran taraf "routed" sanıyordu (golden path stage 14'ün ikinci yarısı).
    // Retry replay'i (INVARIANT 15) korunur: aynı hedef metniyle yeniden giriş
    // aynı görevi döndürür; GERÇEKTEN yeni bir hedef yeni GOAL ağacı açar.
    const [existingGoal] = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, ctx.companyId),
          eq(tasks.projectId, projectId),
          eq(tasks.kind, "goal"),
          eq(tasks.objective, input.objective),
        ),
      )
      .orderBy(desc(tasks.createdAt))
      .limit(1);
    if (existingGoal) {
      return { goalTaskId: existingGoal.id, ceoAgentId: ceo.id, created: false };
    }

    const founder = { kind: "founder" } as const;
    const goal = await this.tasksService.create(
      ctx,
      {
        kind: "goal",
        title: `Deliver: ${input.objective.slice(0, 140)}`,
        objective: input.objective,
        projectId,
        priority: "P1",
        ...(input.budgetCents !== undefined && { budgetCents: input.budgetCents }),
        context: {
          ...(input.reportArtifactId && { artifactIds: [input.reportArtifactId] }),
          intake: true,
        },
      },
      founder,
    );
    await this.taskState.transition(ctx, goal.id, "BACKLOG", founder);
    await this.taskState.transition(ctx, goal.id, "PLANNED", founder);
    // CEO diyaloğu (T48): GOAL PLANNED'da bekleyecek; Founder onayı sonrası CEO'ya assign
    // (await this.taskState.assign() şimdilik ertelendi — ceoConsultFounder ile devam edilecek)

    await this.db.transaction(async (tx) => {
      await emitDomainEvent(tx, ctx, {
        type: "project.analysis.completed",
        actor: SYSTEM_ACTOR,
        projectId,
        taskId: goal.id,
        payload: {
          ...(input.reportArtifactId && { intakeReportArtifactId: input.reportArtifactId }),
          findingsSummary: input.findingsSummary.slice(0, 500),
          routedTaskIds: [goal.id],
        },
      });
    });
    // Yaşam döngüsünü workflow yönetir (TASK 2): planning→executing geçişi
    // consult sonucuna göre intake workflow'unda yapılır.
    return { goalTaskId: goal.id, ceoAgentId: ceo.id, created: true };
  }
}
