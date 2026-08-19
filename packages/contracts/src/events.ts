// Events timeline API (21 §3.11, T22): the full event envelope (10 §4 shape,
// camelCase, subject refs grouped) + cursor/replay response envelopes.
import { z } from "zod";

export const EventActorSchema = z.object({
  kind: z.enum(["agent", "founder", "system"]),
  id: z.uuid().nullable(),
});

export const EventSchema = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  seq: z.number().int().positive(),
  type: z.string(),
  version: z.number().int().min(1),
  occurredAt: z.iso.datetime(),
  actor: EventActorSchema,
  subject: z.object({
    taskId: z.uuid().nullable(),
    projectId: z.uuid().nullable(),
    agentId: z.uuid().nullable(),
  }),
  correlationId: z.uuid(),
  causationId: z.uuid().nullable(),
  payload: z.unknown(),
});
export type Event = z.infer<typeof EventSchema>;

/** GET /events — filters per 21 §3.11; repeated `types` = OR, `task.*` prefix ok. */
export const EventListQuerySchema = z.object({
  types: z.union([z.string(), z.array(z.string())]).optional(),
  actorKind: z.enum(["agent", "founder", "system"]).optional(),
  actorId: z.uuid().optional(),
  taskId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  agentId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export const EventListResponseSchema = z.object({
  items: z.array(EventSchema),
  nextCursor: z.string().nullable(),
});
export type EventListResponse = z.infer<typeof EventListResponseSchema>;

/** GET /events/replay — deterministic per-company seq replay (WS resume fallback). */
export const EventReplayQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

export const EventReplayResponseSchema = z.object({
  items: z.array(EventSchema),
  nextSeq: z.number().int().min(0),
});
export type EventReplayResponse = z.infer<typeof EventReplayResponseSchema>;
