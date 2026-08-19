// Workflows registered on the agent-tasks queue (09 §4). T31 ships the
// scaffold: a trivial round-trip workflow proving worker registration,
// activity dispatch and result plumbing. agentTaskWorkflow / agentInbox /
// review land in T32/T33. Determinism rules of 09 §6 apply to EVERYTHING in
// this directory — no IO, no Date.now/Math.random outside Temporal APIs.
import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/index.js";

const { echoActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30s",
  retry: { maximumAttempts: 3 },
});

export interface PingInput {
  companyId: string;
  note: string;
}

/** Trivial round-trip: workflow → activity → transformed result (T31 accept). */
export async function pingWorkflow(input: PingInput): Promise<string> {
  const echoed = await echoActivity(input.note);
  return `pong:${input.companyId}:${echoed}`;
}

export {
  agentTaskWorkflow,
  type AgentTaskInput,
  type AgentTaskOutcome,
} from "./agent-task.workflow.js";
export {
  agentInboxWorkflow,
  type AgentInboxInput,
  type AgentInboxOutcome,
} from "./agent-inbox.workflow.js";
export {
  reviewWorkflow,
  type ReviewWorkflowInput,
  type ReviewWorkflowOutcome,
} from "./review.workflow.js";
