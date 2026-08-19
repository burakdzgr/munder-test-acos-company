// MemoryCandidate — the extraction contract of 12 §5.1. Doc 12 places this
// file in packages/domain; domain carries ZERO runtime dependencies (T09), so
// the zod schema lives here in @acos/llm next to AgentAction (same recorded
// deviation, T30/T32) — the consolidation activities parse model output with
// it and the scripted fixtures are typed against it.
import { z } from "zod";

/** Extracted entity mentions (03 §7) — all facets optional, additive. */
export const MemoryEntitiesSchema = z.object({
  agents: z.array(z.string()).optional(),
  projects: z.array(z.string()).optional(),
  tasks: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  components: z.array(z.string()).optional(),
  external: z.array(z.string()).optional(),
});
export type MemoryEntities = z.infer<typeof MemoryEntitiesSchema>;

export const EvidenceRefSchema = z.object({
  kind: z.enum(["event", "artifact", "review", "metric", "statement"]),
  /** row id for event/artifact/review; free-form for metric/statement */
  ref: z.string().min(1).max(500),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const MemoryCandidateSchema = z.object({
  type: z.enum([
    "semantic",
    "episodic",
    "procedural",
    "decision",
    "failure",
    "experiment",
    "relationship",
    "artifact",
  ]),
  title: z.string().min(1).max(140),
  content: z.string().min(1).max(4000), // markdown, self-contained
  summary: z.string().min(1).max(320),
  entities: MemoryEntitiesSchema,
  suggested_scope: z.enum(["agent", "project"]), // company NEVER suggestible (12 §2.2 rule 3)
  scope_rationale: z.string().max(300),
  importance: z.number().min(0).max(1),
  importance_rationale: z.string().max(300),
  confidence: z.number().min(0).max(1),
  confidence_rationale: z.string().max(300),
  evidence_refs: z.array(EvidenceRefSchema).min(1), // must cite the window
  splits_from: z.string().optional(), // agent/project split pairs (12 §2.3)
});
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

/** 0–8 candidates per run (12 §5.1 WRITER-DECISION cap). */
export const MemoryCandidateListSchema = z.array(MemoryCandidateSchema).max(8);

/**
 * Parse an extraction response: accepts a bare JSON array or an object with a
 * `candidates` key (models drift between the two). Throws ZodError/SyntaxError
 * for the caller's single repair retry (12 §5.1).
 */
export function parseMemoryCandidates(text: string): MemoryCandidate[] {
  const trimmed = text.trim().replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  const parsed: unknown = JSON.parse(trimmed);
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { candidates?: unknown[] }).candidates ?? [];
  return MemoryCandidateListSchema.parse(list);
}
