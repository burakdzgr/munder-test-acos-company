// Terminals API (24 §6.9, T41): session list for the Terminals view + the
// scrollback download. Live frames ride the WS `terminal:<sessionId>` topic
// (22 §5.2); this REST surface is the founder/admin observability side.
import { z } from "zod";

export const TerminalSessionDtoSchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  agentId: z.uuid().nullable(),
  agentName: z.string().nullable(),
  title: z.string(),
  status: z.enum(["active", "closed"]),
  cols: z.number().int(),
  rows: z.number().int(),
  createdAt: z.iso.datetime(),
  closedAt: z.iso.datetime().nullable(),
  /** Joined workspace context (24 §6.9 list columns). */
  taskId: z.uuid().nullable(),
  taskNumber: z.number().int().nullable(),
  branch: z.string().nullable(),
  isolationLevel: z.string().nullable(),
  workspaceStatus: z.string().nullable(),
});
export type TerminalSessionDto = z.infer<typeof TerminalSessionDtoSchema>;

export const TerminalListQuerySchema = z.object({
  status: z.enum(["active", "closed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const TerminalListResponseSchema = z.object({
  items: z.array(TerminalSessionDtoSchema),
});
export type TerminalListResponse = z.infer<typeof TerminalListResponseSchema>;
