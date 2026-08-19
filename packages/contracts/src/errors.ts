// Stable error-code catalog + RFC7807 problem+json envelope (21 §2.5).
import { z } from "zod";

export const ERROR_CODES = {
  validation_failed: 400,
  unauthenticated: 401,
  budget_exceeded: 402,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  task_transition_invalid: 409,
  org_cycle_detected: 409,
  dependency_cycle_detected: 409,
  idempotency_conflict: 409,
  approval_required: 409,
  state_precondition_failed: 412,
  payload_too_large: 413,
  rate_limited: 429,
  provider_unavailable: 503,
  internal: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ProblemJsonSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.enum(Object.keys(ERROR_CODES) as [ErrorCode, ...ErrorCode[]]),
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ProblemJson = z.infer<typeof ProblemJsonSchema>;

export const PROBLEM_TYPE_BASE = "https://acos.dev/errors/";

export function problemFor(
  code: ErrorCode,
  detail?: string,
  extras?: Partial<Pick<ProblemJson, "instance" | "requestId" | "errors" | "title">>,
): ProblemJson {
  return {
    type: `${PROBLEM_TYPE_BASE}${code}`,
    title: extras?.title ?? code.replaceAll("_", " "),
    status: ERROR_CODES[code],
    code,
    ...(detail !== undefined && { detail }),
    ...(extras?.instance !== undefined && { instance: extras.instance }),
    ...(extras?.requestId !== undefined && { requestId: extras.requestId }),
    ...(extras?.errors !== undefined && { errors: extras.errors }),
  };
}
