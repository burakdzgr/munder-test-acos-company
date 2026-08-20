// Shared constants (28-REPOSITORY-STRUCTURE.md §2 `packages/config`).
// Names are binding (_DECISIONS.md §21, 09-WORKFLOW-ENGINE.md §4).

/** Temporal task queues (09 §4; 28 §2). */
export const TASK_QUEUES = {
  agentTasks: "agent-tasks",
  execution: "execution",
  memory: "memory",
  intake: "intake",
} as const;

export type TaskQueue = (typeof TASK_QUEUES)[keyof typeof TASK_QUEUES];

/**
 * Deterministic workflow ids that MORE THAN ONE process starts (09 §5).
 *
 * `reviewWorkflow` is started from three places — the worker (chained QA
 * round), the server's MCP dispatcher (T53) and the server's stuck-task sweep
 * (`review_reopened`/`review_never_started`). They must agree on the id,
 * because "a duplicate start is harmless" is TRUE ONLY while the string is
 * identical: two spellings would run the same review twice, concurrently.
 * That guarantee was resting on three separately-typed literals, so it lived
 * here instead.
 */
export const WORKFLOW_IDS = {
  review: (reviewId: string) => `review.${reviewId}`,
} as const;

/** NATS subject prefix — subjects are `co.<companyId>.<eventType>` (_DECISIONS.md §21). */
export const NATS_SUBJECT_PREFIX = "co." as const;

/** Default budgets / safety limits (26-COST-MANAGEMENT.md; overridable per company). */
export const DEFAULT_BUDGETS = {
  /** Company daily hard cap fallback when DEFAULT_COMPANY_DAILY_BUDGET_CENTS is unset. */
  companyDailyCents: 5000,
} as const;
