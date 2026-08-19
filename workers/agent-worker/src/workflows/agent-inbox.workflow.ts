// agentInboxWorkflow (08 §7): idle employees are reachable without paying for
// a full loop. One per agent (signalWithStart), buffers inboxItem signals,
// 5s debounce, cheap-model triage → act | queue | ignore, completes after
// 10 minutes idle. Cost of an idle agent ≈ zero.
import { condition, proxyActivities, setHandler, sleep } from "@temporalio/workflow";
import type { createAgentTaskActivities } from "../activities/agent-task.js";
import { inboxItemSignal, type InboxItemSignal } from "./signals.js";

const activities = proxyActivities<ReturnType<typeof createAgentTaskActivities>>({
  startToCloseTimeout: "60s",
  retry: { maximumAttempts: 3 },
});

export interface AgentInboxInput {
  companyId: string;
  agentId: string;
}

export interface AgentInboxOutcome {
  triaged: number;
  verdicts: string[];
}

const DEBOUNCE_MS = 5_000;
const IDLE_COMPLETE_MS = 10 * 60_000;

export async function agentInboxWorkflow(input: AgentInboxInput): Promise<AgentInboxOutcome> {
  const buffer: InboxItemSignal[] = [];
  const seen = new Set<string>();
  let triaged = 0;
  const verdicts: string[] = [];

  setHandler(inboxItemSignal, (item) => {
    if (seen.has(item.signalId)) return;
    seen.add(item.signalId);
    if (buffer.length < 50) buffer.push(item);
  });

  for (;;) {
    const woke = await condition(() => buffer.length > 0, IDLE_COMPLETE_MS);
    if (!woke) break; // 10 minutes idle — the workflow completes (08 §7)
    await sleep(DEBOUNCE_MS); // batch the burst
    const batch = buffer.splice(0, buffer.length);
    const { verdict } = await activities.triageInboxActivity({
      companyId: input.companyId,
      agentId: input.agentId,
      items: batch,
    });
    triaged += batch.length;
    verdicts.push(verdict);
    // act/queue elaboration (reply send, task creation) deepens with T36;
    // every verdict marks the items read so unread badges stay truthful
    await activities.markInboxReadActivity({
      companyId: input.companyId,
      agentId: input.agentId,
      channelIds: batch.map((b) => b.channelId),
    });
  }
  return { triaged, verdicts };
}
