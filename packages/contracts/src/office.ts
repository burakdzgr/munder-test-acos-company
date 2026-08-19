// Office instruction + layout schemas (23 §2, §12 — verbatim shapes). Shared
// by the projector (server), the WS gateway's presence topic, and the Pixi
// client (T26). HARD invariant: causeEventId is required — no optional, no
// null (INV-12: no instruction without a causing domain event).
import { z } from "zod";

export const CellSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
});
export type Cell = z.infer<typeof CellSchema>;

// ---------- floor plan (company_settings.office_layout) ----------

export const OfficeDeskSchema = z.object({
  id: z.string(),
  cell: CellSchema,
  agentId: z.uuid().nullish(), // home-desk assignment persists here
});

export const OfficeZoneSchema = z.object({
  id: z.string(),
  kind: z.enum(["department", "team", "executive", "meeting"]),
  orgUnitId: z.uuid().optional(),
  parentZoneId: z.string().optional(),
  rect: z.object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    w: z.number().int().min(1),
    h: z.number().int().min(1),
  }),
  label: z.string().optional(),
  color: z.string().optional(),
  desks: z.array(OfficeDeskSchema).optional(),
  spots: z.number().int().min(1).optional(),
});

export const OfficeLayoutSchema = z.object({
  version: z.number().int().min(1),
  grid: z.object({
    cellSize: z.number().int().positive(),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  zones: z.array(OfficeZoneSchema),
  walls: z
    .array(
      z.object({
        x: z.number().int(),
        y: z.number().int(),
        w: z.number().int().min(1),
        h: z.number().int().min(1),
      }),
    )
    .default([]),
});
export type OfficeLayout = z.infer<typeof OfficeLayoutSchema>;
export type OfficeZone = z.infer<typeof OfficeZoneSchema>;
export type OfficeDesk = z.infer<typeof OfficeDeskSchema>;

// ---------- presence badges (_DECISIONS §6 — the 11 statuses) ----------

export const PRESENCE_BADGES = [
  "IDLE",
  "THINKING",
  "WORKING",
  "WAITING",
  "COMMUNICATING",
  "REVIEWING",
  "TESTING",
  "LEARNING",
  "BLOCKED",
  "ESCALATING",
  "OFFLINE",
] as const;
export const PresenceBadgeSchema = z.enum(PRESENCE_BADGES);
export type PresenceBadge = z.infer<typeof PresenceBadgeSchema>;

// ---------- instructions (23 §12 — verbatim) ----------

const OfficeInstructionBase = z.object({
  choreoSeq: z.number().int().positive(), // per-company monotonic (projector-assigned)
  causeEventId: z.uuid(), // HARD invariant — no optional, no null
  causeSeq: z.number().int().positive(),
  emittedAt: z.iso.datetime(),
});

export const AvatarMovedSchema = OfficeInstructionBase.extend({
  type: z.literal("office.avatar.moved"),
  agentId: z.uuid(),
  fromCell: CellSchema,
  toCell: CellSchema,
  path: z.array(CellSchema).min(1).max(200),
  reason: z.enum(["dm", "review", "escalation", "return_home", "desk_assign"]),
});

export const InteractionStartedSchema = OfficeInstructionBase.extend({
  type: z.literal("office.interaction.started"),
  interactionId: z.string(),
  kind: z.enum(["dm", "review", "escalation", "meeting", "speech"]),
  agentIds: z.array(z.uuid()).min(1).max(8),
  atCell: CellSchema,
});

export const InteractionEndedSchema = OfficeInstructionBase.extend({
  type: z.literal("office.interaction.ended"),
  interactionId: z.string(),
  endedBy: z.enum(["event", "dwell_timeout", "speech_timeout", "snapshot_reset"]),
});

export const StatusChangedSchema = OfficeInstructionBase.extend({
  type: z.literal("office.status.changed"),
  agentId: z.uuid(),
  badge: PresenceBadgeSchema,
});

export const OfficeInstructionSchema = z.discriminatedUnion("type", [
  AvatarMovedSchema,
  InteractionStartedSchema,
  InteractionEndedSchema,
  StatusChangedSchema,
]);
export type OfficeInstruction = z.infer<typeof OfficeInstructionSchema>;

// ---------- presence snapshot state (22 §12) ----------

export const PresenceAgentSchema = z.object({
  agentId: z.uuid(),
  name: z.string(),
  cell: CellSchema,
  badge: PresenceBadgeSchema,
  deskId: z.string().nullable(),
  sessionId: z.uuid().nullable(),
});

export const PresenceStateSchema = z.object({
  layoutVersion: z.number().int().min(0),
  snapshotEpoch: z.number().int().min(0),
  agents: z.array(PresenceAgentSchema),
  interactions: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["dm", "review", "escalation", "meeting", "speech"]),
      agentIds: z.array(z.uuid()),
      atCell: CellSchema,
      causeEventId: z.uuid(),
    }),
  ),
});
export type PresenceState = z.infer<typeof PresenceStateSchema>;
export type PresenceAgent = z.infer<typeof PresenceAgentSchema>;
