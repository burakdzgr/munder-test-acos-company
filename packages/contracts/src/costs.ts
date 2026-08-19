// Costs + Reports API (T49; 26 §9/§12): dashboard aggregates, ledger
// drill-down, burn-rate forecast and the executive report list.
import { z } from "zod";

export const CostAggregateRowSchema = z.object({
  key: z.string(), // group key: kind | agent id | project id | task id
  name: z.string().nullable(), // resolved display name where applicable
  amountCents: z.number().int(),
});

export const CostSummaryResponseSchema = z.object({
  totalCents: z.number().int(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  groups: z.array(CostAggregateRowSchema),
});
export type CostSummaryResponse = z.infer<typeof CostSummaryResponseSchema>;

/** Today's llm_calls aggregate for the top-bar token/cache pill (36 §9 — U11). */
export const LlmUsageResponseSchema = z.object({
  calls: z.number().int(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  tokensCached: z.number().int(),
  costCents: z.number().int(),
});
export type LlmUsageResponse = z.infer<typeof LlmUsageResponseSchema>;

export const CostEntryDtoSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  ref: z.string(),
  agentId: z.uuid().nullable(),
  taskId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  amountCents: z.number().int(),
  occurredAt: z.iso.datetime(),
});
export const CostEntriesResponseSchema = z.object({ items: z.array(CostEntryDtoSchema) });
export type CostEntriesResponse = z.infer<typeof CostEntriesResponseSchema>;

export const BudgetForecastRowSchema = z.object({
  budgetId: z.uuid(),
  scopeKind: z.string(),
  scopeRef: z.uuid().nullable(),
  period: z.string(),
  kind: z.string(), // hard | soft
  limitCents: z.number().int(),
  spentCents: z.number().int(),
  projectedCents: z.number().int(),
  breach: z.boolean(),
});
export const CostForecastResponseSchema = z.object({
  items: z.array(BudgetForecastRowSchema),
});
export type CostForecastResponse = z.infer<typeof CostForecastResponseSchema>;

export const ExecutiveReportDtoSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid().nullable(),
  projectName: z.string().nullable(),
  title: z.string(),
  contentMd: z.string().nullable(),
  createdByAgentName: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export const ReportListResponseSchema = z.object({
  items: z.array(ExecutiveReportDtoSchema),
});
export type ReportListResponse = z.infer<typeof ReportListResponseSchema>;
export type ExecutiveReportDto = z.infer<typeof ExecutiveReportDtoSchema>;
