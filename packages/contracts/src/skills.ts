// Skills API (T47; 13 §10): the agents × skills matrix for the Skills view.
import { z } from "zod";

export const SkillMatrixRowSchema = z.object({
  agentId: z.uuid(),
  agentName: z.string(),
  skillId: z.uuid(),
  skillName: z.string(),
  category: z.string(),
  level: z.number().int().min(1).max(5),
  confidence: z.number().min(0).max(1),
  evidenceCount: z.number().int().min(0),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type SkillMatrixRow = z.infer<typeof SkillMatrixRowSchema>;

export const SkillMatrixResponseSchema = z.object({ items: z.array(SkillMatrixRowSchema) });
export type SkillMatrixResponse = z.infer<typeof SkillMatrixResponseSchema>;

export const SkillEvidenceDtoSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  weight: z.number(),
  ref: z.string(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type SkillEvidenceDto = z.infer<typeof SkillEvidenceDtoSchema>;

export const SkillEvidenceResponseSchema = z.object({ items: z.array(SkillEvidenceDtoSchema) });
export type SkillEvidenceResponse = z.infer<typeof SkillEvidenceResponseSchema>;

// ---------- emergent skill discovery (36 §10 — U12) ----------

export const SkillCandidateSchema = z.object({
  agentId: z.uuid(),
  agentName: z.string(),
  skillName: z.string(),
  reason: z.string(),
  score: z.number().min(0).max(1),
  taskCount: z.number().int(),
  evidenceTaskIds: z.array(z.uuid()),
});
export type SkillCandidate = z.infer<typeof SkillCandidateSchema>;

export const SkillCandidatesResponseSchema = z.object({
  items: z.array(SkillCandidateSchema),
});
export type SkillCandidatesResponse = z.infer<typeof SkillCandidatesResponseSchema>;

export const PromoteSkillRequestSchema = z.object({
  agentId: z.uuid(),
  skillName: z.string().min(1).max(80),
  evidenceTaskIds: z.array(z.uuid()).min(1).max(20),
  category: z.string().min(1).max(40).optional(),
});
export type PromoteSkillRequest = z.infer<typeof PromoteSkillRequestSchema>;

export const PromoteSkillResponseSchema = z.object({
  skillId: z.uuid(),
  agentSkillId: z.uuid(),
  level: z.number().int(),
  confidence: z.number(),
  evidenceCount: z.number().int(),
});
export type PromoteSkillResponse = z.infer<typeof PromoteSkillResponseSchema>;
