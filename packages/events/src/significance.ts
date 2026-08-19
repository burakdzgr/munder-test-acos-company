// Memory significance (12 §5.0, 10 §5). Doc 12 §5.0 defines "significant
// events" as the event-catalog subset flagged `memory_significant: true` in
// `packages/events` — task transitions, review verdicts, build/test results,
// escalations, decisions and messages of kind `help_request`/`escalation`.
//
// Recorded MVP narrowing (previously duplicated inside
// `packages/db/src/memory.ts`): the subset is matched by type prefix instead of
// a per-definition catalog flag. This module is now the SINGLE definition —
// the consolidation trigger window (`MemoryConsolidationService.loadTaskWindow`)
// and the `memory-trigger` N-significant-events counter must never disagree
// about what counts.
export const MEMORY_SIGNIFICANT_PREFIXES = [
  "task.",
  "review.",
  "tool.invocation.",
  "workspace.",
] as const;

export const MEMORY_SIGNIFICANT_TYPES = ["agent.escalated", "agent.message.sent"] as const;

export function isMemorySignificant(eventType: string): boolean {
  return (
    MEMORY_SIGNIFICANT_PREFIXES.some((prefix) => eventType.startsWith(prefix)) ||
    (MEMORY_SIGNIFICANT_TYPES as readonly string[]).includes(eventType)
  );
}

/**
 * NATS subject filters covering exactly the significant subset for one
 * company wildcard (10 §5 `memory-trigger` row: "…significance counters on the
 * rest"). Kept overlap-free — JetStream rejects a consumer whose
 * `filter_subjects` overlap.
 */
export const MEMORY_SIGNIFICANT_SUBJECT_FILTERS: readonly string[] = [
  ...MEMORY_SIGNIFICANT_PREFIXES.map((prefix) => `co.*.${prefix}>`),
  ...MEMORY_SIGNIFICANT_TYPES.map((type) => `co.*.${type}`),
];
