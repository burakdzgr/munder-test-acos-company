// Temporal-backed SignalPort (11 §4.4): messageReceived into active sessions,
// signalWithStart into idle inboxes. Shared by worker activities and reusable
// from the server via the same shape.
import { Client } from "@temporalio/client";
import { TASK_QUEUES } from "@acos/config";
import type { SignalPort } from "@acos/db";

export function createTemporalSignalPort(client: Client): SignalPort {
  return {
    async signalActiveSession({ workflowId, item }) {
      try {
        await client.workflow.getHandle(workflowId).signal("messageReceived", item);
        return true;
      } catch {
        return false; // workflow gone — fall through to the inbox path
      }
    },
    async signalInbox({ companyId, agentId, item }) {
      await client.workflow.signalWithStart("agentInboxWorkflow", {
        taskQueue: TASK_QUEUES.agentTasks,
        workflowId: `agent-inbox.${agentId}`,
        args: [{ companyId, agentId }],
        signal: "inboxItem",
        signalArgs: [item],
      });
    },
  };
}
