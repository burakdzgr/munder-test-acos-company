// Server-side workflow start twin (09 §5, T36): the ONLY place the server
// starts agentTaskWorkflows — deterministic ids + REJECT_DUPLICATE mirror
// workers/agent-worker/src/client.ts. Wired in main.ts when Temporal is up;
// assignment handlers call it post-commit, best-effort (the DB assignment is
// authoritative; a worker restart re-drives from Postgres state).
import { WorkflowIdReusePolicy } from "@temporalio/client";
import { and, eq, inArray } from "drizzle-orm";
import { uuidv7 } from "@acos/domain";
import { TASK_QUEUES } from "@acos/config";
import type { GuardedDb } from "@acos/db";
import { agentSessions } from "@acos/db/schema";

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
): AgentWorkflowStarter {
  return async (input) => {
    try {
      // Ajan başına TEK canlı oturum (2026-08-18, Founder kararı: "aynı kişiye
      // 2 task atanırsa sıraya girer, tek tek ilerler"). Aynı ajana ikinci
      // atama workflow BAŞLATMAZ — görev ASSIGNED durumda kuyrukta bekler;
      // oturum kapanınca session-ended drain'i (main.ts) sıradakini başlatır.
      // Aynı görevin yeniden başlatılması (restart/sweep) engellenmez.
      // Kaynak çakışmasının kökü buydu: Emre TASK-43 ve TASK-44'ü aynı anda
      // koşturuyor, 44 43'e bağımlı olduğu için kendi kendini kilitliyordu.
      if (guardedDb) {
        const [live] = await guardedDb
          .select({ taskId: agentSessions.taskId })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.companyId, input.companyId),
              eq(agentSessions.agentId, input.agentId),
              inArray(agentSessions.status, ["starting", "running"]),
            ),
          )
          .limit(1);
        if (live && live.taskId !== input.taskId) return false; // kuyrukta
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
