// Internal Tool Gateway wire contract (17 §1/§4, T39/T40): the ONE schema
// pair for POST /internal/v1/tools/invoke, shared by the server route and
// the worker-side clients (agent-worker use_tool, execution-worker
// activities). Transport auth is the INTERNAL_API_TOKEN bearer; the acting
// agent identity travels in the body and is re-verified by the gateway.
import { z } from "zod";

export const ToolInvokeWireRequestSchema = z.object({
  companyId: z.uuid(),
  agentId: z.uuid(),
  toolName: z.string().min(1).max(128),
  input: z.unknown(),
  taskId: z.uuid().optional(),
  agentSessionId: z.uuid().optional(),
  workspaceId: z.uuid().optional(),
  /** S5 taint bit: arguments derive from external content (17 §7.4). */
  tainted: z.boolean().optional(),
  scopeRelation: z.enum(["own_team", "own_department", "company", "external"]).optional(),
  /** Temporal attempt key — replays return the recorded result (17 §7.2). */
  idempotencyKey: z.string().min(8).max(200).optional(),
});
export type ToolInvokeWireRequest = z.infer<typeof ToolInvokeWireRequestSchema>;

export const ToolInvokeWireResponseSchema = z.object({
  invocationId: z.uuid().nullable(),
  decision: z.enum(["allow", "deny", "require_approval"]),
  status: z.enum(["denied", "awaiting_approval", "dispatched", "succeeded", "failed"]),
  reason: z.string().nullable(),
  approver: z.enum(["manager", "executive", "founder"]).optional(),
  riskClass: z.enum(["R0", "R1", "R2", "R3"]),
  elevatedFrom: z.enum(["R0", "R1", "R2", "R3"]).optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  costCents: z.number().int().optional(),
  retryAfterSec: z.number().int().optional(),
  replayed: z.boolean().optional(),
  /** S5: output tripped the injection heuristics — fence + taint required. */
  outputFlagged: z.boolean().optional(),
  flaggedPatterns: z.array(z.string()).optional(),
});
export type ToolInvokeWireResponse = z.infer<typeof ToolInvokeWireResponseSchema>;
