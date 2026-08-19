// Communication API contracts (11 §4.1–4.2, T33).
import { z } from "zod";

export const ChannelKindSchema = z.enum([
  "dm",
  "team",
  "department",
  "project",
  "task_thread",
  "review",
  "escalation",
]);

export const ChannelSchema = z.object({
  id: z.uuid(),
  kind: ChannelKindSchema,
  name: z.string().nullable(),
  orgUnitId: z.uuid().nullable(),
  projectId: z.uuid().nullable(),
  taskId: z.uuid().nullable(),
  reviewId: z.uuid().nullable(),
  dmKey: z.string().nullable(),
  archivedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Channel = z.infer<typeof ChannelSchema>;

export const MessageKindSchema = z.enum([
  "text",
  "help_request",
  "review_request",
  "escalation",
  "status",
  "system",
]);

export const MessageSchema = z.object({
  id: z.uuid(),
  channelId: z.uuid(),
  senderAgentId: z.uuid().nullable(), // null = the Founder
  kind: MessageKindSchema,
  body: z.string(),
  refs: z.array(z.object({ kind: z.string(), id: z.uuid() })),
  replyToMessageId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
});
export type Message = z.infer<typeof MessageSchema>;

export const SendMessageRequestSchema = z.object({
  kind: MessageKindSchema.exclude(["system"]).default("text"), // system is server-internal (11 §3)
  body: z.string().min(1).max(8000),
  refs: z
    .array(z.object({ kind: z.enum(["task", "artifact", "review", "approval", "message"]), id: z.uuid() }))
    .default([]),
  mentions: z.array(z.uuid()).default([]),
  replyToMessageId: z.uuid().optional(),
});

export const CreateDmRequestSchema = z.object({
  kind: z.literal("dm"),
  agentId: z.uuid(), // Founder ↔ agent DM (agent–agent DMs open via activities)
});

export const ChannelMemberSchema = z.object({
  agentId: z.uuid().nullable(), // null = the Founder
  joinedAt: z.iso.datetime(),
  lastReadAt: z.iso.datetime().nullable(),
});
