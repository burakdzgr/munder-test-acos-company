// The six workflow signals (08 §5) — shared definitions so senders (server
// delivery, review/approval engines, breaker) and handlers agree on names.
import { defineSignal } from "@temporalio/workflow";

export interface InboxItemSignal {
  signalId: string;
  messageId: string;
  channelId: string;
  senderAgentId: string | null;
  kind: string;
  preview: string;
  mentioned: boolean;
  sentAt: string;
}

export const messageReceivedSignal = defineSignal<[InboxItemSignal]>("messageReceived");
export const dependencyResolvedSignal =
  defineSignal<[{ dependsOnTaskId: string; result: "DONE" | "FAILED" | "CANCELLED" }]>(
    "dependencyResolved",
  );
export const reviewVerdictSignal =
  defineSignal<[{ reviewId: string; verdict: "accepted" | "changes_requested"; notes?: string }]>(
    "reviewVerdict",
  );
export const approvalVerdictSignal =
  defineSignal<[{ approvalId: string; verdict: "approved" | "rejected" | "needs_review" | "expired"; note?: string }]>(
    "approvalVerdict",
  );
export const managerDirectiveSignal =
  defineSignal<[{ directive: "pause" | "resume" | "reprioritize" | "rescope" | "handoff"; note?: string }]>(
    "managerDirective",
  );
export const cancelSignal = defineSignal<[{ by: string; reason: string }]>("cancel");

/**
 * E2/W5 (T19) — kadro önerisi kararı. Planlama iş akışı öneriyi yazdıktan
 * sonra İNSANI bekler; Founder onayla/iptal ettiğinde sunucu bu sinyali
 * öneriyi bekleyen iş akışına yollar (workflowId öneri satırında durur).
 */
export const staffingProposalDecidedSignal =
  defineSignal<[{ proposalId: string; decision: "confirmed" | "cancelled" }]>(
    "staffingProposalDecided",
  );

/** agentInboxWorkflow intake (08 §7). */
export const inboxItemSignal = defineSignal<[InboxItemSignal]>("inboxItem");
