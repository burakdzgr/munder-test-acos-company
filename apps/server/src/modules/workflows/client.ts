// Server-side workflow start twin (09 §5, T36): the ONLY place the server
// starts agentTaskWorkflows — deterministic ids + REJECT_DUPLICATE mirror
// workers/agent-worker/src/client.ts. Wired in main.ts when Temporal is up;
// assignment handlers call it post-commit, best-effort (the DB assignment is
// authoritative; a worker restart re-drives from Postgres state).
import { WorkflowIdReusePolicy } from "@temporalio/client";
import { uuidv7 } from "@acos/domain";
import { TASK_QUEUES, WORKFLOW_IDS } from "@acos/config";
import { checkSessionGate, type GuardedDb } from "@acos/db";

export interface AgentWorkflowStartInput {
  companyId: string;
  taskId: string;
  agentId: string;
}

/** true = started; false = already running (REJECT_DUPLICATE) or undeliverable. */
export type AgentWorkflowStarter = (input: AgentWorkflowStartInput) => Promise<boolean>;

export function createAgentWorkflowStarter(
  temporalClient: import("@temporalio/client").Client,
  onError: (err: unknown, input: AgentWorkflowStartInput) => void,
  guardedDb?: GuardedDb,
  /** E4/A (T30): şirket başına eşzamanlı canlı oturum tavanı. */
  maxLiveSessionsPerCompany?: number,
): AgentWorkflowStarter {
  return async (input) => {
    try {
      // Kapı TEK yerde yaşar (@acos/db checkSessionGate): ajan başına tek canlı
      // oturum (2026-08-18 Founder kararı) + şirket başına eşzamanlılık tavanı
      // (E4 — ajan turu bir CLI süreci olduğunda "N ajan = N süreç"). İkisinde
      // de görev BAŞARISIZ olmaz, ASSIGNED kuyruğunda bekler; oturum kapanınca
      // session-ended drain'i (main.ts) başlatır. Aynı görevin yeniden
      // başlatılması (restart/sweep) engellenmez.
      if (guardedDb) {
        const gate = await checkSessionGate(guardedDb, {
          companyId: input.companyId,
          agentId: input.agentId,
          taskId: input.taskId,
          maxLiveSessionsPerCompany,
        });
        if (!gate.ok) return false; // kuyrukta
      }
      await temporalClient.workflow.start("agentTaskWorkflow", {
        taskQueue: TASK_QUEUES.agentTasks,
        workflowId: `agent-task.${input.taskId}.${input.agentId}`,
        // 2026-08-18: REJECT_DUPLICATE, KAPALI (ölmüş/sonlandırılmış) bir
        // koşunun aynı id ile yeniden başlatılmasını da reddediyordu — A6
        // sweep'in "sahibinin döngüsü ölmüşse yeniden başlat" vaadi hiç
        // çalışamazdı. ALLOW_DUPLICATE eşzamanlılığı GEVŞETMEZ: aynı id'li
        // KOŞAN workflow her politikada AlreadyStarted ile reddedilir;
        // politika yalnız kapalı koşular için geçerlidir.
        workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE,
        args: [{ ...input, sessionId: uuidv7(), attempt: 1 }],
      });
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === "WorkflowExecutionAlreadyStartedError") return false;
      onError(err, input);
      return false;
    }
  };
}

// T53 (E4 canlı run #2 kök-nedeni): reviewWorkflow'u BAŞLATAN taraf. Sunucunun
// MCP dispatcher'ı `startReviewWorkflow` dep'i OLMADAN kuruluyordu; CLI şeridinde
// (Decision A) her `request_review` sunucudan geçtiği için inceleme zinciri HİÇ
// başlamıyordu: `reviews` satırı `pending` açılıyor, görev REVIEW'da kalıyor,
// incelemecinin turu hiç açılmıyor — ve stuck-task sweep'i bu hali kasten
// dışladığı için (§4 `NOT EXISTS pending|in_review`) kilit kendini AÇMIYORDU.
// Canlı kanıt (20:40): elle başlatılan TEK reviewWorkflow 300 ms'de tamamlandı,
// görev REVIEW→CHANGES_REQUESTED→IN_PROGRESS geçti ve rework turu kendiliğinden
// açıldı; dokunulmayan ikiz görev donuk kaldı. Eksik olan tek şey BAŞLATICIYDI.
export interface ReviewWorkflowStartInput {
  companyId: string;
  reviewId: string;
  taskId: string;
  reviewerAgentId: string;
  authorAgentId: string;
}

/** true = started (or already running); false = Temporal reddetti. */
export type ReviewWorkflowStarter = (input: ReviewWorkflowStartInput) => Promise<boolean>;

/** Id şeması TEK yerde (`WORKFLOW_IDS.review`, @acos/config): worker, bu starter
 *  ve sweep aynı stringi kullanmak ZORUNDA — "duplicate start yutulur" güvencesi
 *  yalnız string aynı kaldığı sürece doğru, iki yazım aynı incelemeyi iki kez
 *  koşturur. F3 (Jim review). */
export function createReviewWorkflowStarter(
  temporalClient: import("@temporalio/client").Client,
  onError: (err: unknown, input: ReviewWorkflowStartInput) => void,
): ReviewWorkflowStarter {
  return async (input) => {
    try {
      await temporalClient.workflow.start("reviewWorkflow", {
        taskQueue: TASK_QUEUES.agentTasks,
        workflowId: WORKFLOW_IDS.review(input.reviewId),
        args: [input],
      });
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === "WorkflowExecutionAlreadyStartedError") return true;
      onError(err, input);
      return false;
    }
  };
}
