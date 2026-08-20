// agentTaskWorkflow activities (08 §3, T32). All IO of the loop lives here;
// the workflow only orchestrates. Effects are exactly-once at the DB via
// stepId-derived idempotency keys (08 §11). Task transitions go through the
// ONE status writer (TaskStateService — @acos/db/task-engine).
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { uuidv5 } from "@acos/domain";
import { parseEventPayload } from "@acos/events";
import {
  ApprovalsService,
  ChannelService,
  CostService,
  MemoryRetrievalService,
  MessageService,
  TasksService,
  TaskStateService,
  appendEvents,
  companyContext,
  recordLlmCall,
  deliverMessage,
  type CompanyContext,
  type GuardedDb,
  type InboxItem,
  type NewEventInput,
  type SignalPort,
  type Tx,
} from "@acos/db";
import {
  agentModelBindings,
  agentSessions,
  agentSteps,
  agents,
  approvals as approvalsTable,
  artifacts as artifactsTable,
  companySettings,
  environments,
  modelProfiles,
  notifications,
  orgEdges,
  positions,
  projects,
  repositories,
  tasks,
} from "@acos/db/schema";
import { outputLanguageDirective } from "@acos/llm";
import type { ModelRouter, RoutingContext, LlmMessage, LlmUsage } from "@acos/llm";
import { CONTEXT_SENTINEL_UUID, SELF_SENTINEL_UUID, type AgentAction } from "@acos/llm/agent-action";
import { FENCE_PREAMBLE, provenanceFence } from "@acos/tools";
import { heartbeat } from "@temporalio/activity";
import {
  createActionDispatcher,
  makeRuntimeEmitter,
  startOperationHeartbeat,
  type RuntimeEventPort,
} from "@acos/agent-actions";
// mapToolCall taşındı ama bu modülden dışa açık kalıyor: mevcut testler onu
// buradan import ediyor ve TAŞIMA davranışı değiştirmemeli.
export { mapToolCall } from "@acos/agent-actions";
import {
  contextBudgetForRole,
  estimateTokens,
  type WorkingSetTelemetry,
} from "./context-budget.js";

/**
 * 08 §12 satır 1: LLM sınıfı aktivitenin Temporal heartbeat'i — dokümanda
 * şart, kodda hiç yazılmamıştı. rt `op.heartbeat` UI içindir; BU heartbeat
 * Temporal'a canlılık kanıtıdır: workflow tarafındaki llmActivity proxy'si
 * (heartbeatTimeout 60s) ölü worker'ı hızla yeniden planlarken yavaş-ama-canlı
 * köprü çağrısını kesmez. Aktivite bağlamı dışında (birim test, doğrudan
 * çağrı) heartbeat throw eder; sessizce geçilir.
 */
export function startTemporalHeartbeat(detail: string, intervalMs = 10_000): () => void {
  const beat = () => {
    try {
      heartbeat(detail);
    } catch {
      /* aktivite bağlamı dışında — test/doğrudan çağrı */
    }
  };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}


export interface AgentTaskActivityDeps {
  guardedDb: GuardedDb;
  router: ModelRouter;
  /** RoutingContext loader — DB bindings/profiles in prod, fixed in scripted mode. */
  routingFor(ctx: CompanyContext, agentId: string): Promise<RoutingContext>;
  /** Post-commit message delivery transport (11 §4.4); absent in narrow tests. */
  signalPort?: SignalPort | undefined;
  /** Assignment → workflow start (09 §4 trigger, T36): after a successful
   *  delegation the child owner's agentTaskWorkflow starts. Best-effort —
   *  REJECT_DUPLICATE double-starts are swallowed by the implementation. */
  startAgentWorkflow?: ((input: { companyId: string; agentId: string; taskId: string }) => Promise<void>) | undefined;
  /** use_tool → Tool Gateway internal HTTP (17 §4, T40). Absent in narrow
   *  scripted tests: the pre-T40 stub observation is preserved so guard and
   *  loop suites stay deterministic without a gateway. */
  invokeTool?:
    | ((req: {
        companyId: string;
        agentId: string;
        taskId: string;
        agentSessionId?: string | undefined;
        toolName: string;
        input: unknown;
        idempotencyKey: string;
      }) => Promise<{
        invocationId: string | null;
        decision: string;
        status: string;
        reason: string | null;
        output?: unknown;
        error?: string | undefined;
        costCents?: number | undefined;
        retryAfterSec?: number | undefined;
      }>)
    | undefined;
  /** TASK 13: Context Compiler'ın CodeIndex sorgusu (server internal). */
  codeIndexQuery?:
    | ((input: {
        companyId: string;
        projectId: string;
        taskId: string;
        terms: string[];
      }) => Promise<{
        indexState: string;
        stale: boolean;
        symbols: Array<{
          path: string;
          name: string;
          kind: string;
          startLine: number;
          endLine: number;
          layer: string;
        }>;
        relations: Array<{ kind: string; fromPath: string; symbolName: string | null }>;
      }>)
    | undefined;
  /** LIVE-CONSOLE TASK 2/3: canlı lifecycle olay yayıncısı (rt.* ephemeral
   *  NATS). Yoksa (dar testler) tüm emit'ler sessiz no-op. */
  runtimeEvents?: RuntimeEventPort | undefined;
  /** request_review → independent reviewer's reviewWorkflow start (T43). */
  startReviewWorkflow?:
    | ((input: {
        companyId: string;
        reviewId: string;
        taskId: string;
        reviewerAgentId: string;
        authorAgentId: string;
      }) => Promise<void>)
    | undefined;
}

export interface SessionRef {
  companyId: string;
  agentId: string;
  taskId: string;
  sessionId: string;
}

export interface WorkingSet {
  messages: LlmMessage[];
  digest: string;
  /** TASK 7 — bölüm bazlı token tahmini; llm_calls.context_telemetry'ye yazılır. */
  telemetry: WorkingSetTelemetry;
}

export interface ModelCallResult {
  text: string;
  usage: LlmUsage;
  model: string;
  costCents: number;
  latencyMs: number;
}

function fnvDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function createAgentTaskActivities(deps: AgentTaskActivityDeps) {
  const { guardedDb } = deps;
  const taskState = new TaskStateService(guardedDb);
  const channelService = new ChannelService(guardedDb);
  const messageService = new MessageService(guardedDb, channelService);
  const tasksService = new TasksService(guardedDb);
  const costService = new CostService(guardedDb);
  const approvalsService = new ApprovalsService(guardedDb);
  const retrievalService = new MemoryRetrievalService(guardedDb);

  /** LIVE-CONSOLE TASK 2: canlı lifecycle olayı — fire-and-forget, asla
   *  döngüyü etkilemez (yayıncı yoksa no-op). Yayıncı @acos/agent-actions ile
   *  ORTAK: dağıtıcı ile aktivitelerin rt.* şekli ayrışamaz. */
  const rt = makeRuntimeEmitter(deps.runtimeEvents);

  /** Eylem dağıtıcısı ORTAK EVDE (@acos/agent-actions): worker aktivitesi de,
   *  MCP sunucusu da aynı fonksiyonu çağırır — görev durumunun tek yazarı
   *  kalır (INV-13). Buradaki aktivite artık ince bir kabuktur. */
  const actionDispatcher = createActionDispatcher({
    guardedDb,
    ...(deps.signalPort !== undefined && { signalPort: deps.signalPort }),
    ...(deps.startAgentWorkflow !== undefined && { startAgentWorkflow: deps.startAgentWorkflow }),
    ...(deps.invokeTool !== undefined && { invokeTool: deps.invokeTool }),
    ...(deps.runtimeEvents !== undefined && { runtimeEvents: deps.runtimeEvents }),
    ...(deps.startReviewWorkflow !== undefined && { startReviewWorkflow: deps.startReviewWorkflow }),
  });


  return {
    /** 08 §1: mark the pre-created session running; task started + presence. */
    async startAgentSessionActivity(input: SessionRef & {
      workflowId: string;
      runId: string;
      attempt: number;
    }): Promise<void> {
      const ctx = companyContext(input.companyId);
      await guardedDb.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: agentSessions.id, status: agentSessions.status })
          .from(agentSessions)
          .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)));
        if (existing?.status === "running") return; // idempotent retry
        if (existing) {
          await tx
            .update(agentSessions)
            .set({ status: "running", currentActivity: "WORKING", workflowId: input.workflowId, runId: input.runId })
            .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)));
        } else {
          await tx.insert(agentSessions).values({
            id: input.sessionId,
            companyId: ctx.companyId,
            agentId: input.agentId,
            taskId: input.taskId,
            workflowId: input.workflowId,
            runId: input.runId,
            status: "running",
            currentActivity: "WORKING",
          });
        }
        await emitDomainEvent(tx, ctx, {
          type: "agent.task.started",
          actor: { kind: "agent", id: input.agentId },
          taskId: input.taskId,
          agentId: input.agentId,
          causationId: input.sessionId,
          payload: {
            taskId: input.taskId,
            agentId: input.agentId,
            sessionId: input.sessionId,
            attempt: input.attempt,
          },
        });
        await emitDomainEvent(tx, ctx, {
          type: "agent.status.changed",
          actor: { kind: "system", id: null },
          agentId: input.agentId,
          payload: { sessionId: input.sessionId, from: "IDLE", to: "WORKING" },
        });
      });
      // 07 §5: ASSIGNED→IN_PROGRESS = "sahibi işi eline aldı". Oturum
      // açılırken bu adım HİÇ atılmıyordu; görev, ajan on bir adım boyunca
      // çalışırken bile ASSIGNED kalıyordu (A7 canlı koşumu, 2026-08-19).
      // Sonuç kozmetik değil: wait_for parkı (08 §6), onay parkı ve guard
      // parkı üçü de `status === "IN_PROGRESS"` koşuluna bağlı, yani TÜM
      // oturum boyunca sessizce hiçbir şey yapmıyorlardı — ve makinede
      // olmayan ASSIGNED→WAITING geçişi talep edilebilir hale geliyordu.
      const [taskRow] = await guardedDb
        .select({ status: tasks.status, ownerAgentId: tasks.ownerAgentId })
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
      // yalnız SAHİBİNİN oturumu ilerletir: inceleme/QA oturumları görevi
      // REVIEW'dan çekip almaz (matris zaten owner|system diyor)
      // T14: yeniden-giriş durumları da sahibinin sırasıdır (07 §5:
      // CHANGES_REQUESTED/QA_FAILED/REJECTED → IN_PROGRESS, owner|manager).
      // Düzeltme turu bunlarda AÇILIYOR; görev IN_PROGRESS'e alınmazsa tüm
      // tur boyunca park mekanizmaları yine sessizce no-op kalır.
      const ownerTurn = ["ASSIGNED", "CHANGES_REQUESTED", "QA_FAILED", "REJECTED"];
      if (taskRow && ownerTurn.includes(taskRow.status) && taskRow.ownerAgentId === input.agentId) {
        await taskState
          .transition(ctx, input.taskId, "IN_PROGRESS", { kind: "agent", agentId: input.agentId })
          .catch((err: unknown) => {
            // T11(d): burası sessizce yutuyordu. Yarışta başkası taşımışsa
            // sorun yok — AMA gerçek bir DB/izin hatası da aynı sessizliğe
            // düşüyordu: görev ASSIGNED kalıyor, üç park yolu da
            // `status === "IN_PROGRESS"` koşuluna bağlı olduğu için hepsi
            // no-op oluyor ve T12'nin semptomu İZ BIRAKMADAN geri geliyordu.
            // Yutmaya devam ediyoruz (tur sürmeli) ama artık görünür:
            // konsolda uyarı + Founder'ın canlı konsoluna bir olay.
            console.warn(
              JSON.stringify({
                msg: "owner-turn transition to IN_PROGRESS failed",
                taskId: input.taskId,
                agentId: input.agentId,
                from: taskRow?.status,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
            rt(input, "agent.status", {
              payload: {
                status: "running",
                activity: "WORKING",
                note: `IN_PROGRESS geçişi başarısız (${taskRow?.status} kaldı)`,
              },
            });
          });
      }
      rt(input, "agent.status", { payload: { status: "running", activity: "WORKING" } });
    },

    /** 08 §8 section order; memory sections land with T45. */
    async buildWorkingSetActivity(
      input: SessionRef & { stepNo: number; signalMarkers?: string[] | undefined },
    ): Promise<WorkingSet> {
      const ctx = companyContext(input.companyId);
      rt(input, "context.build.started", { stepNo: input.stepNo });
      const [agentRow] = await guardedDb
        .select({
          name: agents.name,
          persona: agents.persona,
          seniority: agents.seniority,
          autonomyLevel: agents.autonomyLevel,
          positionTitle: positions.title,
          defaultRole: positions.defaultRole,
        })
        .from(agents)
        .innerJoin(positions, eq(agents.positionId, positions.id))
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, input.agentId)));
      const [task] = await guardedDb
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
      if (!agentRow || !task) throw new Error("agent or task not found for working set");

      // Şirketin çıktı dili (_DECISIONS A5). Ayar vardı ama hiçbir prompt
      // okumuyordu; "tr" yazmak hiçbir şeyi değiştirmiyordu. Ayar okunamazsa
      // "en"e düşülür — dil yönergesi olmayan bir prompt, çalışmayan bir
      // prompt'tan iyidir.
      const [settingsRow] = await guardedDb
        .select({ outputLanguage: companySettings.outputLanguage })
        .from(companySettings)
        .where(eq(companySettings.companyId, ctx.companyId));
      const outputLanguage = settingsRow?.outputLanguage ?? "en";

      const chain = await guardedDb.execute(sql`
        WITH RECURSIVE up AS (
          SELECT e.to_agent_id, 1 AS depth FROM org_edges e
          WHERE e.company_id = ${ctx.companyId} AND e.from_agent_id = ${input.agentId}
            AND e.kind = 'reports_to' AND e.ended_at IS NULL
          UNION ALL
          SELECT e.to_agent_id, up.depth + 1 FROM org_edges e
          JOIN up ON e.from_agent_id = up.to_agent_id
          WHERE e.company_id = ${ctx.companyId} AND e.kind = 'reports_to'
            AND e.ended_at IS NULL AND up.depth < 10
        )
        SELECT a.name FROM up JOIN agents a ON a.id = up.to_agent_id
        WHERE a.company_id = ${ctx.companyId} ORDER BY up.depth
      `);
      const managers = (chain.rows as Array<{ name: string }>).map((r) => r.name);

      const recentSteps = await guardedDb
        .select({
          stepNo: agentSteps.stepNo,
          actionKind: agentSteps.actionKind,
          action: agentSteps.action,
          observation: agentSteps.observation,
        })
        .from(agentSteps)
        .where(
          and(
            eq(agentSteps.companyId, ctx.companyId),
            eq(agentSteps.agentSessionId, input.sessionId),
          ),
        )
        .orderBy(sql`${agentSteps.stepNo} DESC`)
        .limit(8); // B5: 5 → 8 (kırpma düzeldi, pencere de dar kalmasın)

      // Mevcut görev ağacı bağlamı (2026-08-14): ajanlar birbirinin kurduğu
      // ağacı görmeden mükerrer initiative/epic açıyordu. Kendi görevinin
      // çocukları + kardeşleri prompt'a girer; "kopya açma" talimatıyla.
      const kin = await guardedDb
        .select({
          number: tasks.number,
          kind: tasks.kind,
          status: tasks.status,
          title: tasks.title,
          ownerAgentId: tasks.ownerAgentId,
          parentId: tasks.parentId,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, ctx.companyId),
            or(
              eq(tasks.parentId, input.taskId),
              ...(task.parentId ? [eq(tasks.parentId, task.parentId)] : []),
            ),
          ),
        )
        .orderBy(asc(tasks.number))
        .limit(25);
      // O5: this used to load EVERY agent in the company on every single step,
      // to label at most 25 sibling tasks. In a 40-agent company that is 40
      // rows fetched per step to use a handful. Ask only for the owners that
      // actually appear in `kin`.
      const kinOwnerIds = [
        ...new Set(kin.map((t) => t.ownerAgentId).filter((id): id is string => id !== null)),
      ];
      const ownerNames = new Map(
        kinOwnerIds.length === 0
          ? []
          : (
              await guardedDb
                .select({ id: agents.id, name: agents.name })
                .from(agents)
                .where(and(eq(agents.companyId, ctx.companyId), inArray(agents.id, kinOwnerIds)))
            ).map((a) => [a.id, a.name]),
      );
      const kinLine = (t: (typeof kin)[number]) =>
        `- TASK-${t.number} [${t.kind}/${t.status}] ${t.title}${t.ownerAgentId ? ` (owner: ${ownerNames.get(t.ownerAgentId) ?? "?"})` : " (unassigned)"}${t.parentId === input.taskId ? " [child of your task]" : " [sibling]"}`;
      // TASK 6: bütçe basıncında ağaç yalnız KENDİ çocuklarına daralır —
      // "tüm task tree varsayılan olarak prompta girmez" kuralının mekanizması
      const renderTaskTree = (childOnly: boolean, cap: number): string => {
        const rows = (childOnly ? kin.filter((t) => t.parentId === input.taskId) : kin).slice(
          0,
          cap,
        );
        return rows.length > 0
          ? `${rows.map(kinLine).join("\n")}\nDo NOT create tasks duplicating any of the above — delegate or refine the existing ones instead.`
          : "(no children or siblings yet)";
      };

      const taskContext = task.context as Record<string, unknown>;
      const lastObservation = recentSteps[0]?.observation as
        | { exitCode?: number; signal?: Record<string, string>; error?: string }
        | null
        | undefined;

      // Proje bağlamı (2026-08-14 Founder saha raporu: "repo'yu bağladım,
      // CEO görmüyor mu?"): görev bir projeye bağlıysa proje + repo + intake
      // raporu working set'e girer — 14 §3 raporu goal'ün context.artifactIds
      // alanına bağlar ama prompt bunu hiç yüzeye çıkarmıyordu; ajan kendi
      // şirketinin elindeki analizden habersiz "hangi proje?" diye soruyordu.
      let projectBase: string | null = null;
      // TASK 6: intake raporu ayrı tutulur — bütçe basıncında yalnız o kısılır
      let intakeReport: { title: string; content: string } | null = null;
      // B3': db.inspect ancak projenin bir veritabanı tanımı varsa iş görür.
      // Tanımsızken katalogda göstermek B4'ün tam olarak düzelttiği israfı
      // geri getirirdi (her deneme bir adım + bir LLM çağrısı yakar), o yüzden
      // katalog satırı bu bayrağa bağlı.
      let hasProjectDatabase = false;
      if (task.projectId) {
        const [projectRow] = await guardedDb
          .select({
            name: projects.name,
            objectiveMd: projects.objectiveMd,
            constraintsMd: projects.constraintsMd,
            status: projects.status,
            intakeReportArtifactId: projects.intakeReportArtifactId,
          })
          .from(projects)
          .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, task.projectId)));
        if (projectRow) {
          const [repo] = await guardedDb
            .select({ originUrl: repositories.originUrl, defaultBranch: repositories.defaultBranch })
            .from(repositories)
            .where(
              and(
                eq(repositories.companyId, ctx.companyId),
                eq(repositories.projectId, task.projectId),
              ),
            );
          if (projectRow.intakeReportArtifactId) {
            const [artifact] = await guardedDb
              .select({ title: artifactsTable.title, contentMd: artifactsTable.contentMd })
              .from(artifactsTable)
              .where(
                and(
                  eq(artifactsTable.companyId, ctx.companyId),
                  eq(artifactsTable.id, projectRow.intakeReportArtifactId),
                ),
              );
            if (artifact?.contentMd) {
              intakeReport = { title: artifact.title, content: artifact.contentMd };
            }
          }
          const envRows = await guardedDb
            .select({ config: environments.config })
            .from(environments)
            .where(
              and(
                eq(environments.companyId, ctx.companyId),
                eq(environments.projectId, task.projectId),
              ),
            );
          hasProjectDatabase = envRows.some((row) => {
            const config = (row.config ?? {}) as Record<string, unknown>;
            return typeof (config.databaseUrl ?? config.database_url) === "string";
          });
          projectBase = [
            `Project: ${projectRow.name} (status: ${projectRow.status})`,
            `Objective: ${projectRow.objectiveMd}`,
            projectRow.constraintsMd ? `Constraints: ${projectRow.constraintsMd}` : "",
            repo?.originUrl
              ? `Repository: ${repo.originUrl} (default branch: ${repo.defaultBranch}) — engineers work in workspaces cloned from this repo`
              : "",
          ]
            .filter(Boolean)
            .join("\n");
        }
      }
      const renderProjectSection = (reportChars: number): string => {
        if (projectBase === null) return "(no linked project)";
        if (!intakeReport) return projectBase;
        return `${projectBase}\nIntake analysis report "${intakeReport.title}" (truncated):\n${intakeReport.content.slice(0, reportChars)}`;
      };

      // ---- TASK 4 — Durable approval state: signal yalnız uyandırır, gerçek
      // durum DB'dir. Görevin onay geçmişi (son 3) her adımda working set'e
      // girer — Founder onayı verildikten SONRAKİ tüm adımlar kararı ve notu
      // görür; model "onayı unutup" yeniden isteyemez/bekleyemez.
      const approvalRows = await guardedDb
        .select({
          status: approvalsTable.status,
          title: approvalsTable.title,
          decisionNote: approvalsTable.decisionNote,
          createdAt: approvalsTable.createdAt,
          decidedAt: approvalsTable.decidedAt,
        })
        .from(approvalsTable)
        .where(
          and(eq(approvalsTable.companyId, ctx.companyId), eq(approvalsTable.taskId, input.taskId)),
        )
        .orderBy(sql`${approvalsTable.createdAt} DESC`)
        .limit(3);
      let approvalsSection = "(no approvals for this task)";
      if (approvalRows.length > 0) {
        const latest = approvalRows[0]!;
        const line = (r: (typeof approvalRows)[number]) =>
          [
            `- [${r.status.toUpperCase()}] "${r.title}" (requested ${r.createdAt.toISOString()}${r.decidedAt ? `, decided ${r.decidedAt.toISOString()}` : ""})`,
            r.decisionNote ? `  Founder note: ${r.decisionNote}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        const rule =
          latest.status === "approved"
            ? "RULE: Founder APPROVED this task's decision — do NOT escalate again and do NOT wait_for approval; act on it NOW."
            : latest.status === "rejected"
              ? "RULE: the latest approval was REJECTED — do not repeat the same request; adjust course per the Founder note."
              : latest.status === "expired"
                ? "RULE: the latest approval EXPIRED (treat as rejected) — re-escalate only if the decision is still genuinely needed."
                : "RULE: an approval is PENDING — do not create another one; you may wait_for approval or progress non-blocked work.";
        approvalsSection = [...approvalRows.map(line), rule].join("\n");
      }

      // sections 4–6 (08 §8): memory retrieval (12 §7, T45). Query text =
      // title + objective + current step intent + last tool error; the
      // failure lane's exact file-path match uses paths the session touched.
      // Retrieval must NEVER break the loop — degradation is flagged on the
      // memory_retrievals row instead (12 §7.5).
      let memorySections = { company: "", project: "", agent: "" };
      try {
        let queryEmbedding: number[] | null = null;
        try {
          const routing = await deps.routingFor(ctx, input.agentId);
          const queryText = [
            task.title,
            task.objective,
            recentSteps[0] ? `step intent: ${recentSteps[0].actionKind}` : "",
            lastObservation?.error ??
              ((lastObservation?.exitCode ?? 0) !== 0
                ? `last exit code ${lastObservation!.exitCode}`
                : ""),
          ]
            .filter(Boolean)
            .join("\n");
          const embedded = await deps.router.embed(
            { text: queryText, agentId: input.agentId, taskId: input.taskId },
            routing,
          );
          queryEmbedding = embedded.embedding;
        } catch {
          /* no embedding target — semantic lane skipped (12 §7.5c) */
        }
        const touchedPaths = [
          ...new Set(
            recentSteps
              .map((s) => ((s.action ?? {}) as { input?: { path?: unknown } }).input?.path)
              .filter((p): p is string => typeof p === "string"),
          ),
        ];
        const retrieved = await retrievalService.retrieveForWorkingSet(ctx, {
          agentId: input.agentId,
          taskId: input.taskId,
          projectId: task.projectId,
          queryEmbedding,
          taskFilePaths: touchedPaths.length ? touchedPaths : undefined,
        });
        memorySections = retrieved.sections;
      } catch {
        /* observability-only failure — the loop continues without memory */
      }

      // TASK 13 — Context Compiler'ın kod ayağı: görev metninden deterministic
      // terimler → CodeIndex sorgusu (canonical + task overlay) → minimal
      // sembol paketi. Kod içeriği DEĞİL, konum işaretçileri girer (INV-14).
      let codeIndexSection = "";
      if (task.projectId && deps.codeIndexQuery) {
        try {
          const STOP = new Set([
            "için", "veya", "gibi", "daha", "sonra", "önce", "this", "that", "with",
            "from", "task", "görev", "proje", "project", "the", "and", "bir", "olan",
          ]);
          const analyzerText = [
            task.title,
            task.objective,
            lastObservation?.error ?? "",
          ].join(" ");
          const terms = [
            ...new Set(
              analyzerText
                .split(/[^A-Za-z0-9_./çğıöşüÇĞİÖŞÜ-]+/)
                .map((t) => t.trim())
                .filter(
                  (t) =>
                    t.length >= 3 &&
                    t.length <= 80 &&
                    !STOP.has(t.toLowerCase()) &&
                    (/[A-Z].*[a-z]|_|\.|\//.test(t) || t.length >= 5),
                ),
            ),
          ].slice(0, 12);
          if (terms.length > 0) {
            const idx = await deps.codeIndexQuery({
              companyId: input.companyId,
              projectId: task.projectId,
              taskId: input.taskId,
              terms,
            });
            const lines = idx.symbols
              .slice(0, 10)
              .map(
                (sym) =>
                  `- ${sym.path}:${sym.startLine}-${sym.endLine} ${sym.kind} ${sym.name}${sym.layer === "overlay" ? " [worktree]" : ""}`,
              );
            const rel = idx.relations
              .slice(0, 6)
              .map((r) => `- ${r.kind} ← ${r.fromPath}`);
            codeIndexSection = [
              `[CodeIndex durum=${idx.indexState}${idx.stale ? " — BAYAT: indeks güncel olmayabilir, kritik yerde doğrula" : ""}]`,
              ...(lines.length > 0 ? ["İlgili semboller:", ...lines] : []),
              ...(rel.length > 0 ? ["İlişkiler:", ...rel] : []),
              idx.indexState === "ready"
                ? "KURAL (anti-rescan): kod ararken ÖNCE code.search kullan; tam repo fs.search/fs.read İLK seçenek OLMAZ. fs.read'i yukarıdaki path:satır aralıklarına daralt."
                : "",
            ]
              .filter(Boolean)
              .join("\n");
          }
        } catch {
          /* CodeIndex erişilemezse döngü kod paketi olmadan sürer */
        }
      }
      // codeIndexSection ayrı kalır (TASK 7: bölüm telemetrisi ayrı ölçer;
      // TASK 6: bütçe basıncında bağımsız kısılır) — render'da Project
      // memory'nin altına eklenir (eski davranışla aynı yerleşim).
      const markers = [
        `[role:${agentRow.defaultRole}]`,
        `[agentName:${agentRow.name}]`,
        `[ctxTask:${input.taskId}]`,
        `[taskFixture:${String(taskContext.taskFixture ?? "none")}]`,
        `[lastExitCode:${lastObservation?.exitCode ?? 0}]`,
        ...Object.entries(lastObservation?.signal ?? {}).map(([k, v]) => `[signal:${k}=${v}]`),
        ...(input.signalMarkers ?? []), // drained signal buffer (08 §5, T33)
      ].join(" ");

      // sections 1–10 of 08 §8 (memory 4–6 and thread 7 are placeholders
      // until T45/T33; token budgets enforced with the char/4 heuristic there)
      // S5 (18 §11.1): observations carrying EXTERNAL content (workspace
      // files, web responses) enter the prompt only inside provenance fences;
      // flagged outputs keep their taint visible. Fencing is central — here,
      // never in tool authors' code.
      /**
       * B5 (2026-08-15 kod incelemesi): gözlemler 200 karaktere kırpılıyordu —
       * ajan okuduğu dosyayı GÖREMİYOR, ezberden `oldText` uydurup NO_MATCH
       * alıyor ya da yeniden okuyup 50 adımı eritiyordu. Artık kırpma alan
       * farkındalıklı: yük taşıyan alanlar (content/diff/stdoutTail…) cömert
       * bütçeyle, en son adım TAM bütçeyle girer ve kırpma AÇIKÇA bildirilir
       * (sessiz kırpma, ajanın eksik veriyi tam sanmasına yol açıyordu).
       * Bütçeler 08 §8'in char/4 sezgisi: 24k+12k char ≈ 9k token tavanı.
       */
      const PAYLOAD_FIELDS = [
        "content",
        "diff",
        "stdoutTail",
        "stderrTail",
        "matches",
        "text",
        "summary",
      ] as const;
      const clip = (value: string, budget: number): string =>
        value.length <= budget
          ? value
          : `${value.slice(0, budget)}\n…[TRUNCATED: ${value.length - budget} more chars — re-read with a narrower path/range if you need the rest]`;
      const renderObservation = (observation: unknown, budget: number): string => {
        const obs = (observation ?? {}) as Record<string, unknown>;
        const output = (obs.output ?? {}) as Record<string, unknown>;
        // yük alanı varsa onu tam metin olarak öne çıkar, kalanı özetle
        const payloadKey = PAYLOAD_FIELDS.find((k) => output[k] !== undefined);
        if (payloadKey === undefined) return clip(JSON.stringify(obs), Math.min(budget, 2_000));
        const payload =
          typeof output[payloadKey] === "string"
            ? (output[payloadKey] as string)
            : JSON.stringify(output[payloadKey]);
        const meta = { ...obs, output: { ...output, [payloadKey]: `<see ${payloadKey} below>` } };
        return `${clip(JSON.stringify(meta), 600)}\n${payloadKey}:\n${clip(payload, budget)}`;
      };
      const renderStep = (
        s: (typeof recentSteps)[number],
        isLatest: boolean,
        latestObsChars: number,
        olderObsChars: number,
      ): string => {
        const obs = (s.observation ?? {}) as {
          output?: { provenance?: string };
          outputFlagged?: boolean;
        };
        const body = renderObservation(s.observation, isLatest ? latestObsChars : olderObsChars);
        const provenance = obs.output?.provenance;
        if (provenance === "workspace" || provenance === "web" || obs.outputFlagged) {
          return `${s.stepNo}. ${s.actionKind} ->\n${provenanceFence(body, {
            source: `${provenance ?? "tool"}:step-${s.stepNo}`,
          })}`;
        }
        return `${s.stepNo}. ${s.actionKind} -> ${body}`;
      };
      const hasFences = recentSteps.some((s) => {
        const obs = (s.observation ?? {}) as {
          output?: { provenance?: string };
          outputFlagged?: boolean;
        };
        const p = obs.output?.provenance;
        return p === "workspace" || p === "web" || obs.outputFlagged === true;
      });

      // B3 (26 §3): the message list is split by STABILITY, not by topic.
      // Everything the agent re-sends unchanged on every step — identity,
      // persona, the rules, the action catalog — goes into one cacheable
      // prefix; anything that moves (markers with the last exit code, drained
      // signals, the fence preamble that depends on this step's observations)
      // goes after it. The catalog used to sit at the END of the variable user
      // message, so no prefix was stable at all and there was nothing worth
      // caching; the brief assumed the order was already right.
      // Dil yönergesi kararlı önekte: her adımda birebir aynı, yani B3'ün
      // önbellek kesme noktasının içinde kalıyor ve fazladan token maliyeti
      // ilk adımdan sonra sıfır.
      const languageDirective = outputLanguageDirective(outputLanguage);
      const stablePrefix = [
        `You are ${agentRow.name}, ${agentRow.positionTitle} (${agentRow.seniority}, autonomy L${agentRow.autonomyLevel}).`,
        agentRow.persona,
        `Non-negotiable rules: act only via a single AgentAction JSON object; never invent tools.`,
        ...(languageDirective ? [languageDirective] : []),
      ].join("\n");
      const stepPreamble = [...(hasFences ? [FENCE_PREAMBLE] : []), markers].join("\n");
      // Canlı model düzeltmesi (2026-08-14): scripted router şemayı "bilir",
      // gerçek model bilemez — katalog gösterilmeden AgentAction üretmesi
      // imkânsızdı (parse-fail → abandon). 08 §8'in aksiyon sözlüğü bölümü.
      const actionCatalog = [
        "# AgentAction catalog — respond with EXACTLY ONE of these shapes",
        `- {"type":"think","thought":"<reasoning, <=4000 chars>","plan":["step",...]?}`,
        // araç adları packages/tools MVP kaydıyla eşleşir (registry testi kilitler)
        // B4 (2026-08-15 code review): only tools with a real dispatch are
        // advertised — advertising a dead tool burned a step and an LLM call
        // per attempt. B1' wired task.query + memory.search, B2' web.fetch,
        // B3' db.inspect. db.inspect only works where the project declares a
        // database, so it is advertised per task. web.search stays out until
        // a search API key is configured (without one it can only fail).
        `- {"type":"use_tool","tool":"<one of: fs.read | fs.search | fs.edit | fs.write | terminal.run | git.diff | git.commit | git.branch | git.merge | task.query | memory.search | web.fetch | web.search | code.search | preview.ports | http.request${hasProjectDatabase ? " | db.inspect" : ""}${["executive", "manager", "lead"].includes(agentRow.defaultRole) ? " | org.team.create | agent.hire | agent.assign_project | model.bind | github.repo.ensure" : ""}>","input":{...},"reason":"<=500 chars"} — terminal.run executes shell commands in YOUR task workspace; code.search {terms:[...]} projenin Kod İndeksinde sembol arar (kod ararken İLK bunu kullan); preview.ports çalışan dev sunucusunun portlarını keşfeder, http.request {port,path,method} kendi workspace'inin portuna HTTP doğrulaması yapar; task.query görev panosunu, memory.search şirket hafızasını okur; web.fetch {url} / web.search {query} dış dünya${["executive", "manager", "lead"].includes(agentRow.defaultRole) ? "; org.team.create {capability} YENİ TAKIM kurar, agent.hire {capability,count} AJAN İŞE ALIR (Founder onayı bu görevde zaten verildiyse anında çalışır), agent.assign_project {agentId} ajanı projeye atar, model.bind model bağlar, github.repo.ensure GitHub yansısını kurar — kadro eksikse delege etmeden ÖNCE agent.hire ile ekibi kur" : ""}`,
        ...(hasProjectDatabase
          ? [
              `  db.inspect {query, environment?, maxRows?} runs ONE read-only SQL statement against this project's database — a READ ONLY transaction, so any write is refused by the database itself.`,
            ]
          : []),
        `  EDITING RULE (hard): to change an EXISTING file use fs.edit {path, oldText, newText, replaceAll?} — an exact-snippet replacement. fs.write OVERWRITES THE WHOLE FILE and is ONLY for brand-new files; using it on an existing file destroys everything you did not re-type. Copy oldText verbatim from a prior fs.read (whitespace included); add surrounding lines if the snippet is not unique.`,
        `- {"type":"send_message","channelId":"<uuid>","kind":"text|help_request|review_request|escalation|status","body":"...","mentions":[],"refs":[]}`,
        `- {"type":"create_task","kind":"initiative|epic|task|subtask","parentTaskId":"<uuid>","title":"<=200","objective":"...","successCriteria":["..."],"priority":"P0|P1|P2|P3","estimatedEffort":1-13,"risk":"low|medium|high|critical","requiredCapabilities":["frontend","backend",...]}`,
        `- {"type":"delegate_task","taskId":"<uuid>","toAgentId":"<uuid>","note":"<=1000"} — toAgentId için ${CONTEXT_SENTINEL_UUID} kullan: atamayı Scheduler yapar (yetenek+yük+geçmiş skoru). Belirli bir ajanı DAYATMA.`,
        `  KENDİNE ALMAK MEŞRUDUR: bir alt görevi kendin üstlenmek istiyorsan toAgentId için ${SELF_SENTINEL_UUID} kullan — küçük, kritik ya da senin bağlamını gerektiren dilim için doğru karar budur. Geri kalanı yine delege et; kendine aldığın iş KENDİ WIP tavanına sayılır, tavan dolduysa istek reddedilir.`,
        `- {"type":"request_review","taskId":"<uuid>","artifactId":"<uuid>","summary":"<=2000"}`,
        `- {"type":"request_help","topic":"<=200","body":"<=4000","audience":"peer|team|lead|manager|specialist"} — blokajlarda İLK adres: audience:"manager" seçersen yöneticin uyandırılır ve DM ile yanıt verir; cevabı wait_for {"what":"reply"} ile bekle`,
        `- {"type":"escalate","reason":"<=2000","attempted":["..."],"options":[{"option":"...","risk":"...","cost":"..."}],"recommendation":"..."} — Founder'a resmi onay talebi. SON ÇAREDİR: önce request_help(manager) dene; escalate yalnız (a) yöneticin çözemedi/yanıtlamadı, (b) karar gerçekten Founder-seviyesi (bütçe/politika/geri döndürülemez etki) ise`,
        `- {"type":"update_task_status","taskId":"<uuid>","to":"IN_PROGRESS|WAITING|BLOCKED|REVIEW","note":"<=1000"}`,
        `- {"type":"record_decision","title":"<=200","decision":"...","alternatives":["..."],"consequences":"..."}`,
        `- {"type":"complete_task","result":{"summary":"...","criteria":[{"criterion":"...","met":true,"evidence":"..."}],"artifactIds":[],"cost":{"tokensIn":0,"tokensOut":0,"cents":0}}}`,
        `- {"type":"wait_for","what":"dependency|reply|review|approval|timer","refId":"<uuid>"?,"timeoutMinutes":1-1440}`,
        `- {"type":"abandon","reason":"<=2000"}`,
        `Special uuid ${CONTEXT_SENTINEL_UUID} = "current context": own task (create_task.parentTaskId), next unassigned child (delegate_task.taskId), an eligible report (delegate_task.toAgentId), own task thread (send_message.channelId).`,
        `Special uuid ${SELF_SENTINEL_UUID} = "myself" (delegate_task.toAgentId only): I take this subtask on.`,
        "Output RAW JSON only — no markdown fences, no commentary before or after.",
      ].join("\n");
      // The catalog rides with the stable prefix (it is identical on every
      // step of every task, minus the per-task db.inspect line) so the cache
      // breakpoint covers it too.
      const system = `${stablePrefix}\n\n${actionCatalog}`;

      // ---- TASK 6 — Context Budget: bölümler ayrı derlenir; toplam tahmin
      // (char/4) rol hedefini aşarsa 08 §8 öncelik sırasının TERSİNDEN
      // kademeli küçültülür (önce recent steps, sonra memory, code index,
      // task tree, intake raporu). Görev + karar + onay durumu ASLA kısılmaz.
      const budget = contextBudgetForRole(agentRow.defaultRole);
      const clipTo = (text: string, max: number): string =>
        text.length <= max ? text : `${text.slice(0, max)}\n…[trimmed for context budget]`;
      const shape = {
        stepCount: Math.min(recentSteps.length, 8),
        latestObsChars: 24_000,
        olderObsChars: 12_000,
        reportChars: 6_000,
        includeAgentMem: true,
        includeCompanyMem: true,
        projectMemChars: Number.MAX_SAFE_INTEGER,
        codeIndexChars: Number.MAX_SAFE_INTEGER,
        taskTreeChildOnly: false,
        taskTreeCap: 25,
      };
      const TRIM_LADDER: Array<{ name: string; apply: () => void }> = [
        { name: "recent_steps_6", apply: () => Object.assign(shape, { stepCount: 6, latestObsChars: 12_000, olderObsChars: 6_000 }) },
        { name: "recent_steps_4", apply: () => Object.assign(shape, { stepCount: 4, latestObsChars: 8_000, olderObsChars: 3_000 }) },
        { name: "memory_agent_drop", apply: () => Object.assign(shape, { includeAgentMem: false }) },
        { name: "memory_company_drop", apply: () => Object.assign(shape, { includeCompanyMem: false }) },
        { name: "memory_project_clip", apply: () => Object.assign(shape, { projectMemChars: 1_500 }) },
        { name: "code_index_clip", apply: () => Object.assign(shape, { codeIndexChars: 800 }) },
        { name: "task_tree_children_only", apply: () => Object.assign(shape, { taskTreeChildOnly: true, taskTreeCap: 10 }) },
        { name: "intake_report_clip", apply: () => Object.assign(shape, { reportChars: 1_500 }) },
        { name: "recent_steps_2", apply: () => Object.assign(shape, { stepCount: 2, latestObsChars: 6_000, olderObsChars: 1_200 }) },
      ];

      const orgSection = `Escalation chain: ${managers.join(" -> ") || "(top level)"} -> Founder`;
      const taskSection = `# Task TASK-${task.number}: ${task.title}\nObjective: ${task.objective}\nStatus: ${task.status} | Priority: ${task.priority} | Risk: ${task.risk}\nSuccess criteria: ${task.successCriteria.join("; ") || "(none)"}\nBudget remaining cents: ${task.budgetCents === null ? "inherit" : task.budgetCents - task.spentCents}`;
      const threadSection = (input.signalMarkers ?? []).join("\n") || "(no new messages)";

      interface ComposedSections {
        user: string;
        projectSection: string;
        taskTree: string;
        companyMem: string;
        projectMem: string;
        agentMem: string;
        codeIdx: string;
        recent: string;
      }
      const compose = (): ComposedSections => {
        const projectSection = renderProjectSection(shape.reportChars);
        const taskTree = renderTaskTree(shape.taskTreeChildOnly, shape.taskTreeCap);
        const companyMem = shape.includeCompanyMem ? memorySections.company : "";
        const agentMem = shape.includeAgentMem ? memorySections.agent : "";
        const projectMem = clipTo(memorySections.project, shape.projectMemChars);
        const codeIdx = clipTo(codeIndexSection, shape.codeIndexChars);
        const recent =
          recentSteps
            .slice(0, shape.stepCount)
            .slice()
            .reverse()
            .map((s, i, all) =>
              renderStep(s, i === all.length - 1, shape.latestObsChars, shape.olderObsChars),
            )
            .join("\n") || "(none yet)";
        const user = [
          stepPreamble,
          `# Org context\n${orgSection}`,
          taskSection,
          `# Decisions & approvals (authoritative — loaded from DB)\n${approvalsSection}`,
          `# Project context\n${projectSection}`,
          `# Existing task tree around you\n${taskTree}`,
          `# Company memory\n${companyMem || "(none)"}`,
          `# Project memory\n${[projectMem, codeIdx].filter(Boolean).join("\n") || "(none)"}`,
          `# Agent memory\n${agentMem || "(none)"}`,
          `# Thread + signals\n${threadSection}`,
          `# Recent steps\n${recent}`,
          `# Output\nRespond with EXACTLY one AgentAction JSON object, no prose. Step ${input.stepNo}.`,
        ].join("\n\n");
        return { user, projectSection, taskTree, companyMem, projectMem, agentMem, codeIdx, recent };
      };

      const systemTokens = estimateTokens(system);
      let composed = compose();
      let estTotal = systemTokens + estimateTokens(composed.user);
      const trims: string[] = [];
      for (const trim of TRIM_LADDER) {
        if (estTotal <= budget.targetTokens) break;
        trim.apply();
        trims.push(trim.name);
        composed = compose();
        estTotal = systemTokens + estimateTokens(composed.user);
      }

      const budgetFlag: WorkingSetTelemetry["budgetFlag"] =
        estTotal > budget.investigateTokens
          ? "investigate"
          : estTotal > budget.hardWarnTokens
            ? "warn"
            : "ok";
      if (budgetFlag !== "ok") {
        // Hard warning / investigation threshold (TASK 6): kırpma merdivenine
        // rağmen bu boyut kaldıysa yapısal bir sorun var — structured log.
        console.warn(
          JSON.stringify({
            msg: `working set over context budget (${budgetFlag})`,
            estTokens: estTotal,
            targetTokens: budget.targetTokens,
            role: agentRow.defaultRole,
            taskId: input.taskId,
            stepNo: input.stepNo,
            trims,
          }),
        );
      }
      const telemetry: WorkingSetTelemetry = {
        estTotalTokens: estTotal,
        systemTokens,
        taskTokens: estimateTokens(taskSection),
        approvalTokens: estimateTokens(approvalsSection),
        projectTokens: estimateTokens(composed.projectSection),
        orgTokens: estimateTokens(orgSection),
        taskTreeTokens: estimateTokens(composed.taskTree),
        codeIndexTokens: estimateTokens(composed.codeIdx),
        memoryTokens:
          estimateTokens(composed.companyMem) +
          estimateTokens(composed.projectMem) +
          estimateTokens(composed.agentMem),
        recentStepTokens: estimateTokens(composed.recent),
        signalTokens: estimateTokens(stepPreamble) + estimateTokens(threadSection),
        budgetTargetTokens: budget.targetTokens,
        budgetFlag,
        trims,
      };
      rt(input, "context.build.completed", {
        stepNo: input.stepNo,
        payload: { ...telemetry },
      });

      const messages: LlmMessage[] = [
        { role: "system", content: system, cacheable: true },
        { role: "user", content: composed.user },
      ];
      return { messages, digest: fnvDigest(system + composed.user), telemetry };
    },

    /** ModelRouter call + idempotent llm_calls accounting (08 §11). */
    async callModelActivity(input: SessionRef & {
      stepId: string;
      repairAttempt: number;
      messages: LlmMessage[];
      /** TASK 7: working set bölüm telemetrisi — llm_calls satırına yazılır. */
      contextTelemetry?: WorkingSetTelemetry | undefined;
    }): Promise<ModelCallResult> {
      const ctx = companyContext(input.companyId);
      const routing = await deps.routingFor(ctx, input.agentId);
      const llmCallId = uuidv5(`llm:${input.repairAttempt}`, input.stepId);
      // TASK 2/3: model çağrısı boyunca UI sessiz kalmaz — started + 10sn'de
      // bir heartbeat (elapsed sayaç), sonda completed (latency + tokens).
      rt(input, "llm.started", {
        opId: llmCallId,
        payload: { purpose: "reasoning", repairAttempt: input.repairAttempt },
      });
      const stopHeartbeat = startOperationHeartbeat(deps.runtimeEvents, input.companyId, {
        sessionId: input.sessionId,
        agentId: input.agentId,
        taskId: input.taskId,
        opId: llmCallId,
        operationType: "llm",
      });
      const stopTemporalBeat = startTemporalHeartbeat(`llm:${llmCallId}`);
      let result: Awaited<ReturnType<typeof deps.router.complete>>;
      try {
        result = await deps.router.complete(
          {
            purpose: "reasoning",
            messages: input.messages,
            agentId: input.agentId,
            taskId: input.taskId,
            sessionId: input.sessionId,
          },
          routing,
        );
      } finally {
        stopHeartbeat();
        stopTemporalBeat();
      }
      rt(input, "llm.completed", {
        opId: llmCallId,
        payload: {
          model: result.model,
          latencyMs: result.latencyMs,
          tokensIn: result.usage.inputTokens,
          tokensOut: result.usage.outputTokens,
          tokensCached: result.usage.cachedInputTokens,
          costCents: result.costCents,
          ...(input.contextTelemetry && { context: { ...input.contextTelemetry } }),
        },
      });
      // T36: defter yazımı artık TEK yolda (@acos/db recordLlmCall) — ajan
      // döngüsü, planlama/intake ve hafıza çıkarımı aynı fonksiyonu çağırır.
      // Davranış aynı: id deterministik, yeniden deneme maliyeti ikiye
      // katlamaz. TASK 7 bölüm telemetrisi de aynen taşınır.
      await recordLlmCall(guardedDb, ctx, {
        id: llmCallId,
        agentId: input.agentId,
        taskId: input.taskId,
        agentSessionId: input.sessionId,
        purpose: "reasoning",
        providerId: result.providerId,
        model: result.model,
        tokensIn: result.usage.inputTokens,
        tokensOut: result.usage.outputTokens,
        tokensCached: result.usage.cachedInputTokens,
        costCents: result.costCents,
        latencyMs: result.latencyMs,
        status: "ok",
        ...(input.contextTelemetry && {
          contextTelemetry: input.contextTelemetry as unknown as Record<string, unknown>,
        }),
      });
      return {
        text: result.text,
        usage: result.usage,
        model: result.model,
        costCents: result.costCents,
        latencyMs: result.latencyMs,
      };
    },


    /** Action dispatch (08 §3) — gövde @acos/agent-actions'ta yaşıyor; burası
     *  yalnız Temporal aktivitesi kabuğu. */
    async executeActionActivity(input: SessionRef & {
      stepId: string;
      action: AgentAction;
    }): Promise<Record<string, unknown>> {
      return actionDispatcher.dispatch(input);
    },

    /** agent_steps + cost entry + session counters, one tx, stepId-idempotent. */
    async persistStepActivity(input: SessionRef & {
      stepId: string;
      stepNo: number;
      action: AgentAction;
      observation: Record<string, unknown>;
      usage: LlmUsage;
      costCents: number;
      durationMs: number;
    }): Promise<{ inserted: boolean }> {
      const ctx = companyContext(input.companyId);
      // schema CHECK carries the canonical 12 kinds — think persists under
      // record_decision with the true type kept in action JSON (recorded
      // deviation; altering the CHECK would be a migration change)
      const actionKind = input.action.type === "think" ? "record_decision" : input.action.type;
      return guardedDb.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: agentSteps.id })
          .from(agentSteps)
          .where(and(eq(agentSteps.companyId, ctx.companyId), eq(agentSteps.id, input.stepId)));
        if (existing) return { inserted: false }; // exactly-once effect
        await tx.insert(agentSteps).values({
          id: input.stepId,
          companyId: ctx.companyId,
          agentSessionId: input.sessionId,
          agentId: input.agentId,
          taskId: input.taskId,
          stepNo: input.stepNo,
          actionKind,
          action: input.action as unknown as Record<string, unknown>,
          observation: input.observation,
          tokensIn: input.usage.inputTokens,
          tokensOut: input.usage.outputTokens,
          costCents: input.costCents,
          durationMs: input.durationMs,
        });
        // 10 §10 satırı "agent.step.recorded → OP (badges), WS (Monitor)":
        // olay ana sayfadaki oturum hücresinin canlı tazelenmesini tetikler
        // (Founder, CEO dahil her ajanın düşünce/aksiyon akışını izler).
        // Adım eklemesiyle AYNI tx — replay yolu yukarıda erken döndüğü için
        // exactly-once (INV-11: olay, etkisiyle aynı outbox tx'inde).
        await emitDomainEvent(tx, ctx, {
          type: "agent.step.recorded",
          actor: { kind: "agent", id: input.agentId },
          agentId: input.agentId,
          taskId: input.taskId,
          causationId: input.stepId,
          payload: { sessionId: input.sessionId, stepNo: input.stepNo, actionType: actionKind },
        });
        await tx
          .update(agentSessions)
          .set({
            stepsCount: sql`GREATEST(${agentSessions.stepsCount}, ${input.stepNo})`,
            tokensIn: sql`${agentSessions.tokensIn} + ${input.usage.inputTokens}`,
            tokensOut: sql`${agentSessions.tokensOut} + ${input.usage.outputTokens}`,
            costCents: sql`${agentSessions.costCents} + ${input.costCents}`,
          })
          .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)));
        // per-step cost through CostService (08 §13, T34): idempotent id,
        // breach detection + company circuit breaker fire from agent spend.
        //
        // A2 (2026-08-15 code review; 26 §2): this used to run in a `.then()`
        // AFTER the step transaction had committed, guarded by
        // `result.inserted`. Two ways that lost money: a crash between the two
        // writes left the step (and the session counters) charged with no
        // ledger entry, and a retry then saw the step row already present, so
        // `inserted` was false and the cost was skipped forever. 26 §2 is
        // explicit — "the cost entry is written in the same Postgres
        // transaction as the invocation record it prices [...] no async
        // billing pipeline, no drift, no lost attribution on crash". Inside
        // the transaction the `inserted` guard is implicit (the replay path
        // returned above) and the entry's deterministic id keeps it
        // exactly-once. INV-11 holds: `cost.entry.recorded` is appended
        // through the same outbox transaction. INV-13 is untouched — the
        // ledger only bumps `tasks.spent_cents`, never `tasks.status`.
        if (input.costCents > 0) {
          await costService.recordCostInTx(tx, ctx, {
            id: uuidv5("llm-cost", input.stepId),
            kind: "llm",
            ref: uuidv5(`llm:0`, input.stepId),
            amountCents: input.costCents,
            quantity: input.usage.inputTokens + input.usage.outputTokens,
            agentId: input.agentId,
            taskId: input.taskId,
          });
        }
        return { inserted: true };
      });
    },

    /** Guard snapshot (08 §3): budget remaining + deadline, refreshed per step. */
    async getGuardSnapshotActivity(input: SessionRef): Promise<{
      budgetCents: number | null;
      spentCents: number;
      remainingCents: number | null;
      estimatedNextStepCents: number;
      deadline: string | null;
    }> {
      const ctx = companyContext(input.companyId);
      const [task] = await guardedDb
        .select({
          budgetCents: tasks.budgetCents,
          spentCents: tasks.spentCents,
          deadline: tasks.deadline,
        })
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
      const recent = await guardedDb
        .select({ costCents: agentSteps.costCents })
        .from(agentSteps)
        .where(
          and(eq(agentSteps.companyId, ctx.companyId), eq(agentSteps.agentSessionId, input.sessionId)),
        )
        .orderBy(sql`${agentSteps.stepNo} DESC`)
        .limit(5);
      const avg =
        recent.length > 0
          ? recent.reduce((s, r) => s + r.costCents, 0) / recent.length
          : 0;
      return {
        budgetCents: task?.budgetCents ?? null,
        spentCents: task?.spentCents ?? 0,
        remainingCents: task?.budgetCents === null ? null : (task?.budgetCents ?? 0) - (task?.spentCents ?? 0),
        estimatedNextStepCents: Math.ceil(avg * 1.5),
        deadline: task?.deadline?.toISOString() ?? null,
      };
    },

    /** Guard enforcement (08 §9): forced help/escalation to the manager —
     *  message via the ONE send path + agent.guard.triggered/agent.escalated
     *  events + task WAITING (budget/loop/step_cap) per the guard table. */
    async guardEscalateActivity(input: SessionRef & {
      stepId: string;
      guard: "budget" | "deadline" | "step_cap" | "loop" | "ping_pong" | "depth";
      detail: string;
    }): Promise<void> {
      const ctx = companyContext(input.companyId);
      await guardedDb.transaction(async (tx) => {
        await emitDomainEvent(tx, ctx, {
          type: "agent.guard.triggered",
          actor: { kind: "system", id: null },
          agentId: input.agentId,
          taskId: input.taskId,
          payload: { guard: input.guard, context: { detail: input.detail } },
        });
        await emitDomainEvent(tx, ctx, {
          type: "agent.escalated",
          actor: { kind: "system", id: null },
          agentId: input.agentId,
          taskId: input.taskId,
          payload: {
            reason: `guard ${input.guard}: ${input.detail}`,
            attempted: [],
            recommendation: "manager intervention",
            guardFlag: input.guard,
          },
        });
      });
      // help message into the task thread (best-effort — thread may not exist
      // for directly-inserted fixture tasks)
      try {
        const thread = await guardedDb.transaction((tx) =>
          channelService.provisionInTx(tx, ctx, {
            kind: "task_thread",
            taskId: input.taskId,
            memberAgentIds: [input.agentId],
          }),
        );
        await messageService.send(ctx, {
          channelId: thread.id,
          senderAgentId: input.agentId,
          kind: "help_request",
          body: `Guard ${input.guard} tripped: ${input.detail}`,
          refs: [{ kind: "task", id: input.taskId }],
          idempotencyKey: uuidv5(`guard-msg:${input.guard}`, input.stepId),
        });
      } catch {
        /* message is advisory; events already durable */
      }
      // budget/step_cap/loop park the task (08 §9a/c/d); deadline only escalates
      if (input.guard !== "deadline") {
        const [current] = await guardedDb
          .select({ status: tasks.status })
          .from(tasks)
          .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
        if (current?.status === "IN_PROGRESS") {
          await taskState.transition(ctx, input.taskId, "WAITING", { kind: "system" }, {
            note: `guard ${input.guard}`,
          });
        }
      }
    },

    /** wake from wait_for: WAITING→IN_PROGRESS (system actor, 07 §5). */
    async resumeFromWaitActivity(input: SessionRef): Promise<void> {
      const ctx = companyContext(input.companyId);
      const [current] = await guardedDb
        .select({ status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
      if (current?.status === "WAITING") {
        await taskState.transition(ctx, input.taskId, "IN_PROGRESS", { kind: "system" });
      }
      // wait_for'un WAITING'e aldığı oturum aktivitesi geri WORKING olur
      await guardedDb
        .update(agentSessions)
        .set({ currentActivity: "WORKING" })
        .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)));
      rt(input, "wait.completed", {});
      rt(input, "agent.status", { payload: { activity: "WORKING" } });
    },

    /** Workflow-timer expiry fallback (19 §6/§7): if the wait on the verdict
     *  times out at the derived expiry, the workflow closes the approval
     *  itself. Idempotent against the server sweep — whoever commits first
     *  wins; the returned status is the settled truth for the next step. */
    async expireApprovalActivity(input: SessionRef & { approvalId: string }): Promise<{
      status: string;
    }> {
      const ctx = companyContext(input.companyId);
      const { row } = await approvalsService.expire(ctx, input.approvalId);
      return { status: row.status };
    },

    /** Inbox triage (08 §7): cheap model classifies items act|queue|ignore;
     *  no fast route resolves ⇒ ignore (still marks read). */
    async triageInboxActivity(input: {
      companyId: string;
      agentId: string;
      items: InboxItem[];
    }): Promise<{ verdict: "act" | "queue" | "ignore" }> {
      const ctx = companyContext(input.companyId);
      try {
        const routing = await deps.routingFor(ctx, input.agentId);
        const result = await deps.router.complete(
          {
            purpose: "fast",
            messages: [
              {
                role: "system",
                content:
                  'Triage the inbox items. Reply with exactly one JSON object {"verdict":"act"|"queue"|"ignore"}.',
              },
              {
                role: "user",
                content: input.items.map((i) => `${i.kind}: ${i.preview}`).join("\n"),
              },
            ],
            agentId: input.agentId,
          },
          routing,
        );
        const parsed = JSON.parse(result.text) as { verdict?: string };
        if (parsed.verdict === "act" || parsed.verdict === "queue") return { verdict: parsed.verdict };
        return { verdict: "ignore" };
      } catch {
        return { verdict: "ignore" }; // no fast profile / parse failure — FYI path
      }
    },

    async markInboxReadActivity(input: {
      companyId: string;
      agentId: string;
      channelIds: string[];
    }): Promise<void> {
      const ctx = companyContext(input.companyId);
      for (const channelId of new Set(input.channelIds)) {
        await channelService.markRead(ctx, channelId, input.agentId);
      }
    },

    /**
     * 33 §2.2 failure handler — a workflow crash (unhandled workflow-code
     * error) must not be a silent death: the task leaves the crashed loop as
     * BLOCKED and the manager receives a help-request to reassign or retry.
     * The workflow's crash path calls this before rethrowing; every step is
     * best-effort and idempotent per session, so activity retries and sweep
     * restarts are safe.
     */
    async reportWorkflowCrashActivity(input: SessionRef & { reason: string }): Promise<void> {
      const ctx = companyContext(input.companyId);
      const reason = input.reason.slice(0, 500);

      // task→BLOCKED. 07 §4 makinesi BLOCKED'a yalnız IN_PROGRESS'ten izin
      // verir; ASSIGNED/WAITING'de ölen koşu system aktörüyle IN_PROGRESS
      // üzerinden taşınır (stuck-tasks.ts'in kayıtlı çift-adım deseni) —
      // makine ve tek yazar (INV-13) aynen korunur. BLOCKED görev stuck
      // sweep'in WAITING/ASSIGNED tarama kümesinin DIŞINDA kalır: kalıcı bir
      // hata 30 dakikada bir kör restart döngüsüne girmez, kararı yönetici verir.
      const [task] = await guardedDb
        .select({ status: tasks.status, ownerAgentId: tasks.ownerAgentId })
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
      if (!task) return;
      try {
        // T14 (A7 canlı koşumu, 2026-08-20): CHANGES_REQUESTED'ta çöken
        // düzeltme turu hiçbir dala girmiyordu — olay defterinde
        // agent.escalated + "görev BLOCKED durumda bekliyor" yazıyor ama
        // görev CHANGES_REQUESTED'ta kalıyordu: mesaj yalan söylüyor ve
        // yönetici olmayan bir durumu düzeltmeye çalışıyordu.
        //
        // Aktör seçimi 07 §5 matrisine göre AYRIŞIR: ASSIGNED/WAITING→
        // IN_PROGRESS'e {owner, system} izinli, ama yeniden-giriş üçlüsünde
        // (CHANGES_REQUESTED/QA_FAILED/REJECTED→IN_PROGRESS) yalnız
        // {owner, manager} var — system YOK. Ölen döngünün sahibi adına
        // taşırız; sahibi olmayan görevi hiç park etmeyiz.
        const SYSTEM_PARKABLE = ["ASSIGNED", "WAITING"];
        const OWNER_PARKABLE = ["CHANGES_REQUESTED", "QA_FAILED", "REJECTED"];
        if (SYSTEM_PARKABLE.includes(task.status)) {
          await taskState.transition(ctx, input.taskId, "IN_PROGRESS", { kind: "system" });
        } else if (OWNER_PARKABLE.includes(task.status) && task.ownerAgentId) {
          await taskState.transition(ctx, input.taskId, "IN_PROGRESS", {
            kind: "agent",
            agentId: task.ownerAgentId,
          });
        }
        if (
          task.status === "IN_PROGRESS" ||
          SYSTEM_PARKABLE.includes(task.status) ||
          (OWNER_PARKABLE.includes(task.status) && task.ownerAgentId !== null)
        ) {
          await taskState.transition(ctx, input.taskId, "BLOCKED", { kind: "system" }, {
            note: `workflow crash: ${reason.slice(0, 200)}`,
          });
        }
      } catch (err) {
        // yarış ya da zaten terminal/BLOCKED — bildirim yine de gitsin
        console.warn("crash handler: task transition skipped", err);
      }

      let managerId: string | null = null;
      try {
        const [edge] = await guardedDb
          .select({ managerId: orgEdges.toAgentId })
          .from(orgEdges)
          .where(
            and(
              eq(orgEdges.companyId, ctx.companyId),
              eq(orgEdges.kind, "reports_to"),
              eq(orgEdges.fromAgentId, input.agentId),
              isNull(orgEdges.endedAt),
            ),
          );
        managerId = edge?.managerId && edge.managerId !== input.agentId ? edge.managerId : null;
      } catch {
        managerId = null;
      }

      await guardedDb.transaction(async (tx) => {
        await emitDomainEvent(tx, ctx, {
          type: "agent.escalated",
          actor: { kind: "system", id: null },
          agentId: input.agentId,
          taskId: input.taskId,
          payload: {
            ...(managerId ? { toAgentId: managerId } : { toFounder: true }),
            reason: `workflow crash: ${reason}`,
            attempted: [],
            recommendation: "manager intervention: reassign or retry",
          },
        });
      });

      // 33 §2.2 "manager notified (help-request message)" — task thread'ine DM
      try {
        const thread = await guardedDb.transaction((tx) =>
          channelService.provisionInTx(tx, ctx, {
            kind: "task_thread",
            taskId: input.taskId,
            memberAgentIds: managerId ? [input.agentId, managerId] : [input.agentId],
          }),
        );
        const plan = await messageService.send(ctx, {
          channelId: thread.id,
          senderAgentId: input.agentId,
          kind: "help_request",
          body:
            `[manager] Koşum çöktü; görev BLOCKED durumda bekliyor.\n\n` +
            `Hata: ${reason}\n\n` +
            `Görevi yeniden dene (BLOCKED→IN_PROGRESS çekip koşumu başlat) veya başka bir ajana devret.`,
          refs: [{ kind: "task", id: input.taskId }],
          ...(managerId && { mentions: [managerId] }),
          idempotencyKey: uuidv5("crash-help", input.sessionId),
        });
        if (deps.signalPort) await deliverMessage(guardedDb, ctx, plan, deps.signalPort);
      } catch {
        /* mesaj tavsiyedir; BLOCKED durumu + escalation olayı zaten kalıcı */
      }

      if (managerId) {
        // request_help ile aynı mekanik: boştaki yöneticinin koşan oturumu
        // yoksa P1 müdahale görevi kuyruğuna girer ve döngüsü uyandırılır
        try {
          const [liveSession] = await guardedDb
            .select({ id: agentSessions.id })
            .from(agentSessions)
            .where(
              and(
                eq(agentSessions.companyId, ctx.companyId),
                eq(agentSessions.agentId, managerId),
                inArray(agentSessions.status, ["starting", "running"]),
              ),
            )
            .limit(1);
          if (!liveSession) {
            // request_help uyandirmasiyla AYNI kural: parent'siz ama projesiz
            // DEGIL — coken kosumun gorevi hangi projedeyse mudahale gorevi de
            // oraya ait (workspace + maliyet rollup'i icin).
            const [crashedTask] = await guardedDb
              .select({ projectId: tasks.projectId })
              .from(tasks)
              .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
            const helpTask = await tasksService.create(
              ctx,
              {
                id: uuidv5("crash-help-task", input.sessionId), // idempotent replay
                kind: "task",
                projectId: crashedTask?.projectId ?? undefined,
                title: "Çöken koşum: yönetici müdahalesi gerekli",
                objective:
                  `Bir ajanın koşumu çöktü ve görevi BLOCKED bekliyor. ` +
                  `İlgili görevi incele; yeniden dene ya da devret.\n\nHata: ${reason}`.slice(0, 4000),
                priority: "P1",
              },
              { kind: "founder" }, // create matrisi founder|agent ister
            );
            // founder aktörü: 07 §5 matrisi DRAFT→BACKLOG→PLANNED'da system'e
            // izin vermez (request_help uyandırmasındaki gizli kırılmanın aynısı)
            for (const to of ["BACKLOG", "PLANNED"] as const) {
              await taskState.transition(ctx, helpTask.id, to, { kind: "founder" });
            }
            await taskState.assign(ctx, helpTask.id, { agentId: managerId }, { kind: "founder" });
            await deps.startAgentWorkflow?.({
              companyId: ctx.companyId,
              agentId: managerId,
              taskId: helpTask.id,
            });
          }
        } catch (err) {
          console.warn("crash handler: manager wake failed", err);
        }
      } else {
        // reports_to zinciri boş (kök ajan) → zincirin sonu Founder'dır
        try {
          const result = await guardedDb.execute(sql`
            SELECT cm.user_id FROM company_members cm
            WHERE cm.company_id = ${ctx.companyId} AND cm.role = 'founder' AND cm.removed_at IS NULL
            LIMIT 1
          `);
          const founder = result.rows[0] as { user_id: string } | undefined;
          if (founder) {
            await guardedDb.insert(notifications).values({
              companyId: ctx.companyId,
              userId: founder.user_id,
              kind: "agent_crash",
              title: "Bir ajanın koşumu çöktü — görev BLOCKED",
              bodyMd:
                `Yöneticisi olmayan bir ajanın koşumu çöktü; görevi BLOCKED durumda bekliyor.\n\n` +
                `Hata: ${reason}\n\nGörevi yeniden başlatın veya devredin.`,
              refs: { taskId: input.taskId, agentId: input.agentId, sessionId: input.sessionId },
            });
          }
        } catch (err) {
          console.warn("crash handler: founder notification failed", err);
        }
      }
    },

    async closeAgentSessionActivity(input: SessionRef & {
      status: "completed" | "failed" | "cancelled";
    }): Promise<void> {
      const ctx = companyContext(input.companyId);
      await guardedDb.transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(agentSessions)
          .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)))
          .for("update");
        if (!session || session.endedAt) return; // idempotent
        await tx
          .update(agentSessions)
          .set({ status: input.status, currentActivity: "IDLE", endedAt: sql`now()` })
          .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)));
        await emitDomainEvent(tx, ctx, {
          type: "agent.session.ended",
          actor: { kind: "system", id: null },
          agentId: input.agentId,
          taskId: input.taskId,
          payload: {
            sessionId: input.sessionId,
            status: input.status,
            steps: session.stepsCount,
            tokens: session.tokensIn + session.tokensOut,
            costCents: session.costCents,
          },
        });
        await emitDomainEvent(tx, ctx, {
          type: "agent.status.changed",
          actor: { kind: "system", id: null },
          agentId: input.agentId,
          payload: { sessionId: input.sessionId, from: "WORKING", to: "IDLE" },
        });
      });
      rt(input, "agent.status", { payload: { status: input.status, activity: "IDLE" } });
    },
  };
}

export type AgentTaskActivities = ReturnType<typeof createAgentTaskActivities>;

/** Prod routing loader: agent bindings + company profiles from the DB. */
export function createDbRoutingLoader(guardedDb: GuardedDb) {
  return async (ctx: CompanyContext, agentId: string): Promise<RoutingContext> => {
    // Sistem-cagrilari (intake analizi, B4 sentezi) agentId="" ile gelir —
    // bos string uuid karsilastirmasi Postgres'te patlar ve tum analiz
    // sessizce degrade olurdu; binding'siz devam et (sirket profilleri yeter).
    const bindings = agentId
      ? await guardedDb
          .select()
          .from(agentModelBindings)
          .where(and(eq(agentModelBindings.companyId, ctx.companyId), eq(agentModelBindings.agentId, agentId)))
      : [];
    const profiles = await guardedDb
      .select()
      .from(modelProfiles)
      .where(and(eq(modelProfiles.companyId, ctx.companyId), eq(modelProfiles.enabled, true)));
    return {
      bindings: bindings.map((b) => ({
        purpose: b.purpose as "primary" | "fast" | "embedding",
        providerId: b.providerId,
        model: b.model,
        params: (b.params ?? {}) as Record<string, unknown>,
        priority: b.priority,
      })),
      profiles: profiles.map((p) => ({
        purpose: p.purpose as RoutingContext["profiles"][number]["purpose"],
        providerId: p.providerId,
        model: p.model,
        params: (p.params ?? {}) as Record<string, unknown>,
        priority: p.priority,
        enabled: p.enabled,
        maxTokensPerCall: p.maxTokensPerCall,
        costCapCentsPerCall: p.costCapCentsPerCall,
      })),
    };
  };
}
