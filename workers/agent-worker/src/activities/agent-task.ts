// agentTaskWorkflow activities (08 §3, T32). All IO of the loop lives here;
// the workflow only orchestrates. Effects are exactly-once at the DB via
// stepId-derived idempotency keys (08 §11). Task transitions go through the
// ONE status writer (TaskStateService — @acos/db/task-engine).
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { uuidv5 } from "@acos/domain";
import { parseEventPayload } from "@acos/events";
import {
  ApprovalError,
  ApprovalsService,
  ChannelService,
  CostService,
  DelegationService,
  MemoryRetrievalService,
  MessageService,
  ReviewError,
  ReviewsService,
  TaskEngineError,
  TasksService,
  TaskStateService,
  appendEvents,
  companyContext,
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
  llmCalls,
  modelProfiles,
  orgEdges,
  positions,
  projects,
  repositories,
  tasks,
  workspaces as workspacesTable,
} from "@acos/db/schema";
import { outputLanguageDirective } from "@acos/llm";
import type { ModelRouter, RoutingContext, LlmMessage, LlmUsage } from "@acos/llm";
import { CONTEXT_SENTINEL_UUID, type AgentAction } from "@acos/llm/agent-action";
import { FENCE_PREAMBLE, provenanceFence } from "@acos/tools";
import type { RuntimeEventType } from "@acos/contracts";
import { startOperationHeartbeat, type RuntimeEventPort } from "../runtime-events.js";
import {
  contextBudgetForRole,
  estimateTokens,
  type WorkingSetTelemetry,
} from "./context-budget.js";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

/**
 * The canonical 32 §6.1 script tool names → registry tools (T40, recorded
 * mapping): scripted sessions speak `write_file`/`run_command`; the gateway
 * registry speaks `fs.write`/`terminal.run`. Live models are prompted with
 * registry names directly, so unknown names pass through untouched and the
 * gateway fail-closes on them.
 */
export function mapToolCall(
  tool: string,
  input: unknown,
): { toolName: string; input: unknown } {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "write_file":
      return {
        toolName: "fs.write",
        input: {
          path: args.path,
          content:
            typeof args.content === "string"
              ? args.content
              : `// ${String(args.contentRef ?? "generated")}`,
        },
      };
    case "run_command":
    case "run_tests":
      return { toolName: "terminal.run", input: { command: args.command ?? "npm test" } };
    case "read_file":
      return { toolName: "fs.read", input: { path: args.path } };
    default:
      return { toolName: tool, input: args };
  }
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
  const delegationService = new DelegationService(guardedDb, tasksService, taskState);
  const costService = new CostService(guardedDb);
  const approvalsService = new ApprovalsService(guardedDb);
  const reviewsService = new ReviewsService(guardedDb);
  const retrievalService = new MemoryRetrievalService(guardedDb);

  /** LIVE-CONSOLE TASK 2: canlı lifecycle olayı — fire-and-forget, asla
   *  döngüyü etkilemez (yayıncı yoksa no-op). */
  const rt = (
    ref: SessionRef,
    type: RuntimeEventType,
    extra?: {
      stepNo?: number | undefined;
      opId?: string | undefined;
      payload?: Record<string, unknown> | undefined;
    },
  ): void => {
    deps.runtimeEvents?.emit(ref.companyId, {
      type,
      sessionId: ref.sessionId,
      agentId: ref.agentId,
      taskId: ref.taskId,
      stepNo: extra?.stepNo ?? null,
      opId: extra?.opId ?? null,
      payload: extra?.payload,
    });
  };

  /** Checkpoint before review (T43, recorded): the submit implies "my work
   *  is on the branch" — an automatic commit (allowEmpty) + push makes the
   *  diff reviewable and the branch mergeable; the squash collapses WIP
   *  commits anyway (15 §3.4). Best-effort: toolless flows have no gateway. */
  async function checkpointBranch(input: SessionRef & { stepId: string }): Promise<void> {
    if (!deps.invokeTool) return;
    // only when the task ALREADY worked in a workspace — a toolless task must
    // not have a workspace provisioned as a review side effect
    const [live] = await guardedDb
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(
        and(
          eq(workspacesTable.companyId, input.companyId),
          eq(workspacesTable.taskId, input.taskId),
          sql`${workspacesTable.status} IN ('ready','in_use','idle')`,
        ),
      )
      // C2/Y5: deterministic pick — a task owns one workspace now, but rows
      // created before that fix can still be duplicated
      .orderBy(asc(workspacesTable.createdAt))
      .limit(1);
    if (!live) return;
    try {
      await deps.invokeTool({
        companyId: input.companyId,
        agentId: input.agentId,
        taskId: input.taskId,
        agentSessionId: input.sessionId,
        toolName: "git.commit",
        input: { message: "chore: review checkpoint", allowEmpty: true },
        // O4: the key used to be `${sessionId}:${Date.now() >> 13}` — an
        // ~8-second bucket. Under at-least-once activity execution a retry
        // that landed in the next bucket got a NEW key and committed twice,
        // and a replay could never match the original key at all. The step id
        // is the canonical idempotency anchor everywhere else in this file
        // (08 §11); the checkpoint now uses it too.
        idempotencyKey: uuidv5("checkpoint-commit", input.stepId),
      });
      await deps.invokeTool({
        companyId: input.companyId,
        agentId: input.agentId,
        taskId: input.taskId,
        agentSessionId: input.sessionId,
        toolName: "git.branch",
        input: { force: true }, // task/* only — rebase-safe (15 §3.7)
        idempotencyKey: uuidv5("checkpoint-push", input.stepId),
      });
    } catch {
      /* no workspace (toolless) or gateway down — review can still proceed */
    }
  }

  /** request_review / review-shaped complete_task: open (or reset) the code
   *  review row and start the independent reviewer's workflow (T43). Tool-
   *  less tasks (no project/workspace) keep the pre-T43 transition-only path. */
  async function openCodeReview(ctx: CompanyContext, taskId: string, authorAgentId: string) {
    try {
      const { review } = await reviewsService.requestReview(ctx, {
        taskId,
        authorAgentId,
      });
      if (review.reviewerAgentId && deps.startReviewWorkflow) {
        await deps.startReviewWorkflow({
          companyId: ctx.companyId,
          reviewId: review.id,
          taskId,
          reviewerAgentId: review.reviewerAgentId,
          authorAgentId,
        });
      }
      return { reviewId: review.id, reviewerAgentId: review.reviewerAgentId };
    } catch (err) {
      if (err instanceof ReviewError &&
          (err.code === "REVIEW_TASK_INVALID" || err.code === "REVIEW_NO_ELIGIBLE_REVIEWER")) {
        return null; // toolless/projectless task or a one-agent org — transition-only
      }
      throw err;
    }
  }

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
        `- {"type":"request_review","taskId":"<uuid>","artifactId":"<uuid>","summary":"<=2000"}`,
        `- {"type":"request_help","topic":"<=200","body":"<=4000","audience":"peer|team|lead|manager|specialist"} — blokajlarda İLK adres: audience:"manager" seçersen yöneticin uyandırılır ve DM ile yanıt verir; cevabı wait_for {"what":"reply"} ile bekle`,
        `- {"type":"escalate","reason":"<=2000","attempted":["..."],"options":[{"option":"...","risk":"...","cost":"..."}],"recommendation":"..."} — Founder'a resmi onay talebi. SON ÇAREDİR: önce request_help(manager) dene; escalate yalnız (a) yöneticin çözemedi/yanıtlamadı, (b) karar gerçekten Founder-seviyesi (bütçe/politika/geri döndürülemez etki) ise`,
        `- {"type":"update_task_status","taskId":"<uuid>","to":"IN_PROGRESS|WAITING|BLOCKED|REVIEW","note":"<=1000"}`,
        `- {"type":"record_decision","title":"<=200","decision":"...","alternatives":["..."],"consequences":"..."}`,
        `- {"type":"complete_task","result":{"summary":"...","criteria":[{"criterion":"...","met":true,"evidence":"..."}],"artifactIds":[],"cost":{"tokensIn":0,"tokensOut":0,"cents":0}}}`,
        `- {"type":"wait_for","what":"dependency|reply|review|approval|timer","refId":"<uuid>"?,"timeoutMinutes":1-1440}`,
        `- {"type":"abandon","reason":"<=2000"}`,
        `Special uuid ${CONTEXT_SENTINEL_UUID} = "current context": own task (create_task.parentTaskId), next unassigned child (delegate_task.taskId), an eligible report (delegate_task.toAgentId), own task thread (send_message.channelId).`,
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
      await guardedDb.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: llmCalls.id })
          .from(llmCalls)
          .where(and(eq(llmCalls.companyId, ctx.companyId), eq(llmCalls.id, llmCallId)));
        if (existing) return; // retried activity — cost not double-counted
        await tx.insert(llmCalls).values({
          id: llmCallId,
          companyId: ctx.companyId,
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
          // TASK 7: bölüm bazlı input dağılımı — sonraki optimizasyonların
          // ölçüm kaynağı (Founder/Costs detayına gerek yok; veri burada)
          ...(input.contextTelemetry && {
            contextTelemetry: input.contextTelemetry as unknown as Record<string, unknown>,
          }),
        });
      });
      return {
        text: result.text,
        usage: result.usage,
        model: result.model,
        costCents: result.costCents,
        latencyMs: result.latencyMs,
      };
    },

    /** Action dispatch (08 §3). T32 scope: status moves via the single writer,
     *  stubbed tool execution (gateway lands T39/T40), think as no-op. */
    async executeActionActivity(input: SessionRef & {
      stepId: string;
      action: AgentAction;
    }): Promise<Record<string, unknown>> {
      const ctx = companyContext(input.companyId);
      const action = input.action;
      // TASK 2: model kararı anında Console'a düşer ("✓ Action: create_task")
      rt(input, "action.selected", {
        payload: {
          actionType: action.type,
          ...(action.type === "use_tool" && { tool: action.tool }),
        },
      });
      // context sentinel (T36): "my current task" in task-ref positions
      const selfTask = (id: string) => (id === CONTEXT_SENTINEL_UUID ? input.taskId : id);
      switch (action.type) {
        case "update_task_status": {
          // Idempotent under at-least-once execution (R1, T50): a worker
          // killed AFTER the transition committed but BEFORE the activity
          // result recorded re-executes this — "already in the target state"
          // is success, not an illegal self-transition.
          try {
            const updated = await taskState.transition(ctx, selfTask(action.taskId), action.to, {
              kind: "agent",
              agentId: input.agentId,
            }, { note: action.note });
            return { ok: true, status: updated.status };
          } catch (err) {
            if (err instanceof TaskEngineError && err.code === "TASK_TRANSITION_INVALID") {
              const [current] = await guardedDb
                .select({ status: tasks.status })
                .from(tasks)
                .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, selfTask(action.taskId))));
              if (current?.status === action.to) {
                return { ok: true, status: current.status, replayed: true };
              }
            }
            throw err;
          }
        }
        case "request_review": {
          // owner submits: IN_PROGRESS→REVIEW (07 §5) + the code review row
          // with an INDEPENDENT reviewer whose workflow starts now (T43)
          const taskId = selfTask(action.taskId);
          await checkpointBranch(input);
          const updated = await taskState.transition(ctx, taskId, "REVIEW", {
            kind: "agent",
            agentId: input.agentId,
          }, { note: action.summary });
          const opened = await openCodeReview(ctx, taskId, input.agentId);
          return {
            ok: true,
            status: updated.status,
            reviewRequested: true,
            ...(opened && { reviewId: opened.reviewId, reviewerAgentId: opened.reviewerAgentId }),
          };
        }
        case "use_tool": {
          // T40: every tool effect traverses the Tool Gateway (S3) — it
          // authorizes, audits, dispatches into the task workspace and
          // records cost. The observation keeps the exitCode shape scripted
          // branches key on ([lastExitCode:n]). Without a wired gateway
          // (narrow tests) the pre-T40 stub observation is preserved.
          if (!deps.invokeTool) {
            return { ok: true, tool: action.tool, exitCode: 0, stub: true, input: action.input };
          }
          const mapped = mapToolCall(action.tool, action.input);
          // S5 taint carry (18 §11.3): once any output in this session was
          // flagged, later tool calls run tainted — the gateway elevates the
          // effective risk one class (fail-secure sticky bit; recorded MVP
          // coarsening of the per-argument substring derivation)
          const [flaggedStep] = await guardedDb
            .select({ id: agentSteps.id })
            .from(agentSteps)
            .where(
              and(
                eq(agentSteps.companyId, ctx.companyId),
                eq(agentSteps.agentSessionId, input.sessionId),
                sql`${agentSteps.observation} ->> 'outputFlagged' = 'true'`,
              ),
            )
            .limit(1);
          // TASK 2/3: araç çağrısı boyunca started + heartbeat, sonda
          // completed (+kısa çıktı kuyruğu) — uzun npm/test koşularında
          // Founder "çalışıyor mu takıldı mı" sorusunu sayaçtan okur.
          const toolOpId = `tool:${input.stepId}`;
          const toolStartedAt = Date.now();
          rt(input, "tool.started", {
            opId: toolOpId,
            payload: { tool: mapped.toolName },
          });
          const stopToolHeartbeat = startOperationHeartbeat(
            deps.runtimeEvents,
            input.companyId,
            {
              sessionId: input.sessionId,
              agentId: input.agentId,
              taskId: input.taskId,
              opId: toolOpId,
              operationType: `tool:${mapped.toolName}`,
            },
          );
          let res: Awaited<ReturnType<NonNullable<typeof deps.invokeTool>>>;
          try {
            res = await deps.invokeTool({
              companyId: input.companyId,
              agentId: input.agentId,
              taskId: input.taskId,
              agentSessionId: input.sessionId,
              toolName: mapped.toolName,
              input: mapped.input,
              ...(flaggedStep && { tainted: true }),
              // deterministic per step ⇒ Temporal retries replay the result
              idempotencyKey: `tool:${input.stepId}`,
            });
          } catch (err) {
            stopToolHeartbeat();
            rt(input, "tool.completed", {
              opId: toolOpId,
              payload: {
                tool: mapped.toolName,
                ok: false,
                error: String(err).slice(0, 200),
                durationMs: Date.now() - toolStartedAt,
              },
            });
            throw err;
          }
          stopToolHeartbeat();
          const output = (res.output ?? {}) as { exitCode?: number };
          const exitCode =
            res.status === "succeeded" ? (output.exitCode ?? 0) : (output.exitCode ?? 1);
          const flaggedNow = (res as { outputFlagged?: boolean }).outputFlagged === true;
          {
            // tool.output: yalnız KISA yapılandırılmış kuyruk (chain-of-thought
            // değil, ham dev çıktı değil — PTY zaten term.* hattında akıyor)
            const out = (res.output ?? {}) as Record<string, unknown>;
            const tailSource = out.stdoutTail ?? out.stderrTail ?? out.summary ?? out.content;
            if (typeof tailSource === "string" && tailSource.length > 0) {
              rt(input, "tool.output", {
                opId: toolOpId,
                payload: { tool: mapped.toolName, tail: tailSource.slice(-400) },
              });
            }
            rt(input, "tool.completed", {
              opId: toolOpId,
              payload: {
                tool: mapped.toolName,
                ok: res.status === "succeeded",
                exitCode,
                decision: res.decision,
                durationMs: Date.now() - toolStartedAt,
              },
            });
          }
          return {
            ok: res.status === "succeeded",
            tool: action.tool,
            decision: res.decision,
            status: res.status,
            exitCode,
            ...(res.output !== undefined && { output: res.output }),
            ...(flaggedNow && {
              outputFlagged: true,
              flaggedPatterns: (res as { flaggedPatterns?: string[] }).flaggedPatterns ?? [],
            }),
            ...(res.reason !== null && { reason: res.reason }),
            ...(res.error !== undefined && { error: res.error }),
            ...(res.costCents !== undefined && { costCents: res.costCents }),
            ...(res.retryAfterSec !== undefined && { retryAfterSec: res.retryAfterSec }),
          };
        }
        case "send_message": {
          // sentinel channel = the agent's own task thread (T36)
          let channelId = action.channelId;
          if (channelId === CONTEXT_SENTINEL_UUID) {
            const thread = await guardedDb.transaction((tx) =>
              channelService.provisionInTx(tx, ctx, {
                kind: "task_thread",
                taskId: input.taskId,
                memberAgentIds: [input.agentId],
              }),
            );
            channelId = thread.id;
          }
          // the ONE send path (11 §0.2) + post-commit delivery via SignalPort
          const plan = await messageService.send(ctx, {
            channelId,
            senderAgentId: input.agentId,
            kind: action.kind === "text" ? "text" : action.kind,
            body: action.body,
            refs: action.refs,
            mentions: action.mentions,
            idempotencyKey: uuidv5("msg", input.stepId),
          });
          if (deps.signalPort) {
            await deliverMessage(guardedDb, ctx, plan, deps.signalPort);
          }
          return { ok: true, messageId: plan.message.id, recipients: plan.recipients.length };
        }
        case "wait_for": {
          // Walkthrough bulgusu (2026-08-19): model, onayı ÇOKTAN verilmiş
          // bir kararı beklemeye yatabiliyor (verdict sinyali escalate
          // adımında tüketildi) → 15 dk boş uyku. Onay bekleyişi DB'den
          // anında çözülür: görevin son onayı kararlaşmışsa hiç uyuma.
          if (action.what === "approval") {
            const [latest] = await guardedDb
              .select({ status: approvalsTable.status, note: approvalsTable.decisionNote })
              .from(approvalsTable)
              .where(
                and(
                  eq(approvalsTable.companyId, ctx.companyId),
                  eq(approvalsTable.taskId, input.taskId),
                ),
              )
              .orderBy(sql`${approvalsTable.createdAt} DESC`)
              .limit(1);
            if (latest && latest.status !== "pending" && latest.status !== "needs_review") {
              rt(input, "wait.started", {
                payload: { what: "approval", alreadyResolved: true, verdict: latest.status },
              });
              return {
                ok: true,
                waiting: "approval",
                alreadyResolved: true,
                verdict: latest.status,
                note: latest.note,
              };
            }
          }
          // status move only — the workflow owns the Temporal condition (08 §6)
          const [current] = await guardedDb
            .select({ status: tasks.status })
            .from(tasks)
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
          if (current?.status === "IN_PROGRESS") {
            await taskState.transition(ctx, input.taskId, "WAITING", {
              kind: "agent",
              agentId: input.agentId,
            }, { note: `waiting for ${action.what}` });
          }
          // 2026-08-18: oturum da WAITING'e geçer — Founder terminal hücresi
          // "Çalışıyor" yerine dürüstçe "Bekliyor" göstersin (resume geri alır)
          await guardedDb
            .update(agentSessions)
            .set({ currentActivity: "WAITING" })
            .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)));
          rt(input, "wait.started", {
            payload: { what: action.what, timeoutMinutes: Math.min(action.timeoutMinutes, 15) },
          });
          rt(input, "agent.status", { payload: { activity: "WAITING" } });
          return { ok: true, waiting: action.what };
        }
        case "create_task": {
          // depth ≤ 5 enforced inside (07 §2); the structured error appears
          // in the next Working Set instead of crashing the loop (guard f)
          try {
            const child = await delegationService.createChildTask(ctx, input.agentId, {
              // natural idempotency key (R1, T50): same delegator + same
              // parent + same title = the same intended child. Survives BOTH
              // an activity replay after a worker kill AND a scripted-session
              // cursor reset (the fake LLM re-runs its script from the top
              // after a restart — live models are stateless per call).
              id: uuidv5(
                `create-task:${input.agentId}:${action.title}`,
                selfTask(action.parentTaskId),
              ),
              parentTaskId: selfTask(action.parentTaskId),
              kind: action.kind,
              title: action.title,
              objective: action.objective,
              priority: action.priority,
              estimatedEffort: action.estimatedEffort,
              successCriteria: action.successCriteria,
              risk: action.risk,
              orgUnitId: action.orgUnitId,
              requiredCapabilities: action.requiredCapabilities,
            });
            rt(input, "task.created", {
              payload: { taskId: child.id, number: child.number, title: action.title },
            });
            return { ok: true, taskId: child.id, number: child.number };
          } catch (err) {
            if (err instanceof TaskEngineError) {
              return { ok: false, error: err.code, detail: err.message };
            }
            throw err;
          }
        }
        case "delegate_task": {
          try {
            // sentinel task = the oldest unassigned child of the current
            // task; sentinel target = @-mention in the note, else the
            // least-loaded eligible direct report (T36)
            let taskId = action.taskId;
            if (taskId === CONTEXT_SENTINEL_UUID) {
              const child = await delegationService.resolveNextChildTask(ctx, input.taskId);
              if (!child) return { ok: false, error: "NO_UNASSIGNED_CHILD" };
              taskId = child.id;
            }
            let toAgentId = action.toAgentId;
            let schedulerOverride = false;
            if (toAgentId === CONTEXT_SENTINEL_UUID) {
              const target = await delegationService.resolveDelegateTarget(
                ctx,
                input.agentId,
                action.note,
                taskId,
              );
              if (!target)
                return {
                  ok: false,
                  error: "NO_ELIGIBLE_DELEGATE",
                  hint: "Delege edecek uygun rapor YOK — önce use_tool agent.hire {capability, count} ile ekibi kur (bu görevde Founder onayı varsa anında çalışır), sonra delege et.",
                };
              toAgentId = target;
            } else {
              // TASK 12 (INVARIANT 10): atamanın deterministic sahibi
              // Scheduler'dır. Açıkça verilen hedef, görevin
              // requiredCapabilities filtresinden geçen adaylar arasında
              // değilse Scheduler'ın seçimi geçerli olur — CEO ilgisiz
              // ajana dayatma yaparak onay mekanizmasını bypass edemez.
              const candidates = await delegationService.scoreDelegateCandidates(
                ctx,
                input.agentId,
                taskId,
              );
              if (
                candidates.length > 0 &&
                !candidates.some((c) => c.agentId === toAgentId)
              ) {
                toAgentId = candidates[0]!.agentId;
                schedulerOverride = true;
              }
            }
            const result = await delegationService.delegateTask(ctx, input.agentId, taskId, toAgentId);
            if (result.ok && deps.startAgentWorkflow) {
              // assignment triggers the owner's workflow (09 §4) —
              // post-commit, best-effort; a duplicate start is swallowed
              await deps
                .startAgentWorkflow({ companyId: ctx.companyId, agentId: toAgentId, taskId })
                .catch(() => {});
            }
            if (result.ok) {
              rt(input, "task.delegated", { payload: { taskId, toAgentId } });
            }
            return result.ok
              ? {
                  ok: true,
                  delegated: true,
                  taskId,
                  toAgentId,
                  ...(schedulerOverride && {
                    note: "Scheduler hedefi değiştirdi: istenen ajan görev yeteneklerine uymuyordu",
                  }),
                }
              : { ok: false, error: result.reason, candidates: result.candidates };
          } catch (err) {
            if (err instanceof TaskEngineError) {
              return { ok: false, error: err.code, detail: err.message };
            }
            throw err;
          }
        }
        case "escalate": {
          // Approval Engine entry (19 §7, T35): compose the 11-field brief
          // from the action + task context (canonical 08 §4 escalate carries
          // a subset — missing fields are filled with explicit placeholders,
          // recorded deviation from 19 §10's action-carries-brief ideal),
          // create the pending approval idempotently, park the task; the
          // workflow then blocks on approvalVerdict until the derived expiry.
          const [task] = await guardedDb
            .select()
            .from(tasks)
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
          if (!task) return { ok: false, error: "TASK_NOT_FOUND" };
          // Walkthrough bulgusu (2026-08-19): model, onaylanmış kararı taze
          // bağlamda göremeyip AYNI görev için tekrar tekrar onay üretiyordu
          // (Founder'a mükerrer kart). Kural: görev başına TEK açık onay —
          // son onay kararlaşmışsa YENİ onay yerine karar CEVAP olarak döner;
          // bekleyen varsa aynı kayıt döner.
          {
            const [latest] = await guardedDb
              .select({
                id: approvalsTable.id,
                status: approvalsTable.status,
                note: approvalsTable.decisionNote,
                createdAt: approvalsTable.createdAt,
              })
              .from(approvalsTable)
              .where(
                and(
                  eq(approvalsTable.companyId, ctx.companyId),
                  eq(approvalsTable.taskId, input.taskId),
                ),
              )
              .orderBy(sql`${approvalsTable.createdAt} DESC`)
              .limit(1);
            if (latest) {
              if (latest.status === "pending" || latest.status === "needs_review") {
                return {
                  ok: true,
                  approvalId: latest.id,
                  approvalStatus: latest.status,
                  duplicateSuppressed: true,
                  note: "Bu görev için zaten bekleyen bir onay var — Founder'ın kararını bekle (wait_for approval), yenisini üretme.",
                };
              }
              if (latest.status === "approved") {
                return {
                  ok: true,
                  approvalId: latest.id,
                  approvalStatus: "approved",
                  alreadyApproved: true,
                  founderNote: latest.note,
                  note: "Founder bu görevin onayını ZATEN VERDİ. Tekrar onay isteme — planına göre HEMEN harekete geç (takım kur / görev oluştur / delege et).",
                };
              }
              if (latest.status === "rejected") {
                return {
                  ok: true,
                  approvalId: latest.id,
                  approvalStatus: "rejected",
                  alreadyRejected: true,
                  founderNote: latest.note,
                  note: "Founder bu görevin son onayını REDDETTİ. Aynı isteği tekrarlama; notu dikkate alıp farklı bir yol seç ya da görevi kapat.",
                };
              }
            }
          }
          const [session] = await guardedDb
            .select({ workflowId: agentSessions.workflowId })
            .from(agentSessions)
            .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)));
          const options = action.options.slice(0, 10).map((o) => ({
            option: o.option.slice(0, 500),
            pros: "",
            cons: o.risk.slice(0, 500),
            cost_cents: 0,
          }));
          while (options.length < 2) {
            options.push({
              option: options.length === 0 ? "Proceed as requested" : "Do not proceed",
              pros: options.length === 0 ? "unblocks the task" : "no cost or risk incurred",
              cons: options.length === 0 ? "carries the stated risk" : "the request stays unfulfilled",
              cost_cents: 0,
            });
          }
          const urgency =
            task.priority === "P0" ? "critical" : task.priority === "P1" ? "high" : "normal";
          const brief = {
            title: `Approval: ${task.title}`.slice(0, 120),
            request: action.reason.slice(0, 1200),
            reason: action.reason.slice(0, 1200),
            attempted:
              action.attempted.length > 0
                ? action.attempted.map((a) => a.slice(0, 500))
                : ["(no autonomous attempts recorded by the agent)"],
            options,
            recommendation: action.recommendation.slice(0, 1200) || "(none given)",
            risk: `${task.risk} — escalated from TASK-${task.number}`,
            cost: { amount_cents: 0, currency: "USD" },
            impact: `Approved: TASK-${task.number} ("${task.title}") proceeds. Rejected: the agent adjusts the plan or abandons.`.slice(0, 1200),
            urgency: `${urgency} — derived from task priority ${task.priority}`,
            deadline: task.deadline?.toISOString() ?? null,
          };
          try {
            const { row, created } = await approvalsService.create(ctx, {
              id: uuidv5("approval", input.stepId),
              kind: "other",
              brief,
              requestedByAgentId: input.agentId,
              risk: task.risk,
              urgency,
              deadline: task.deadline,
              taskId: input.taskId,
              workflowId: session?.workflowId ?? undefined,
            });
            if (created) {
              await guardedDb.transaction((tx) =>
                emitDomainEvent(tx, ctx, {
                  type: "agent.escalated",
                  actor: { kind: "agent", id: input.agentId },
                  taskId: input.taskId,
                  agentId: input.agentId,
                  payload: {
                    reason: action.reason,
                    attempted: action.attempted,
                    recommendation: action.recommendation,
                  },
                }),
              );
            }
            if (task.status === "IN_PROGRESS") {
              await taskState.transition(ctx, input.taskId, "WAITING", {
                kind: "agent",
                agentId: input.agentId,
              }, { note: `awaiting approval ${row.id}` });
            }
            rt(input, "approval.requested", {
              payload: { approvalId: row.id, title: brief.title, status: row.status },
            });
            return {
              ok: true,
              approvalId: row.id,
              approvalStatus: row.status,
              expiresAt: approvalsService.expiresAt(row).toISOString(),
            };
          } catch (err) {
            if (err instanceof ApprovalError) {
              return { ok: false, error: err.code, detail: err.message };
            }
            throw err;
          }
        }
        case "think":
          return { ok: true, thought: true };
        /**
         * Y1 (2026-08-15 kod incelemesi): iki aksiyon kataloğa yazılıydı ama
         * dispatch'te yoktu — `default`'a düşüp "not yet wired" hatası
         * veriyordu. INV-16 yardım isteme yolunu ŞART koşuyor; record_decision
         * ise plan-döngüsü sayacına giriyordu, yani ajan reddedilen bir
         * aksiyonu tekrarlayıp guard'ı tetikliyordu.
         */
        case "request_help": {
          // yardım isteği = yönetici/uzman hattına yapılandırılmış mesaj
          const thread = await guardedDb.transaction((tx) =>
            channelService.provisionInTx(tx, ctx, {
              kind: "task_thread",
              taskId: input.taskId,
              memberAgentIds: [input.agentId],
            }),
          );
          const plan = await messageService.send(ctx, {
            channelId: thread.id,
            senderAgentId: input.agentId,
            kind: "help_request",
            body: `[${action.audience}] ${action.topic}\n\n${action.body}`,
            refs: [{ kind: "task", id: input.taskId }],
            ...(action.targetAgentId && { mentions: [action.targetAgentId] }),
            idempotencyKey: uuidv5("help", input.stepId),
          });
          if (deps.signalPort) {
            await deliverMessage(guardedDb, ctx, plan, deps.signalPort);
          }
          // 2026-08-18 (Founder kararı — "onaylar önce yetkili liderine"):
          // DM yalnız KOŞAN oturumlara sinyal taşır; boştaki yönetici yardım
          // isteğini hiç görmüyordu ve talep sessizce zaman aşımına gidiyordu.
          // Yönetici boşsa P1 müdahale görevi açılıp ona atanır — kuyruğuna
          // girer, döngüsü uyanır, DM'i okuyup yanıtlar (istek sahibinin
          // wait'i artık gelen mesajla uyanıyor). Yönetici de çözemezse KENDİ
          // escalate'i zinciri yukarı taşır; Founder yalnız zincirin sonudur.
          if (action.audience === "manager") {
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
              const managerId = edge?.managerId;
              if (managerId && managerId !== input.agentId) {
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
                  const helpTask = await tasksService.create(
                    ctx,
                    {
                      id: uuidv5("help-task", input.stepId), // idempotent replay
                      kind: "task",
                      title: `Yardım talebi: ${action.topic}`.slice(0, 200),
                      objective:
                        `${plan.message.id} numaralı yardım mesajını yanıtla. ` +
                        `Talep eden ajanla DM üzerinden ilerle; çözemiyorsan kendi escalate'inle yukarı taşı.\n\n${action.body}`.slice(0, 4000),
                      priority: "P1",
                    },
                    { kind: "founder" }, // create matrisi founder|agent ister
                  );
                  for (const to of ["BACKLOG", "PLANNED"] as const) {
                    await taskState.transition(ctx, helpTask.id, to, { kind: "system" });
                  }
                  // atama founder aktörüyle: sistem aktörü assign matrisinde yok; bu
                  // uyandırma Founder kararının (2026-08-18) mekanik uygulamasıdır
                  await taskState.assign(ctx, helpTask.id, { agentId: managerId }, { kind: "founder" });
                  await deps.startAgentWorkflow?.({
                    companyId: ctx.companyId,
                    agentId: managerId,
                    taskId: helpTask.id,
                  });
                }
              }
            } catch (err) {
              // yardım DM'i zaten teslim edildi — uyandırma best-effort kalır
              console.warn("help-request manager wake failed", err);
            }
          }
          return {
            ok: true,
            helpRequested: true,
            messageId: plan.message.id,
            recipients: plan.recipients.length,
          };
        }
        case "record_decision": {
          // karar kaydı = ADR benzeri artefakt (07 §10 artifact yolu).
          // Walkthrough bulgusu (2026-08-19): kind 'decision' artifacts_kind_check
          // kısıtında YOK — her tam karar kaydı loop'u düşürüyordu. Kanonik
          // liste sabittir (20 §): 'document' + meta.type ile yazılır.
          const [artifact] = await guardedDb
            .insert(artifactsTable)
            .values({
              companyId: ctx.companyId,
              taskId: input.taskId,
              kind: "document",
              meta: { type: "decision" },
              title: `Karar: ${action.title}`.slice(0, 200),
              contentMd: [
                `# ${action.title}`,
                "",
                `## Karar`,
                action.decision,
                "",
                `## Değerlendirilen alternatifler`,
                ...action.alternatives.map((a) => `- ${a}`),
                "",
                `## Sonuçlar`,
                action.consequences,
              ].join("\n"),
              createdByAgentId: input.agentId,
            })
            .returning({ id: artifactsTable.id });
          return { ok: true, decisionRecorded: true, artifactId: artifact?.id ?? null };
        }
        case "complete_task": {
          // 07 §10 + 16-durum makinesi: sahibin "bitti"si görevi yetkili
          // olduğu kadar İLERLETİR — result kaydedilir, iş REVIEW'a taşınır
          // ve inceleme açılır (kalite zinciri REVIEW→QA→DONE dışarıdan
          // tamamlanır; T43 rework'ünde owner kendi işini onaylayamaz).
          // 2026-08-14 saha bulgusu: eski hali ASSIGNED görevde HİÇBİR ŞEY
          // yapmadan "completed" diyordu — görev yerinde kalıyor, döngü
          // kapanıyordu (ilk canlı mühendis koşusu tam böyle yetim kaldı).
          const [row] = await guardedDb
            .select({ status: tasks.status })
            .from(tasks)
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
          if (!row) return { ok: false, error: "TASK_NOT_FOUND" };
          const owner = { kind: "agent" as const, agentId: input.agentId };
          if (["ASSIGNED", "IN_PROGRESS", "CHANGES_REQUESTED"].includes(row.status)) {
            try {
              // 07 §10 sonuç sözleşmesi tasks.result'a yazılır (şema zaten
              // AgentActionSchema'da doğrulandı)
              await guardedDb
                .update(tasks)
                .set({ result: action.result })
                .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
              if (row.status !== "IN_PROGRESS") {
                await taskState.transition(ctx, input.taskId, "IN_PROGRESS", owner);
              }
              await checkpointBranch(input);
              await taskState.transition(ctx, input.taskId, "REVIEW", owner, {
                note: action.result.summary.slice(0, 500),
              });
              const opened = await openCodeReview(ctx, input.taskId, input.agentId);
              return {
                ok: true,
                completed: false,
                reviewRequested: true,
                ...(opened && { reviewId: opened.reviewId }),
              };
            } catch (err) {
              if (err instanceof TaskEngineError) {
                return { ok: false, error: err.code, detail: err.message };
              }
              throw err;
            }
          }
          return { ok: true, completed: true };
        }
        case "abandon":
          return { ok: true, abandoned: true, reason: action.reason };
        default: {
          // Y1 (2026-08-15): the 13 AgentAction types are now ALL wired, so
          // this branch is unreachable — kept as an exhaustiveness guard that
          // fails loudly if a new action type is added to the schema without
          // a dispatch case (rather than silently returning "not yet wired").
          const unreachable: never = action;
          return {
            ok: false,
            error: `unhandled action kind: ${JSON.stringify(unreachable).slice(0, 120)}`,
          };
        }
      }
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
