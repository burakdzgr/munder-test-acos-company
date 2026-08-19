// projectIntakeWorkflow (T42; 14 §3, 09 §2/§4): the intake-queue workflow.
// Sandboxed stages (ingest + analyzers) run as EXECUTION-queue activities on
// the execution worker; control-plane persistence (repo row, report
// artifact, routing) runs on this queue's own activities. Analyzer failures
// degrade their section and NEVER block the report (P6); ingest failure is a
// Founder-visible setup error.
import { proxyActivities } from "@temporalio/workflow";
import type {
  IntakeControlActivities,
  IngestSummary,
} from "../../intake/activities.js";

// The execution worker's intake activity surface (structural — the worker
// package cannot be imported across the dependency matrix).
interface IntakeExecutionActivities {
  ingestRepoActivity(input: {
    projectId: string;
    source: { kind: "git_url"; url: string } | { kind: "empty" };
  }): Promise<IngestSummary & { created: boolean }>;
  runIntakeAnalyzerActivity(input: {
    projectId: string;
    worktreeVolume: string;
    analyzerKey: string;
  }): Promise<{
    analyzer: string;
    title: string;
    ok: boolean;
    findings: unknown;
    error: string | null;
    durationMs: number;
  }>;
  destroyIntakeWorkspaceActivity(input: { projectId: string }): Promise<void>;
}

const execution = proxyActivities<IntakeExecutionActivities>({
  taskQueue: "execution",
  startToCloseTimeout: "5 minutes", // 14 §3.1 per-analyzer budget
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 2 }, // infra retry only; analyzer errors are results
});

const ingestExecution = proxyActivities<Pick<IntakeExecutionActivities, "ingestRepoActivity">>({
  taskQueue: "execution",
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "60 seconds",
  retry: { maximumAttempts: 2 },
});

const control = proxyActivities<IntakeControlActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});

// TASK 3: tam indeks büyük repoda dakikalar sürebilir — kendi bütçesi var
const indexControl = proxyActivities<
  Pick<IntakeControlActivities, "buildProjectCodeIndexActivity">
>({
  startToCloseTimeout: "10 minutes",
  retry: { maximumAttempts: 2 },
});

/** The MVP analyzer plan — keys mirror the execution worker's registry. */
export const INTAKE_ANALYZER_PLAN = [
  "repo_profile",
  "languages",
  "structure",
  "dependencies",
  "tests",
  "docs",
  "config_env",
  "security_smells",
  "code_graph",
] as const;

export interface ProjectIntakeInput {
  companyId: string;
  projectId: string;
  source: { kind: "git_url"; url: string } | { kind: "empty" };
}

export interface ProjectIntakeResult {
  outcome: "routed" | "ready";
  /** REVISION TASK 6: fail-closed consultation — false ise GOAL Founder onayı bekliyor */
  founderApproved?: boolean;
  reportArtifactId: string | null;
  goalTaskId: string | null;
  analyzersOk: number;
  analyzersFailed: number;
}

export async function projectIntakeWorkflow(
  input: ProjectIntakeInput,
): Promise<ProjectIntakeResult> {
  const project = await control.loadProjectActivity({
    companyId: input.companyId,
    projectId: input.projectId,
  });
  const lifecycle = (to: string) =>
    control.advanceProjectLifecycleActivity({
      companyId: input.companyId,
      projectId: input.projectId,
      to,
    });
  // TASK 2: repo kurulumu başlıyor
  await lifecycle("repository_setup");

  // ---- stage 1: ingest — the only stage whose failure fails the intake ----
  let ingest: IngestSummary & { created: boolean };
  try {
    ingest = await ingestExecution.ingestRepoActivity({
      projectId: input.projectId,
      source: input.source,
    });
  } catch (err) {
    await control.failIntakeActivity({
      companyId: input.companyId,
      projectId: input.projectId,
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  await control.recordIngestActivity({
    companyId: input.companyId,
    projectId: input.projectId,
    ingest,
    sourceRef: input.source.kind === "git_url" ? input.source.url : null,
  });
  // TASK 2: analiz + indeksleme aşaması
  await lifecycle("indexing");

  // TASK 6: greenfield repo bootstrap — deterministik başlangıç dosyaları +
  // initial commit + (bağlantı varsa) GitHub remote. Idempotent; import
  // edilen repoya dokunmaz.
  if (input.source.kind === "empty") {
    await control.bootstrapGreenfieldRepoActivity({
      companyId: input.companyId,
      projectId: input.projectId,
      name: project.name,
      objective: project.objective,
    });
  }

  // ---- stage 2: analyzer fan-out (imported repos only) — failures degrade ----
  const analyzers: Awaited<ReturnType<IntakeExecutionActivities["runIntakeAnalyzerActivity"]>>[] =
    [];
  if (ingest.worktreeVolume) {
    const results = await Promise.all(
      INTAKE_ANALYZER_PLAN.map((analyzerKey) =>
        execution
          .runIntakeAnalyzerActivity({
            projectId: input.projectId,
            worktreeVolume: ingest.worktreeVolume!,
            analyzerKey,
          })
          .catch((err: unknown) => ({
            analyzer: analyzerKey,
            title: analyzerKey,
            ok: false,
            findings: null,
            error: err instanceof Error ? err.message : String(err),
            durationMs: 0,
          })),
      ),
    );
    analyzers.push(...results);
    await execution
      .destroyIntakeWorkspaceActivity({ projectId: input.projectId })
      .catch(() => {});
  }

  // ---- stages 3+5: report + routing ----
  // B4: a project with NO repository used to get no report at all — the CEO
  // was routed a bare objective while an imported project got fifteen
  // sections. An idea deserves the same treatment: the repo-derived sections
  // say "no repository yet" and the interpretive pass writes the rest from
  // the objective.
  const greenfield = !ingest.worktreeVolume;
  const saved = await control.saveIntakeReportActivity({
    companyId: input.companyId,
    projectId: input.projectId,
    projectName: project.name,
    objective: project.objective,
    constraints: project.constraints,
    sourceRef: input.source.kind === "git_url" ? input.source.url : null,
    ingest,
    analyzers,
    ...(greenfield && { greenfield: true }),
  });
  const reportArtifactId: string | null = saved.artifactId;
  const summary = saved.summary;

  // ---- stage 4: memory seeding (14 §3.1 stage 4, previously T44) ----
  // Project-scope memories from analyzer findings enable agents to learn
  // codebase structure/patterns without repeatedly reading files. Degrades
  // gracefully (P6) — zero memories created on analyzer failure.
  await control
    .seedProjectMemoriesActivity({
      companyId: input.companyId,
      projectId: input.projectId,
      projectName: project.name,
      analyzers,
      reportSummary: summary,
    })
    .catch(() => {}); // failure is non-blocking; agents fall back to file reads

  // TASK 2/3 (INVARIANT 2): tam indeks TAMAMLANMADAN READY verilmez.
  // Aktivite retry'ları tükenirse intake failed'a düşer — sessiz degrade yok.
  try {
    await indexControl.buildProjectCodeIndexActivity({
      companyId: input.companyId,
      projectId: input.projectId,
    });
  } catch (err) {
    await control.failIntakeActivity({
      companyId: input.companyId,
      projectId: input.projectId,
      reason: `code index build failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  }
  await lifecycle("ready");

  // TASK 2: import edilen proje READY'de DURUR — otomatik kodlama yok.
  // Kullanıcı "Bu projede ne yapmak istiyorsun?" akışıyla hedef verir
  // (TASK 18); planlama o hedefle başlar.
  if (input.source.kind === "git_url") {
    return {
      outcome: "ready",
      founderApproved: false,
      reportArtifactId,
      goalTaskId: null,
      analyzersOk: analyzers.filter((a) => a.ok).length,
      analyzersFailed: analyzers.filter((a) => !a.ok).length,
    };
  }

  // Greenfield: objective zaten verildi — READY → PLANNING otomatik (TASK 2)
  await lifecycle("planning");

  // TASK 8: Requirement Analyzer — yapılandırılmış gereksinimler (degrade-safe)
  await control
    .analyzeRequirementsActivity({
      companyId: input.companyId,
      projectId: input.projectId,
      projectName: project.name,
      objective: project.objective,
      constraints: project.constraints,
    })
    .catch(() => null);

  // TASK 9: staffing gap + (gerekirse) Founder onayı + CEO start — sunucu
  // tarafında tek idempotent devam noktası. Eski "her hedefte Founder'a
  // danış" adımı kalktı (TASK 8: Founder'ı gereksiz bölme); Founder kapısı
  // artık yalnız kadro eksiğinde (hire onayı) devreye girer.
  const continuation = await control
    .continueProjectPlanningActivity({
      companyId: input.companyId,
      projectId: input.projectId,
    })
    .catch(() => ({ state: "planning" }));

  return {
    outcome: "routed",
    founderApproved: continuation.state === "executing",
    reportArtifactId,
    goalTaskId: null,
    analyzersOk: analyzers.filter((a) => a.ok).length,
    analyzersFailed: analyzers.filter((a) => !a.ok).length,
  };
}

/**
 * TASK 18 — imported READY projesine kullanıcı hedef verdiğinde koşan kısa
 * akış: Requirement Analyzer (TASK 8) + planning devamı (TASK 9). Intake
 * kuyruğunu ve aynı aktiviteleri paylaşır; resumable (TASK 19).
 */
export interface ProjectGoalInput {
  companyId: string;
  projectId: string;
  projectName: string;
  objective: string;
  constraints: string | null;
}

export async function projectGoalWorkflow(input: ProjectGoalInput): Promise<{ state: string }> {
  await control
    .analyzeRequirementsActivity({
      companyId: input.companyId,
      projectId: input.projectId,
      projectName: input.projectName,
      objective: input.objective,
      constraints: input.constraints,
    })
    .catch(() => null);
  const continuation = await control
    .continueProjectPlanningActivity({
      companyId: input.companyId,
      projectId: input.projectId,
    })
    .catch(() => ({ state: "planning" }));
  return { state: continuation.state };
}

