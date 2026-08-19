// The event envelope (10 §4) — verbatim shape; payload is narrowed by the
// per-type catalog schema.
import { z } from "zod";
import { EVENT_TYPE_PATTERN } from "./define.js";

export const EventActorSchema = z.object({
  kind: z.enum(["agent", "founder", "system"]),
  id: z.uuid().nullable(),
});
export type EventActor = z.infer<typeof EventActorSchema>;

export const EventEnvelopeSchema = z.object({
  id: z.uuid(),
  companyId: z.uuid(),
  seq: z.number().int().positive(),
  type: z.string().regex(EVENT_TYPE_PATTERN), // domain.entity.action, past tense
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
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
