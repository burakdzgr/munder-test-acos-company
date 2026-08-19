// Memory Observatory API (T48; 12 §8): list/search, graph, provenance
// inspection, contradiction queue and the Founder edit path — always real
// rows, never simulated data.
import { z } from "zod";

export const MemoryDtoSchema = z.object({
  id: z.uuid(),
  scope: z.enum(["company", "project", "agent"]),
  scopeRef: z.uuid().nullable(),
  type: z.string(),
  title: z.string(),
  summary: z.string(),
  importance: z.number(),
  confidence: z.number(),
  status: z.string(),
  retrievalCount: z.number().int(),
  createdByAgentId: z.uuid().nullable(),
  lastVerifiedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type MemoryDto = z.infer<typeof MemoryDtoSchema>;

export const MemoryListResponseSchema = z.object({
  items: z.array(MemoryDtoSchema),
  /** review-queue badges (12 §8.7) */
  contradictions: z.number().int(),
  lowConfidence: z.number().int(),
});
export type MemoryListResponse = z.infer<typeof MemoryListResponseSchema>;

export const MemoryEvidenceItemSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  ref: z.string(),
  weight: z.number(),
  createdAt: z.iso.datetime(),
});

export const MemoryRelationItemSchema = z.object({
  relationId: z.uuid(),
  kind: z.string(),
  direction: z.enum(["out", "in"]),
  otherId: z.uuid(),
  otherTitle: z.string(),
});

export const MemoryVersionItemSchema = z.object({
  version: z.number().int(),
  title: z.string(),
  status: z.string(),
  importance: z.number(),
  confidence: z.number(),
  changedBy: z.string(),
  changeReason: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export const MemoryDetailResponseSchema = z.object({
  memory: MemoryDtoSchema.extend({
    content: z.string(),
    sourceEventId: z.uuid().nullable(),
    entities: z.record(z.string(), z.unknown()),
    createdByAgentName: z.string().nullable(),
  }),
  evidence: z.array(MemoryEvidenceItemSchema),
  relations: z.array(MemoryRelationItemSchema),
  versions: z.array(MemoryVersionItemSchema),
});
export type MemoryDetailResponse = z.infer<typeof MemoryDetailResponseSchema>;

export const MemoryGraphResponseSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      type: z.string(),
      scope: z.string(),
      /**
       * Kapsamın sahibi: `project` için proje id'si, `agent` için ajan id'si,
       * `company` için null. Galaksi görünümü (ADR-021) kolları buna göre
       * ayırır — yoksa iki farklı projenin anıları aynı kolda karışırdı.
       */
      scopeRef: z.uuid().nullable(),
      /** Aynı şeyin insan okur hâli (proje/ajan adı); bilinmiyorsa null. */
      scopeLabel: z.string().nullable(),
      importance: z.number(),
      confidence: z.number(),
      status: z.string(),
    }),
  ),
  edges: z.array(z.object({ from: z.uuid(), to: z.uuid(), kind: z.string() })),
  capped: z.boolean(),
});
export type MemoryGraphResponse = z.infer<typeof MemoryGraphResponseSchema>;

export const ContradictionPairSchema = z.object({
  relationId: z.uuid(),
  a: MemoryDtoSchema.extend({ content: z.string() }),
  b: MemoryDtoSchema.extend({ content: z.string() }),
});
export const ContradictionQueueResponseSchema = z.object({
  items: z.array(ContradictionPairSchema),
});
export type ContradictionQueueResponse = z.infer<typeof ContradictionQueueResponseSchema>;

export const ResolveContradictionRequestSchema = z.object({
  winnerMemoryId: z.uuid(),
  note: z.string().max(500).optional(),
});
export type ResolveContradictionRequest = z.infer<typeof ResolveContradictionRequestSchema>;

export const FounderMemoryPatchSchema = z
  .object({
    title: z.string().min(1).max(140).optional(),
    content: z.string().min(1).max(4000).optional(),
    importance: z.number().min(0).max(1).optional(),
    archive: z.boolean().optional(),
    note: z.string().max(300).optional(),
  })
  .refine(
    (patch) =>
      patch.title !== undefined ||
      patch.content !== undefined ||
      patch.importance !== undefined ||
      patch.archive === true,
    { message: "empty patch" },
  );
export type FounderMemoryPatch = z.infer<typeof FounderMemoryPatchSchema>;

export const FounderMemoryPatchResponseSchema = z.object({
  versionNo: z.number().int(),
  status: z.string(),
});
export type FounderMemoryPatchResponse = z.infer<typeof FounderMemoryPatchResponseSchema>;
