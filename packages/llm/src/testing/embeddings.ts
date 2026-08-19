// Fixed-seed pseudo-embeddings (32 §6): deterministic unit vectors derived
// from a content hash — the memory pipeline is fully testable without a
// model. Same text ⇒ same vector; similar-but-different texts diverge.
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(text: string, seed: number): number {
  let hash = (FNV_OFFSET ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
}

/** Deterministic pseudo-embedding, L2-normalized. Default dim 768 (ADR-020). */
export function pseudoEmbedding(text: string, dimension = 768): number[] {
  const vector = new Array<number>(dimension);
  let norm = 0;
  for (let i = 0; i < dimension; i++) {
    // hash per component: [-1, 1) uniform-ish, fully content-determined
    const h = fnv1a(text, i * 2654435761);
    const value = (h / 0xffffffff) * 2 - 1;
    vector[i] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dimension; i++) vector[i] = vector[i]! / norm;
  return vector;
}

/** Canned consolidation extractions (32 §6) — fixture-keyed, stable shapes
 *  for memory-pipeline tests (T44). */
export interface CannedConsolidation {
  memories: Array<{
    title: string;
    content: string;
    kind: "procedure" | "fact" | "decision" | "lesson";
    importance: number;
    confidence: number;
    /** entities.files — drives the deterministic scope rule 1 (12 §5.3) */
    files?: string[];
  }>;
}

const CANNED: Record<string, CannedConsolidation> = {
  "csv-implementation": {
    memories: [
      {
        title: "CSV export uses streaming writes",
        content: "Large exports must stream rows; buffering the whole file OOMs at ~100k rows.",
        kind: "lesson",
        importance: 0.7,
        confidence: 0.9,
        files: ["src/export/csv.ts"],
      },
      {
        title: "npm test is the gate before review",
        content: "Run the full test suite before requesting review; reviewers reject red builds.",
        kind: "procedure",
        importance: 0.6,
        confidence: 0.95,
      },
    ],
  },
  // T44 pipeline suite: single project-scoped lesson (merge/contradiction runs)
  "single-lesson": {
    memories: [
      {
        title: "Retry uploads with exponential backoff",
        content: "S3 uploads flake under load; retry 3x with exponential backoff starting at 500ms.",
        kind: "lesson",
        importance: 0.7,
        confidence: 0.8,
        files: ["src/upload/s3.ts"],
      },
    ],
  },
  // T44 pipeline suite / demo step 20: a FAILED task's lesson lands in the
  // 0.30–0.45 candidate band (0.3 + 0.1 costly trigger + 0.05 evidence)
  "flaky-test-failure": {
    memories: [
      {
        title: "Signup e2e test is order-dependent",
        content:
          "The signup spec fails when run after the profile spec; it assumes a clean users table.",
        kind: "lesson",
        importance: 0.3,
        confidence: 0.6,
        files: ["e2e/signup.spec.ts"],
      },
    ],
  },
  // T44 pipeline suite: below the 0.30 discard threshold after adjustments
  "low-importance": {
    memories: [
      {
        title: "CI was slow this morning",
        content: "The 09:00 CI run took 4 minutes longer than usual; no code cause found.",
        kind: "fact",
        importance: 0.1,
        confidence: 0.5,
      },
    ],
  },
};

/**
 * M3 (2026-08-15): an UNKNOWN fixture now yields NO memories.
 *
 * The old fallback invented `{title: "Consolidated: <key>", importance: 0.5}`.
 * Fixture keys only exist on demo tasks, so every real task in scripted mode
 * landed here and stored a junk row — above the 0.3 discard threshold, so it
 * survived, and indistinguishable in the panel from something the company had
 * actually learned. A memory system whose contents may be fabricated is worse
 * than an empty one: the Founder cannot tell which rows to trust.
 *
 * Scripted mode is for deterministic tests, not for learning. Meaningful
 * memory needs a live model; with no fixture the honest answer is "nothing was
 * extracted", which the consolidation run report shows as `candidates: 0`.
 */
export function cannedConsolidation(fixtureKey: string): CannedConsolidation {
  return CANNED[fixtureKey] ?? { memories: [] };
}
