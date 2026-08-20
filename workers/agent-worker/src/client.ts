// Workflow start paths (09 §5): ALL starts go through this module (and its
// apps/server twin) so ID conventions and dedupe live in one place.
// Deterministic IDs; REJECT_DUPLICATE for agent-task (a double start is a bug
// we want surfaced); signalWithStart for inbox (race-free wake-or-start).
import {
  Client,
  Connection,
  WorkflowIdReusePolicy,
  type WorkflowHandle,
} from "@temporalio/client";
import { TASK_QUEUES, WORKFLOW_IDS } from "@acos/config";

export const workflowIds = {
  agentTask: (taskId: string, agentId: string) => `agent-task.${taskId}.${agentId}`,
  agentInbox: (agentId: string) => `agent-inbox.${agentId}`,
  // T53/F3: the server starts this workflow too — the id lives in @acos/config
  // so "a duplicate start is harmless" cannot quietly stop being true.
  review: WORKFLOW_IDS.review,
  // 12 §5: `memory-consolidation-<company_id>-<trigger_ref>` — idempotent dedupe
  consolidation: (companyId: string, triggerRef: string) =>
    `memory-consolidation-${companyId}-${triggerRef}`,
  intake: (projectId: string) => `intake.${projectId}`,
} as const;

export interface WorkflowClientOptions {
  address: string;
  namespace?: string;
}

export async function createWorkflowClient(options: WorkflowClientOptions): Promise<{
  client: Client;
  connection: Connection;
}> {
  const connection = await Connection.connect({ address: options.address });
  const client = new Client({ connection, namespace: options.namespace ?? "acos" });
  return { client, connection };
}

/** agent-task starts: deterministic id + REJECT_DUPLICATE (09 §5). Rework
 *  re-entry (T43) passes `allowReentry` — the prior run CLOSED at
 *  request_review, so the id may be reused for the next run; concurrent
 *  duplicates are still rejected by ALLOW_DUPLICATE's running-check. */
export async function startAgentTaskWorkflow<T>(
  client: Client,
  workflowType: string | ((input: T) => Promise<unknown>),
  input: T & { taskId: string; agentId: string },
  opts: { allowReentry?: boolean } = {},
): Promise<WorkflowHandle> {
  return client.workflow.start(workflowType as string, {
    taskQueue: TASK_QUEUES.agentTasks,
    workflowId: workflowIds.agentTask(input.taskId, input.agentId),
    workflowIdReusePolicy: opts.allowReentry
      ? WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_ALLOW_DUPLICATE
      : WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
    args: [input],
  });
}

/** inbox: signalWithStart — wake the running inbox or start it, race-free. */
export async function signalAgentInbox<S>(
  client: Client,
  workflowType: string,
  input: { companyId: string; agentId: string },
  signal: { name: string; payload: S },
): Promise<WorkflowHandle> {
  return client.workflow.signalWithStart(workflowType, {
    taskQueue: TASK_QUEUES.agentTasks,
    workflowId: workflowIds.agentInbox(input.agentId),
    args: [input],
    signal: signal.name,
    signalArgs: [signal.payload],
  });
}
