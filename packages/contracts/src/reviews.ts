// Reviews API (T43; 15 §2.1): the PR entity — list per task + the branch
// diff for the review UI (15 §3.5: small diffs render without a container).
import { z } from "zod";

export const ReviewDtoSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  kind: z.enum(["code", "architecture", "qa", "security"]),
  branch: z.string(),
  status: z.enum(["pending", "in_review", "approved", "changes_requested", "blocked"]),
  authorAgentId: z.uuid(),
  authorName: z.string().nullable(),
  reviewerAgentId: z.uuid().nullable(),
  reviewerName: z.string().nullable(),
  verdictMd: z.string().nullable(),
  mergedCommit: z.string().nullable(),
  createdAt: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
});
export type ReviewDto = z.infer<typeof ReviewDtoSchema>;

export const ReviewListResponseSchema = z.object({ items: z.array(ReviewDtoSchema) });
export type ReviewListResponse = z.infer<typeof ReviewListResponseSchema>;

export const ReviewDiffResponseSchema = z.object({
  diff: z.string(),
  truncated: z.boolean(),
});
export type ReviewDiffResponse = z.infer<typeof ReviewDiffResponseSchema>;
