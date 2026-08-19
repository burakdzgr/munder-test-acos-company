// Org module schemas (04 §1–4).
import { z } from "zod";

export const UnitKindSchema = z.enum(["department", "team", "office", "division"]);
export const EdgeKindSchema = z.enum([
  "reports_to",
  "manages",
  "member_of",
  "leads",
  "mentors",
  "collaborates_with",
]);

export const OrgUnitSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  kind: UnitKindSchema,
  parentId: z.uuid().nullable(),
});
export type OrgUnit = z.infer<typeof OrgUnitSchema>;

export const CreateOrgUnitRequestSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  kind: UnitKindSchema,
  parentId: z.uuid().nullable().optional(),
});

export const MoveOrgUnitRequestSchema = z.object({ parentId: z.uuid().nullable() });

export const ArchiveOrgUnitResponseSchema = z.object({
  id: z.uuid(),
  archivedAt: z.iso.datetime(),
});

export const PositionSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  seniorityTrack: z.array(z.string()),
  defaultRole: z.string(),
  description: z.string().nullable(),
});
export type Position = z.infer<typeof PositionSchema>;

export const CreatePositionRequestSchema = z.object({
  title: z.string().min(1),
  seniorityTrack: z.array(z.string()).min(1),
  defaultRole: z.string().min(1),
  description: z.string().optional(),
});

export const OrgEdgeSchema = z.object({
  id: z.uuid(),
  fromAgentId: z.uuid(),
  toAgentId: z.uuid().nullable(),
  toUnitId: z.uuid().nullable(),
  kind: EdgeKindSchema,
  endedAt: z.iso.datetime().nullable(),
});
export type OrgEdge = z.infer<typeof OrgEdgeSchema>;

export const CreateOrgEdgeRequestSchema = z
  .object({
    fromAgentId: z.uuid(),
    kind: EdgeKindSchema,
    toAgentId: z.uuid().optional(),
    toUnitId: z.uuid().optional(),
  })
  .refine((v) => (v.toAgentId === undefined) !== (v.toUnitId === undefined), {
    message: "exactly one of toAgentId/toUnitId is required",
  });

export const EscalationChainSchema = z.array(
  z.union([
    z.object({ kind: z.literal("agent"), agentId: z.uuid(), name: z.string() }),
    z.object({ kind: z.literal("founder") }),
  ]),
);
export type EscalationChain = z.infer<typeof EscalationChainSchema>;

export const TeamRosterEntrySchema = z.object({
  agentId: z.uuid(),
  name: z.string(),
  employeeNumber: z.number().int(),
  seniority: z.string(),
  title: z.string(),
  isLead: z.boolean(),
});
