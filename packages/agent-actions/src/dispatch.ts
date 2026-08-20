// Ajan EYLEM DAĞITICISI — şirket iskeletinin tek uygulama yeri (08 §3).
//
// Bu kod worker'ın `executeActionActivity`'si içinde yaşıyordu. Ajan turu
// konteynerde koşan bir CLI oturumu da olabildiğinde (E4/Decision A) aynı
// fiillerin MCP üzerinden de sunulması gerekti — ve tek meşru yol TAŞIMAKTI.
// apps/server'da yeniden yazmak görev durumuna İKİNCİ bir yazar koyardı;
// INV-13 tek yazar der, yani kopya en baştan yasaktır.
//
// Burası bir "ortak ev": worker aktivitesi de, MCP sunucusu da bu fonksiyonu
// çağırır. Kararların kendisi (durum makinesi, izin matrisi, kapasite,
// onaylar, INV-14 incelemeci≠yazar, roll-up) @acos/db'deki servislerde durur;
// buradaki iş onları AYNI sırayla ve aynı yan etkilerle sürmektir.
//
// Taşıma kuralı: davranış birebir korunur. Bir satırın ANLAMINI değiştirmek
// gerekiyorsa o AYRI bir commit'tir — taşımanın kanıtı, mevcut worker
// testlerinin hiç değişmeden aynı sonucu vermesidir.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { uuidv5 } from "@acos/domain";
import { parseEventPayload } from "@acos/events";
import {
  ApprovalError,
  ApprovalsService,
  ChannelService,
  DelegationService,
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
  type NewEventInput,
  type SignalPort,
  type Tx,
} from "@acos/db";
import {
  agentSessions,
  agentSteps,
  approvals as approvalsTable,
  artifacts as artifactsTable,
  notifications,
  orgEdges,
  tasks,
  workspaces as workspacesTable,
} from "@acos/db/schema";
import {
  CONTEXT_SENTINEL_UUID,
  SELF_SENTINEL_UUID,
  type AgentAction,
} from "@acos/llm/agent-action";
import type { RuntimeEventType } from "@acos/contracts";

/** Oturum kimliği — bir eylemin KİM adına, HANGİ görevde yürüdüğü. */
export interface SessionRef {
  companyId: string;
  agentId: string;
  taskId: string;
  sessionId: string;
}

export interface RuntimeEventInput {
  type: RuntimeEventType;
  sessionId?: string | null | undefined;
  agentId?: string | null | undefined;
  taskId?: string | null | undefined;
  stepNo?: number | null | undefined;
  opId?: string | null | undefined;
  payload?: Record<string, unknown> | undefined;
}

export interface RuntimeEventPort {
  emit(companyId: string, event: RuntimeEventInput): void;
  close(): Promise<void>;
}

/** Uzun süren işlem boyunca "hâlâ çalışıyor" nabzı (LIVE-CONSOLE TASK 3). */
export function startOperationHeartbeat(
  port: RuntimeEventPort | undefined,
  companyId: string,
  base: Omit<RuntimeEventInput, "type" | "payload"> & { operationType: string },
  intervalMs = 10_000,
): () => void {
  if (!port) return () => {};
  const startedAt = Date.now();
  const timer = setInterval(() => {
    port.emit(companyId, {
      type: "op.heartbeat",
      sessionId: base.sessionId,
      agentId: base.agentId,
      taskId: base.taskId,
      stepNo: base.stepNo,
      opId: base.opId,
      payload: {
        operationType: base.operationType,
        startedAt,
        elapsedMs: Date.now() - startedAt,
        status: "running",
      },
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** rt.* yayıncısı — fire-and-forget; yayıncı yoksa sessiz no-op. */
export function makeRuntimeEmitter(port: RuntimeEventPort | undefined) {
  return (
    ref: SessionRef,
    type: RuntimeEventType,
    extra?: {
      stepNo?: number | undefined;
      opId?: string | undefined;
      payload?: Record<string, unknown> | undefined;
    },
  ): void => {
    port?.emit(ref.companyId, {
      type,
      sessionId: ref.sessionId,
      agentId: ref.agentId,
      taskId: ref.taskId,
      stepNo: extra?.stepNo ?? null,
      opId: extra?.opId ?? null,
      payload: extra?.payload,
    });
  };
}

export async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
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

export interface ActionDispatchDeps {
  guardedDb: GuardedDb;
  /** Post-commit mesaj teslimi (11 §4.4); dar testlerde yok. */
  signalPort?: SignalPort | undefined;
  /** Atama → sahibin workflow'u (09 §4). En iyi çaba. */
  startAgentWorkflow?:
    | ((input: { companyId: string; agentId: string; taskId: string }) => Promise<void>)
    | undefined;
  /** use_tool → Tool Gateway (17 §4). Yoksa T40 öncesi stub gözlemi korunur. */
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
  runtimeEvents?: RuntimeEventPort | undefined;
  /** request_review → bağımsız incelemecinin reviewWorkflow'u (T43). */
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

export function createActionDispatcher(deps: ActionDispatchDeps) {
  const { guardedDb } = deps;
  const taskState = new TaskStateService(guardedDb);
  const channelService = new ChannelService(guardedDb);
  const messageService = new MessageService(guardedDb, channelService);
  const tasksService = new TasksService(guardedDb);
  const delegationService = new DelegationService(guardedDb, tasksService, taskState);
  const approvalsService = new ApprovalsService(guardedDb);
  const reviewsService = new ReviewsService(guardedDb);
  const rt = makeRuntimeEmitter(deps.runtimeEvents);

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

  /**
   * 07 §2: `goal` ve `initiative` KONTEYNERDİR — kendi işleri yoktur, "nobody
   * reviews a goal"; durumları çocuklardan TÜRETİLİR (A5 roll-up, task-engine
   * `rollUpContainer`). Canlı kanıt (golden path stage 10, 2026-08-19):
   * complete_task/request_review görev türüne bakmadan REVIEW'a taşıyordu;
   * konteyner REVIEW'da kilitleniyor, inceleme kaydı da açılamıyordu (iş ürünü
   * yok) → hem inceleme hem roll-up zinciri ölü. Konteyner artık REVIEW'a
   * taşınmaz: sahibi sonucu yazar, kapanış çocuklar terminal olunca roll-up ile
   * gelir.
   */
  const CONTAINER_KINDS = new Set(["goal", "initiative"]);

  async function taskKindOf(ctx: CompanyContext, taskId: string): Promise<string | null> {
    const [row] = await guardedDb
      .select({ kind: tasks.kind })
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
    return row?.kind ?? null;
  }

  /** Konteynerin açık çocuk sayısı — gözlemde sahibe geri bildirilir. */
  async function openChildrenOf(ctx: CompanyContext, taskId: string): Promise<number> {
    const rows = await guardedDb
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.parentId, taskId)));
    const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED", "REJECTED"]);
    return rows.filter((r) => !TERMINAL.has(r.status)).length;
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
      // T53: bu dal eskiden `if (reviewer && deps.startReviewWorkflow)` idi ve
      // dep YOKSA hiçbir iz bırakmadan atlıyordu — "başlatıldı" ile "hiç
      // başlatılmadı" ayırt EDİLEMİYORDU. E4 canlı run #2'nin platosu buydu:
      // sunucunun MCP dispatcher'ında dep eksikti, `reviews` satırı `pending`
      // açılıyor, görev REVIEW'da kalıyor, sweep §4 bu hali kasten dışladığı
      // için kilit kendini açmıyordu. P0-2'de aynı yolda yutulan
      // REVIEW_NO_ELIGIBLE_REVIEWER ile AYNI SINIF sessizlik; ikinci ağzı da
      // kapatıyoruz. `startedWorkflow` çağırana gerçeği söyler.
      let startedWorkflow = false;
      if (review.reviewerAgentId) {
        if (deps.startReviewWorkflow) {
          await deps.startReviewWorkflow({
            companyId: ctx.companyId,
            reviewId: review.id,
            taskId,
            reviewerAgentId: review.reviewerAgentId,
            authorAgentId,
          });
          startedWorkflow = true;
        } else {
          console.warn(
            "review opened but no startReviewWorkflow dependency is wired — the reviewer's turn will NOT start; the task stays in REVIEW until the stuck-task sweep reopens it",
            {
              companyId: ctx.companyId,
              taskId,
              reviewId: review.id,
              reviewerAgentId: review.reviewerAgentId,
              authorAgentId,
            },
          );
        }
      }
      return { reviewId: review.id, reviewerAgentId: review.reviewerAgentId, startedWorkflow };
    } catch (err) {
      if (err instanceof ReviewError &&
          (err.code === "REVIEW_TASK_INVALID" || err.code === "REVIEW_NO_ELIGIBLE_REVIEWER")) {
        // P0-2: bu null eskiden TAM sessizdi — görev REVIEW'da, inceleyecek
        // kimse yok, hiçbir yüzeyde iz yok. Escalation olayı + Founder
        // notification'ı görünür kılar; stuck sweep'in review-yetim kuralı
        // kadro tamamlanınca incelemeyi yeniden açar.
        if (err.code === "REVIEW_NO_ELIGIBLE_REVIEWER") {
          await guardedDb
            .transaction(async (tx) => {
              await emitDomainEvent(tx, ctx, {
                type: "agent.escalated",
                actor: { kind: "system", id: null },
                agentId: authorAgentId,
                taskId,
                payload: {
                  toFounder: true,
                  reason:
                    "Görev REVIEW'a taşındı ama inceleme-yetkin ajan yok (INV-14: yazar kendini inceleyemez) — reviewer/lead işe alınana kadar bekleyecek",
                  attempted: [],
                  recommendation: "hire a lead/reviewer or review manually",
                },
              });
              const founderRow = await tx.execute(sql`
                SELECT cm.user_id FROM company_members cm
                WHERE cm.company_id = ${ctx.companyId} AND cm.role = 'founder' AND cm.removed_at IS NULL
                LIMIT 1
              `);
              const founder = founderRow.rows[0] as { user_id: string } | undefined;
              if (founder) {
                await tx.insert(notifications).values({
                  companyId: ctx.companyId,
                  userId: founder.user_id,
                  kind: "review_blocked",
                  title: "İnceleme bekliyor: uygun reviewer yok",
                  bodyMd:
                    "Bir görev REVIEW'a taşındı ama şirkette inceleme-yetkin (reviewer/lead/manager) başka ajan yok. " +
                    "Bir lider işe alın — kadro tamamlanınca inceleme otomatik yeniden açılır.",
                  refs: { taskId },
                });
              }
            })
            .catch(() => {
              /* görünürlük best-effort; REVIEW durumu zaten kalıcı */
            });
        }
        return null; // toolless/projectless task or a one-agent org — transition-only
      }
      throw err;
    }
  }

  return {
    /** Action dispatch (08 §3): tek durum yazarı, gateway'li araç çağrısı,
     *  think no-op. Worker'ın executeActionActivity'si ve MCP sunucusu AYNI
     *  bu fonksiyonu çağırır — iki yazar olmaz (INV-13). */
    async dispatch(input: SessionRef & {
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
              // Modelin YANLIŞ hedef durum seçmesi bir altyapı arızası
              // DEĞİLDİR. create_task/delegate_task'ta olduğu gibi (guard f)
              // yapılandırılmış gözlem döner ve ajan bir sonraki Working
              // Set'te düzeltir. A7 canlı koşumu (2026-08-19): CEO görev
              // ASSIGNED'ken WAITING istedi, TaskEngineError buradan yeniden
              // fırlatıldı, aktivite düştü, iş akışı çöktü ve hedef GOAL
              // görevi BLOCKED'a park etti — tek bir kötü aksiyon seçimi
              // yüzünden şirketin en üst konteyneri kilitlendi.
              return {
                ok: false,
                error: err.code,
                detail: err.message,
                currentStatus: current?.status ?? null,
              };
            }
            if (err instanceof TaskEngineError) {
              return { ok: false, error: err.code, detail: err.message };
            }
            throw err;
          }
        }
        case "request_review": {
          // owner submits: IN_PROGRESS→REVIEW (07 §5) + the code review row
          // with an INDEPENDENT reviewer whose workflow starts now (T43)
          const taskId = selfTask(action.taskId);
          // 07 §2: konteyner incelenmez — çocuklarından türetilir
          if (CONTAINER_KINDS.has((await taskKindOf(ctx, taskId)) ?? "")) {
            const open = await openChildrenOf(ctx, taskId);
            return {
              ok: true,
              container: true,
              reviewRequested: false,
              openChildren: open,
              note:
                open > 0
                  ? `Bu bir konteyner görev (07 §2): incelenmez, ${open} açık alt görev bitince kendiliğinden kapanır. Alt görevleri takip et.`
                  : "Bu bir konteyner görev (07 §2): incelenmez; alt görevler terminal olduğunda roll-up ile kapanır.",
            };
          }
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
            // T53: `reviewStarted:false` = satır açıldı ama incelemecinin turu
            // BAŞLAMADI. Gözlem yüzeyinde görünmesi şart; aksi halde ajan da
            // denetim de bunu başarılı bir devir sanır.
            ...(opened && {
              reviewId: opened.reviewId,
              reviewerAgentId: opened.reviewerAgentId,
              reviewStarted: opened.startedWorkflow,
            }),
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
            if (toAgentId === SELF_SENTINEL_UUID) {
              // T29 (Founder karari 2026-08-20): yonetici kendi bolduyu isin
              // bir dilimini KENDI ustlenebilir. Bu ACIK bir niyettir; TASK 12
              // yetenek-override'i buraya UYGULANMAZ, cunku o kural CEO'nun
              // ILGISIZ bir ajana is dayatmasini engellemek icindir — kendi alt
              // gorevinin sorumlulugunu almak dayatma degildir (07 §6, izin
              // katmani zaten kendine atamayi onaylar). Tavan hala capacityCheck:
              // is yoneticinin KENDI WIP limitine sayilir, doluysa reddedilir ve
              // model delege etmeye yonelir.
              toAgentId = input.agentId;
            } else if (toAgentId === CONTEXT_SENTINEL_UUID) {
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
                  // Uyandirma gorevi is kirilimninin COCUGU degildir — parent'siz
                  // kalir (07 §2 tur merdiveni: bir 'task'i initiative'in altina
                  // asmak rollup'lari bozardi). AMA projesiz de kalmamali:
                  // WorkspaceService.provision task.projectId istiyor ve
                  // workspaces.project_id NOT NULL, yani projesiz uyandirma
                  // gorevi yoneticiye workspace ACAMIYOR (canli kanit: TASK-6,
                  // Kevin E4 kosusu 2026-08-20 — steps-path'e dusup REVIEW'da
                  // kapandi) ve harcamasi proje rollup'ina islenmiyor. Cozum:
                  // HAKKINDA oldugu gorevin projesini kalit.
                  const [aboutTask] = await guardedDb
                    .select({ projectId: tasks.projectId })
                    .from(tasks)
                    .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
                  const helpTask = await tasksService.create(
                    ctx,
                    {
                      id: uuidv5("help-task", input.stepId), // idempotent replay
                      kind: "task",
                      projectId: aboutTask?.projectId ?? undefined,
                      title: `Yardım talebi: ${action.topic}`.slice(0, 200),
                      objective:
                        `${plan.message.id} numaralı yardım mesajını yanıtla. ` +
                        `Talep eden ajanla DM üzerinden ilerle; çözemiyorsan kendi escalate'inle yukarı taşı.\n\n${action.body}`.slice(0, 4000),
                      priority: "P1",
                    },
                    { kind: "founder" }, // create matrisi founder|agent ister
                  );
                  // groom da founder aktörüyle: 07 §5 matrisi DRAFT→BACKLOG→
                  // PLANNED'da system'e izin vermez — system ile bu zincir
                  // TASK_TRANSITION_INVALID fırlatıyordu ve aşağıdaki catch
                  // yuttuğu için yönetici uyandırma sessizce hiç çalışmamıştı
                  for (const to of ["BACKLOG", "PLANNED"] as const) {
                    await taskState.transition(ctx, helpTask.id, to, { kind: "founder" });
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
          // 07 §2: konteyner (goal/initiative) REVIEW'a taşınmaz — sonucu
          // yazılır, kapanışı çocuk roll-up'ı getirir (task-engine A5 guard'ı
          // zaten doğrudan DONE'ı reddediyor; buradaki REVIEW hop'u ise görevi
          // ölü uçta bırakıyordu: inceleme kaydı açılamaz, roll-up beklenir).
          if (CONTAINER_KINDS.has((await taskKindOf(ctx, input.taskId)) ?? "")) {
            await guardedDb
              .update(tasks)
              .set({ result: action.result })
              .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
            const open = await openChildrenOf(ctx, input.taskId);
            return {
              ok: true,
              completed: false,
              container: true,
              reviewRequested: false,
              openChildren: open,
              note:
                open > 0
                  ? `Konteyner görev (07 §2): sonucun kaydedildi ama kapanış ${open} açık alt görevin bitmesine bağlı — roll-up otomatik kapatır.`
                  : "Konteyner görev (07 §2): sonucun kaydedildi; alt görevler terminal olduğunda roll-up kapatır.",
            };
          }
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
                ...(opened && { reviewId: opened.reviewId, reviewStarted: opened.startedWorkflow }),
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
  };
}


export type ActionDispatcher = ReturnType<typeof createActionDispatcher>;
