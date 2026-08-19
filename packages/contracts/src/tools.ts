// Tool permission management schemas (Founder/admin UI)
import { z } from "zod";

export const ToolPermissionItemSchema = z.object({
  id: z.string().uuid(),
  toolName: z.string(),
  subjectKind: z.enum(["agent", "org_unit", "position"]),
  subjectId: z.string().uuid(),
  subjectLabel: z.string().optional(), // enriched by backend (agent name / unit slug)
  constraints: z.record(z.string(), z.unknown()).default({}),
  grantedByUserId: z.string().uuid().nullable(),
  grantedByAgentId: z.string().uuid().nullable(),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export type ToolPermissionItem = z.infer<typeof ToolPermissionItemSchema>;

export const GrantToolPermissionRequestSchema = z.object({
  toolName: z.string().min(1),
  subjectKind: z.enum(["agent", "org_unit", "position"]),
  subjectId: z.string().uuid(),
  constraints: z.record(z.string(), z.unknown()).optional(),
  expiresAt: z.string().datetime().optional(),
});

export type GrantToolPermissionRequest = z.infer<typeof GrantToolPermissionRequestSchema>;

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  risk: z.enum(["R0", "R1", "R2", "R3"]),
  scopes: z.array(z.string()),
  sideEffectFree: z.boolean(),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
