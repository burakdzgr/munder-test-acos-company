// /ws wire protocol (21 §4 — the normative wire contract; 22 §4 server
// internals). Shared by the server gateway (T23) and the RealtimeClient (T24).
import { z } from "zod";

// ---------- topics ----------

export type TopicKind = "events" | "terminal" | "presence" | "runtime";

export interface ParsedTopic {
  kind: TopicKind;
  /** companyId for events/presence/runtime, terminal sessionId for terminal. */
  id: string;
}

const TOPIC_PATTERN = /^(events|terminal|presence|runtime):([0-9a-f-]{36})$/;

export function parseTopic(topic: string): ParsedTopic | null {
  const match = TOPIC_PATTERN.exec(topic);
  if (!match) return null;
  return { kind: match[1] as TopicKind, id: match[2]! };
}

// ---------- client → server ops (21 §4.2) ----------

export const SubscribeOpSchema = z.object({
  op: z.literal("subscribe"),
  topics: z.array(z.string()).min(1).max(32),
});
export const ResumeOpSchema = z.object({
  op: z.literal("resume"),
  topic: z.string(),
  after_seq: z.number().int().min(0),
});
export const UnsubscribeOpSchema = z.object({
  op: z.literal("unsubscribe"),
  topics: z.array(z.string()).min(1).max(32),
});
export const PingOpSchema = z.object({ op: z.literal("ping"), t: z.number().optional() });

export const ClientOpSchema = z.discriminatedUnion("op", [
  SubscribeOpSchema,
  ResumeOpSchema,
  UnsubscribeOpSchema,
  PingOpSchema,
]);
export type ClientOp = z.infer<typeof ClientOpSchema>;

// ---------- server → client frames (21 §4.3, 22 §4.2) ----------

export const HelloFrameSchema = z.object({
  op: z.literal("hello"),
  connectionId: z.string(),
  heartbeatSec: z.number().int().positive(),
  maxTopics: z.number().int().positive(),
  version: z.literal(1),
});

export const SubOkFrameSchema = z.object({
  op: z.literal("sub_ok"),
  topic: z.string(),
  current_seq: z.number().int().min(0),
  mode: z.enum(["live", "replay"]),
});

export const ReplayDoneFrameSchema = z.object({
  op: z.literal("replay_done"),
  topic: z.string(),
  up_to_seq: z.number().int().min(0),
});

/** Canonical data frame — `seq` = seq of the LAST event in the batch. */
export const EventsDataFrameSchema = z.object({
  topic: z.string(),
  seq: z.number().int().min(0),
  events: z.array(z.unknown()),
});

/** Terminal data frame (source lands with T41). */
export const TerminalFrameSchema = z.object({
  seq: z.number().int().min(0),
  ts: z.number(),
  stream: z.enum(["stdout", "stderr"]),
  data: z.string(), // base64
});
export const TerminalDataFrameSchema = z.object({
  topic: z.string(),
  seq: z.number().int().min(0),
  frames: z.array(TerminalFrameSchema),
});

/** Presence snapshot-then-delta (23 §4 feeds real state with T25). */
export const PresenceSnapshotFrameSchema = z.object({
  op: z.literal("snapshot"),
  topic: z.string(),
  seq: z.number().int().min(0),
  state: z.object({
    layoutVersion: z.number().int().min(0),
    agents: z.array(z.unknown()),
    interactions: z.array(z.unknown()),
  }),
});

export const GapFrameSchema = z.object({
  op: z.literal("gap"),
  topic: z.string(),
  from_seq: z.number().int().min(0),
  to_seq: z.number().int().min(0),
});

export const PongFrameSchema = z.object({ op: z.literal("pong"), t: z.number().optional() });

export const WS_ERROR_CODES = [
  "forbidden_topic",
  "limit_exceeded",
  "replay_too_large",
  "bad_op",
] as const;
export const ErrorFrameSchema = z.object({
  op: z.literal("error"),
  code: z.enum(WS_ERROR_CODES),
  topic: z.string().optional(),
  message: z.string().optional(),
});

export const ServerControlFrameSchema = z.discriminatedUnion("op", [
  HelloFrameSchema,
  SubOkFrameSchema,
  ReplayDoneFrameSchema,
  PresenceSnapshotFrameSchema,
  GapFrameSchema,
  PongFrameSchema,
  ErrorFrameSchema,
]);
export type ServerControlFrame = z.infer<typeof ServerControlFrameSchema>;
export type EventsDataFrame = z.infer<typeof EventsDataFrameSchema>;

/** Close-code registry (22 §13). */
export const WS_CLOSE_CODES = {
  normal: 1000,
  unauthenticated: 4401,
  heartbeatTimeout: 4408,
  slowConsumer: 4409,
  messageTooLarge: 4413,
  connectionLimit: 4429,
} as const;
