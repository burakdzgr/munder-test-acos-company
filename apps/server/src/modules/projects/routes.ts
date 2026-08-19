// Projects REST surface (T42; 14 §2, 21 §3): create (greenfield or git-URL
// import — the 3-field Founder contract, P4), list, detail, intake report.
// Creation starts projectIntakeWorkflow post-commit (best-effort port; the
// project row is durable either way and the Founder can re-import).
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ArtifactDtoSchema,
  CreateProjectRequestSchema,
  ProjectDtoSchema,
  ProjectListResponseSchema,
} from "@acos/contracts";
import {
  companyContext,
  ProjectError,
  ProjectsService,
  TaskStateService,
  type CompanyContext,
  type GuardedDb,
  type ProjectRow,
} from "@acos/db";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";

export type IntakeStarter = (input: {
  companyId: string;
  projectId: string;
  source: { kind: "git_url"; url: string } | { kind: "empty" };
}) => Promise<void>;

export interface ProjectRoutesDeps {
  guardedDb: () => GuardedDb;
  companiesSvc: () => CompanyService;
  intakeStarter: () => IntakeStarter | null;
  /** TASK 18: hedef → analiz+planlama akışı (main.ts bağlar). */
  goalStarter?: () =>
    | ((input: {
        companyId: string;
        projectId: string;
        projectName: string;
        objective: string;
        constraints: string | null;
      }) => Promise<void>)
    | null;
  /** TASK 18: package.json scripts okumak için sandbox erişimi. */
  sandbox?: () => { url: string; token: string } | null;
}

const ParamsSchema = z.object({ companyId: z.uuid() });
const ProjectParamsSchema = z.object({ companyId: z.uuid(), projectId: z.uuid() });

export async function registerProjectRoutes(
  app: FastifyInstance,
  deps: ProjectRoutesDeps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const service = () => new ProjectsService(deps.guardedDb());

  async function requireMember(userId: string, companyId: string): Promise<void> {
    const role = await deps.companiesSvc().membership(userId, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
  }

  async function toDto(ctx: CompanyContext, row: ProjectRow) {
    const repo = await service().repository(ctx, row.id);
    return ProjectDtoSchema.parse({
      id: row.id,
      slug: row.slug,
      name: row.name,
      objective: row.objectiveMd,
      constraints: row.constraintsMd,
      status: row.status,
      githubConnectionId: row.githubConnectionId ?? null,
      indexState: row.indexState ?? "none",
      indexCommitSha: row.indexCommitSha ?? null,
      headSha: row.headSha ?? null,
      intakeReportArtifactId: row.intakeReportArtifactId,
      createdAt: row.createdAt.toISOString(),
      kind: repo?.originUrl ? "imported" : "greenfield",
      repository: repo
        ? {
            barePath: repo.barePath,
            defaultBranch: repo.defaultBranch,
            originUrl: repo.originUrl,
          }
        : null,
    });
  }

  typed.get(
    "/api/v1/companies/:companyId/projects",
    {
      schema: {
        params: ParamsSchema,
        response: { 200: ProjectListResponseSchema },
        tags: ["projects"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      const rows = await service().list(ctx);
      return { items: await Promise.all(rows.map((r) => toDto(ctx, r))) };
    },
  );

  typed.post(
    "/api/v1/companies/:companyId/projects",
    {
      schema: {
        params: ParamsSchema,
        body: CreateProjectRequestSchema,
        response: { 201: ProjectDtoSchema },
        tags: ["projects"],
      },
    },
    async (request, reply) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      let row: ProjectRow;
      try {
        row = await service().create(ctx, {
          name: request.body.name,
          objective: request.body.objective,
          constraints: request.body.constraints,
          githubConnectionId: request.body.githubConnectionId ?? null,
          createdByUserId: user.id,
        });
      } catch (err) {
        if (err instanceof ProjectError && err.code === "PROJECT_SLUG_TAKEN") {
          throw new ApiError("conflict", err.message);
        }
        throw err;
      }
      // post-commit: intake workflow (14 §2) — durable rows stay either way
      const starter = deps.intakeStarter();
      if (starter) {
        await starter({
          companyId,
          projectId: row.id,
          source: request.body.source ?? { kind: "empty" },
        }).catch((err) => request.log.warn({ err }, "projectIntakeWorkflow start failed"));
      }
      return reply.status(201).send(await toDto(ctx, row));
    },
  );

  /**
   * "Rafa kaldır" (Founder UX, 2026-08-19): proje kapanır, TÜM görevleri
   * yasal geçişlerle iptal edilip arşivlenir. SİLME YOK — olaylar ve o
   * görevlerden doğan anılar kalır; başka projede "daha önce böyle bir şey
   * yapmıştık" diyebilmenin güvencesi budur.
   */
  typed.post(
    "/api/v1/companies/:companyId/projects/:projectId/shelve",
    {
      schema: { params: ProjectParamsSchema, tags: ["projects"], hide: true },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, projectId } = request.params;
      const role = await deps.companiesSvc().membership(user.id, companyId);
      if (!role) throw new ApiError("not_found", "company not found");
      if (role !== "founder") {
        throw new ApiError("forbidden", "projeyi yalnız Founder rafa kaldırır");
      }
      const ctx = companyContext(companyId);
      const project = await service().get(ctx, projectId); // 404 üretir
      const shelved = await new TaskStateService(deps.guardedDb()).shelve(ctx, { projectId });
      // proje durumu: aktif/duraklatılmış → archived; henüz başlamamış → cancelled
      let projectStatus = project.status;
      const ARCHIVABLE = ["active", "paused", "executing"];
      const CANCELABLE = [
        "proposed",
        "intake",
        "draft",
        "repository_setup",
        "indexing",
        "ready",
        "planning",
        "staffing_review",
        "waiting_for_founder",
        "failed",
      ];
      const target = ARCHIVABLE.includes(project.status)
        ? ("archived" as const)
        : CANCELABLE.includes(project.status)
          ? ("cancelled" as const)
          : null;
      if (target) {
        const updated = await service().transition(ctx, projectId, target, {
          kind: "founder",
          id: user.id,
        });
        projectStatus = updated.status;
      }
      return { projectId, projectStatus, ...shelved };
    },
  );

  /**
   * TASK 18 — Project Understanding: structured index verisinden render,
   * uzun LLM raporu YOK. Repo/stack/modüller/komutlar/index durumu.
   */
  typed.get(
    "/api/v1/companies/:companyId/projects/:projectId/understanding",
    { schema: { params: ProjectParamsSchema, tags: ["projects"], hide: true } },
    async (request) => {
      const user = request.requireUser();
      const { companyId, projectId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      const db = deps.guardedDb();
      const project = await service().get(ctx, projectId);
      const repo = await service().repository(ctx, projectId);

      const { sql } = await import("drizzle-orm");
      const langRows = (
        await db.execute(sql`
          SELECT language, count(*)::int AS n FROM code_files
          WHERE company_id = ${ctx.companyId} AND project_id = ${projectId}
            AND overlay_ref IS NULL
          GROUP BY language ORDER BY n DESC LIMIT 8
        `)
      ).rows as Array<{ language: string; n: number }>;
      const moduleRows = (
        await db.execute(sql`
          SELECT split_part(path, '/', 1) AS module, count(*)::int AS files
          FROM code_files
          WHERE company_id = ${ctx.companyId} AND project_id = ${projectId}
            AND overlay_ref IS NULL
          GROUP BY 1 ORDER BY files DESC LIMIT 10
        `)
      ).rows as Array<{ module: string; files: number }>;
      const counts = (
        await db.execute(sql`
          SELECT
            (SELECT count(*)::int FROM code_files WHERE company_id = ${ctx.companyId} AND project_id = ${projectId} AND overlay_ref IS NULL) AS files,
            (SELECT count(*)::int FROM code_symbols WHERE company_id = ${ctx.companyId} AND project_id = ${projectId}) AS symbols,
            (SELECT count(*)::int FROM code_edges WHERE company_id = ${ctx.companyId} AND project_id = ${projectId}) AS edges
        `)
      ).rows[0] as { files: number; symbols: number; edges: number };

      // run/test komutları: package.json scripts (deterministik; yoksa boş)
      let commands: Record<string, string> = {};
      const sandbox = deps.sandbox?.();
      if (sandbox) {
        try {
          const res = await fetch(`${sandbox.url}/internal/v1/repos/code-snapshot`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${sandbox.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ projectId, paths: ["package.json"] }),
          });
          if (res.ok) {
            const snap = (await res.json()) as {
              files: Array<{ path: string; contentBase64: string }>;
            };
            const pkg = snap.files.find((f) => f.path === "package.json");
            if (pkg) {
              const parsed = JSON.parse(
                Buffer.from(pkg.contentBase64, "base64").toString("utf8"),
              ) as { scripts?: Record<string, string> };
              commands = parsed.scripts ?? {};
            }
          }
        } catch {
          /* komutlar opsiyonel */
        }
      }

      return {
        repository: repo
          ? { originUrl: repo.originUrl, defaultBranch: repo.defaultBranch }
          : null,
        headSha: project.headSha ?? null,
        indexState: project.indexState ?? "none",
        indexCommitSha: project.indexCommitSha ?? null,
        stack: langRows.map((r) => ({ language: r.language, files: Number(r.n) })),
        modules: moduleRows.map((r) => ({ module: r.module, files: Number(r.files) })),
        index: {
          files: Number(counts.files),
          symbols: Number(counts.symbols),
          edges: Number(counts.edges),
        },
        commands,
      };
    },
  );

  /** TASK 20 — Founder proje durumu: tek uçta yaşam döngüsü + indeks +
   *  kadro + görev kuyruğu + workspaces + onaylar + maliyet + son mergeler. */
  typed.get(
    "/api/v1/companies/:companyId/projects/:projectId/overview",
    { schema: { params: ProjectParamsSchema, tags: ["projects"], hide: true } },
    async (request) => {
      const user = request.requireUser();
      const { companyId, projectId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      const db = deps.guardedDb();
      const project = await service().get(ctx, projectId);
      const { sql } = await import("drizzle-orm");

      const members = (
        await db.execute(sql`
          SELECT a.id, a.name, a.status, u.name AS team,
            (SELECT t.title FROM tasks t
              WHERE t.company_id = ${ctx.companyId} AND t.owner_agent_id = a.id
                AND t.project_id = ${projectId} AND t.status IN ('IN_PROGRESS','REVIEW','WAITING','BLOCKED')
              ORDER BY t.created_at DESC LIMIT 1) AS current_task
          FROM project_members pm
          JOIN agents a ON a.id = pm.agent_id
          LEFT JOIN org_units u ON u.id = a.org_unit_id
          WHERE pm.company_id = ${ctx.companyId} AND pm.project_id = ${projectId}
            AND pm.removed_at IS NULL
          ORDER BY a.employee_number
        `)
      ).rows;

      const taskCounts = (
        await db.execute(sql`
          SELECT status, count(*)::int AS n FROM tasks
          WHERE company_id = ${ctx.companyId} AND project_id = ${projectId}
            AND archived_at IS NULL
          GROUP BY status
        `)
      ).rows;

      const workspacesRows = (
        await db.execute(sql`
          SELECT id, branch, status, task_id FROM workspaces
          WHERE company_id = ${ctx.companyId} AND project_id = ${projectId}
            AND status NOT IN ('destroyed','discarded')
          ORDER BY created_at DESC LIMIT 10
        `)
      ).rows;

      const approvals = (
        await db.execute(sql`
          SELECT ap.id, ap.title, ap.kind, ap.urgency FROM approvals ap
          JOIN tasks t ON t.id = ap.task_id
          WHERE ap.company_id = ${ctx.companyId} AND t.project_id = ${projectId}
            AND ap.status = 'pending'
          ORDER BY ap.created_at DESC LIMIT 10
        `)
      ).rows;

      const cost = (
        await db.execute(sql`
          SELECT coalesce(sum(ce.amount_cents), 0)::bigint AS cents
          FROM cost_entries ce
          JOIN tasks t ON t.id = ce.task_id
          WHERE ce.company_id = ${ctx.companyId} AND t.project_id = ${projectId}
        `)
      ).rows[0] as { cents: string | number };

      const merges = (
        await db.execute(sql`
          SELECT e.occurred_at, e.payload FROM events e
          WHERE e.company_id = ${ctx.companyId}
            AND e.type IN ('workspace.merged','task.status.changed')
            AND e.project_id = ${projectId}
            AND (e.type = 'workspace.merged' OR e.payload->>'to' = 'DONE')
          ORDER BY e.occurred_at DESC LIMIT 5
        `)
      ).rows;

      const ports = (
        await db.execute(sql`
          SELECT DISTINCT ON (e.payload->>'port') e.payload, e.occurred_at
          FROM events e
          JOIN tasks t ON t.id = e.task_id
          WHERE e.company_id = ${ctx.companyId} AND e.type = 'workspace.port.opened'
            AND t.project_id = ${projectId}
          ORDER BY e.payload->>'port', e.occurred_at DESC
          LIMIT 10
        `)
      ).rows;

      const memoryHealth = (
        await db.execute(sql`
          SELECT count(*)::int AS n FROM memories
          WHERE company_id = ${ctx.companyId} AND scope = 'project'
            AND scope_ref = ${projectId} AND status = 'active'
        `)
      ).rows[0] as { n: number };

      return {
        lifecycle: project.status,
        headSha: project.headSha ?? null,
        indexState: project.indexState ?? "none",
        indexCommitSha: project.indexCommitSha ?? null,
        members,
        taskCounts,
        workspaces: workspacesRows,
        approvals,
        costCents: Number(cost.cents),
        recentMerges: merges,
        openPorts: ports,
        memoryHealth: { activeProjectMemories: Number(memoryHealth.n) },
      };
    },
  );

  /**
   * TASK 18 — "Bu projede ne yapmak istiyorsun?": kullanıcı isteği yeni GOAL
   * olur, Requirement Analyzer + CEO planning pipeline'ına girer.
   */
  typed.post(
    "/api/v1/companies/:companyId/projects/:projectId/goal",
    {
      schema: {
        params: ProjectParamsSchema,
        body: z.object({ objective: z.string().min(8).max(4000) }),
        tags: ["projects"],
        hide: true,
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, projectId } = request.params;
      const role = await deps.companiesSvc().membership(user.id, companyId);
      if (!role) throw new ApiError("not_found", "company not found");
      if (role !== "founder") throw new ApiError("forbidden", "hedefi yalnız Founder verir");
      const ctx = companyContext(companyId);
      const project = await service().get(ctx, projectId);
      // P1-1 (2026-08-19, Founder onaylı): hedef vermek TEK SEFERLİK bir olay
      // değil — şirket yaşayan bir şeydir, Founder ilk döngü koşarken de
      // sonrasında da yeni hedef verir. Eski kapı yalnız planlama-öncesi
      // durumlara izin veriyordu; ilk hedef projeyi `executing`'e kilitleyince
      // İKİNCİ hedef 409 alıyordu (golden path stage 14, kanıt 5fbdb3e:
      // "proje executing durumunda — hedef READY'de verilir"). Artık proje
      // çalışırken/duraklatılmışken de hedef kabul edilir: yeni GOAL ağacı
      // açılır, proje durumu OLDUĞU GİBİ kalır (executing→executing; state
      // machine'e yeni kenar eklenmez). Reddedilenler yalnız gerçekten hedef
      // alamayacak durumlar: henüz indekslenmemiş (draft/repository_setup/
      // indexing) ve kapanmış (completed/archived/cancelled/failed) projeler.
      const GOAL_ACCEPTING = [
        "ready",
        "planning",
        "staffing_review",
        "waiting_for_founder",
        "executing",
        "paused",
        "active", // miras durum (eski kayıtlar)
      ];
      if (!GOAL_ACCEPTING.includes(project.status)) {
        const why = ["draft", "repository_setup", "indexing"].includes(project.status)
          ? "proje henüz indekslenmedi — READY olunca hedef verilir"
          : `proje ${project.status} durumunda — hedef alamaz`;
        throw new ApiError("conflict", why);
      }
      const db = deps.guardedDb();
      const { projects: projectsTable } = await import("@acos/db/schema");
      const { and, eq } = await import("drizzle-orm");
      await db
        .update(projectsTable)
        .set({ objectiveMd: request.body.objective })
        .where(and(eq(projectsTable.companyId, ctx.companyId), eq(projectsTable.id, projectId)));
      // READY → PLANNING yalnız ilk girişte; koşan bir projede hedef eklemek
      // durumu geri sarmaz (executing/paused olduğu yerde kalır).
      if (project.status === "ready") {
        await service().transition(ctx, projectId, "planning", { kind: "founder", id: user.id });
      }
      const starter = deps.goalStarter?.();
      if (starter) {
        await starter({
          companyId,
          projectId,
          projectName: project.name,
          objective: request.body.objective,
          constraints: project.constraintsMd,
        });
        return { started: true, state: project.status === "ready" ? "planning" : project.status };
      }
      return { started: false, state: project.status };
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/projects/:projectId",
    {
      schema: {
        params: ProjectParamsSchema,
        response: { 200: ProjectDtoSchema },
        tags: ["projects"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, projectId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      try {
        return await toDto(ctx, await service().get(ctx, projectId));
      } catch (err) {
        if (err instanceof ProjectError && err.code === "PROJECT_NOT_FOUND") {
          throw new ApiError("not_found", err.message);
        }
        throw err;
      }
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/projects/:projectId/report",
    {
      schema: {
        params: ProjectParamsSchema,
        response: { 200: ArtifactDtoSchema },
        tags: ["projects"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, projectId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      const project = await service()
        .get(ctx, projectId)
        .catch(() => {
          throw new ApiError("not_found", "project not found");
        });
      if (!project.intakeReportArtifactId) {
        throw new ApiError("not_found", "no intake report for this project");
      }
      const artifact = await service().artifact(ctx, project.intakeReportArtifactId);
      return ArtifactDtoSchema.parse({
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
        contentMd: artifact.contentMd,
        createdAt: artifact.createdAt.toISOString(),
        meta: artifact.meta,
      });
    },
  );
}
