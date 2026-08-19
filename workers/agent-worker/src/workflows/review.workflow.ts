// reviewWorkflow (T43; 09 §4, 15 §2/§5): the independent reviewer's bounded
// run — start the review, decide, submit; the verdict activity drives every
// follow-up (rework re-entry, the QA round, the lead merge). Pure
// orchestration; all IO lives in the review activities.
import { proxyActivities } from "@temporalio/workflow";
import type { ReviewActivities } from "../review/activities.js";

const review = proxyActivities<ReviewActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

export interface ReviewWorkflowInput {
  companyId: string;
  reviewId: string;
  taskId: string;
  reviewerAgentId: string;
  authorAgentId: string;
}

export interface ReviewWorkflowOutcome {
  verdict: "approved" | "changes_requested";
  taskStatus: string;
  merged: boolean;
}

export async function reviewWorkflow(input: ReviewWorkflowInput): Promise<ReviewWorkflowOutcome> {
  const started = await review.startReviewActivity({
    companyId: input.companyId,
    reviewId: input.reviewId,
    reviewerAgentId: input.reviewerAgentId,
  });
  const decision = await review.decideReviewActivity({
    companyId: input.companyId,
    reviewId: input.reviewId,
    taskId: input.taskId,
    kind: started.kind,
  });
  const submitted = await review.submitReviewVerdictActivity({
    companyId: input.companyId,
    reviewId: input.reviewId,
    taskId: input.taskId,
    reviewerAgentId: input.reviewerAgentId,
    verdict: decision.verdict,
    note: decision.note,
  });
  return {
    verdict: decision.verdict,
    taskStatus: submitted.taskStatus,
    merged: submitted.merged,
  };
}
