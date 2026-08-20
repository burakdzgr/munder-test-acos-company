// AgentAction — the strict Zod union (08 §4 verbatim: the canonical 12
// actions of _DECISIONS §8 plus `think`). Doc 08 places this file in
// packages/domain; domain deliberately carries ZERO runtime dependencies
// (T09), so the zod schema lives here in @acos/llm (pure schema, no IO) —
// workers import it from the same package that parses model output.
// TaskResult (07 §10) is embedded for the same reason.
import { z } from "zod";

const Ref = z.object({
  kind: z.enum(["task", "message", "approval", "artifact", "review"]),
  id: z.uuid(),
});

/** 07 §10 result contract — stored in tasks.result on complete_task. */
export const TaskResultSchema = z.object({
  summary: z.string().min(1).max(4000),
  criteria: z.array(
    z.object({
      criterion: z.string(),
      met: z.boolean(),
      evidence: z.string(),
    }),
  ),
  artifactIds: z.array(z.uuid()),
  metrics: z.record(z.string(), z.number()).optional(),
  followUps: z.array(z.string()).optional(),
  cost: z.object({ tokensIn: z.number(), tokensOut: z.number(), cents: z.number() }),
});
export type TaskResult = z.infer<typeof TaskResultSchema>;

export const AgentActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("use_tool"),
    tool: z.string(), // must exist in the packages/tools registry
    input: z.unknown(), // validated against the tool's own Zod input schema
    reason: z.string().max(500),
  }),
  z.object({
    type: z.literal("send_message"),
    channelId: z.uuid(),
    kind: z.enum(["text", "help_request", "review_request", "escalation", "status"]),
    body: z.string().min(1).max(8000),
    mentions: z.array(z.uuid()).default([]),
    refs: z.array(Ref).default([]),
  }),
  z.object({
    type: z.literal("create_task"),
    kind: z.enum(["initiative", "epic", "task", "subtask"]),
    parentTaskId: z.uuid(),
    title: z.string().max(200),
    objective: z.string(),
    successCriteria: z.array(z.string()).min(1),
    priority: z.enum(["P0", "P1", "P2", "P3"]),
    estimatedEffort: z.number().int().min(1).max(13),
    risk: z.enum(["low", "medium", "high", "critical"]).default("low"),
    /** TASK 12: Scheduler seçimi bunlarla yapar — CEO ajan SEÇMEZ. */
    requiredCapabilities: z.array(z.string().max(60)).max(8).default([]),
    orgUnitId: z.uuid().optional(),
    deadline: z.iso.datetime().optional(),
  }),
  z.object({
    type: z.literal("delegate_task"),
    taskId: z.uuid(),
    toAgentId: z.uuid(),
    note: z.string().max(1000),
  }),
  z.object({
    type: z.literal("request_review"),
    taskId: z.uuid(),
    artifactId: z.uuid(),
    reviewerHint: z.uuid().optional(), // lead may override
    summary: z.string().max(2000),
  }),
  z.object({
    type: z.literal("request_help"),
    topic: z.string().max(200),
    body: z.string().max(4000),
    audience: z.enum(["peer", "team", "lead", "manager", "specialist"]),
    targetAgentId: z.uuid().optional(),
  }),
  z.object({
    type: z.literal("escalate"),
    reason: z.string().max(2000),
    attempted: z.array(z.string()), // resolution ladder evidence
    options: z.array(z.object({ option: z.string(), risk: z.string(), cost: z.string() })),
    recommendation: z.string(),
  }),
  z.object({
    type: z.literal("update_task_status"),
    taskId: z.uuid(),
    to: z.enum(["IN_PROGRESS", "WAITING", "BLOCKED", "REVIEW"]),
    note: z.string().max(1000),
  }),
  z.object({
    type: z.literal("record_decision"),
    title: z.string().max(200),
    decision: z.string(),
    alternatives: z.array(z.string()),
    consequences: z.string(),
  }),
  z.object({ type: z.literal("complete_task"), result: TaskResultSchema }),
  z.object({
    type: z.literal("wait_for"),
    what: z.enum(["dependency", "reply", "review", "approval", "timer"]),
    refId: z.uuid().optional(),
    timeoutMinutes: z.number().int().min(1).max(1440).default(120),
  }),
  z.object({
    type: z.literal("abandon"),
    reason: z.string().max(2000), // → manager review, never silent FAILED
  }),
  z.object({
    type: z.literal("think"), // [WRITER-DECISION] 13th action
    thought: z.string().max(4000),
    plan: z.array(z.string()).optional(),
  }),
]);
export type AgentAction = z.infer<typeof AgentActionSchema>;

/**
 * Context-reference sentinel (T36): an action may reference "the current
 * context" — own task (create_task.parentTaskId), the next unassigned child
 * (delegate_task.taskId), an eligible report (delegate_task.toAgentId), the
 * own task thread (send_message.channelId) — with this uuid instead of a
 * concrete id. The worker's action dispatch resolves it deterministically;
 * scripted fixtures rely on it, live models may use it the same way.
 */
export const CONTEXT_SENTINEL_UUID = "00000000-0000-4000-8000-000000000000";

/**
 * Self-assignment sentinel (T29, Founder decision 2026-08-20): a manager may
 * keep a slice of the work it just decomposed instead of delegating every
 * child ("sana gorev verdim, sen boldun ama burayi ben halledecegim dedin").
 * `delegate_task.toAgentId = SELF_SENTINEL_UUID` means "I take this subtask
 * myself" — an explicit, auditable intent that stays inside the delegation
 * engine: the reporting-line rule already blesses it (07 §6, self-assignment
 * of one's own subtask) and the capacity model still applies, so the work
 * counts against the manager's OWN WIP cap. INV-10 holds: the Scheduler is
 * still the deterministic owner of every assignment it is asked to make.
 */
export const SELF_SENTINEL_UUID = "00000000-0000-4000-8000-00000000005e";

export const AGENT_ACTION_TYPES = [
  "use_tool",
  "send_message",
  "create_task",
  "delegate_task",
  "request_review",
  "request_help",
  "escalate",
  "update_task_status",
  "record_decision",
  "complete_task",
  "wait_for",
  "abandon",
  "think",
] as const;
export type AgentActionType = (typeof AGENT_ACTION_TYPES)[number];
