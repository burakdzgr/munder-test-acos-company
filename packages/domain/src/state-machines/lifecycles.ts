// The remaining canonical enumerations of _DECISIONS.md §19 as data.
// Non-literal additions (documented): agent sessions and workspaces may fail
// during startup/provisioning; projects may be cancelled before activation.
import type { AgentStatus } from "../entities/agent.js";
import type { ApprovalStatus } from "../entities/approval.js";
import type { MemoryStatus } from "../entities/memory.js";
import type { ProjectStatus, WorkspaceStatus } from "../entities/project.js";
import { defineStateMachine } from "./machine.js";

/** draft → active ⇄ paused → offboarded */
export const agentMachine = defineStateMachine<AgentStatus>("agent", {
  draft: ["active"],
  active: ["paused", "offboarded"],
  paused: ["active", "offboarded"],
  offboarded: [],
});

export const AGENT_SESSION_STATUSES = [
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AgentSessionStatus = (typeof AGENT_SESSION_STATUSES)[number];

/** starting → running ⇄ waiting → {completed, failed, cancelled} */
export const agentSessionMachine = defineStateMachine<AgentSessionStatus>("agent-session", {
  starting: ["running", "failed", "cancelled"],
  running: ["waiting", "completed", "failed", "cancelled"],
  waiting: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
});

/**
 * Proje yaşam döngüsü (PROJECT-LIFECYCLE TASK 2):
 * draft → repository_setup → indexing → ready → planning → staffing_review
 * → waiting_for_founder (gerekirse) → executing → {paused, completed,
 * failed, archived, cancelled}. Miras durumlar (proposed/intake/active)
 * eski kayıtlar için aynen korunur.
 */
export const projectMachine = defineStateMachine<ProjectStatus>("project", {
  draft: ["repository_setup", "cancelled"],
  repository_setup: ["indexing", "failed", "cancelled"],
  indexing: ["ready", "failed", "cancelled"],
  ready: ["planning", "archived", "cancelled"],
  planning: ["staffing_review", "waiting_for_founder", "executing", "failed", "cancelled"],
  staffing_review: ["waiting_for_founder", "executing", "planning", "cancelled"],
  waiting_for_founder: ["planning", "staffing_review", "executing", "failed", "cancelled"],
  executing: ["paused", "completed", "failed", "archived", "cancelled"],
  failed: ["repository_setup", "indexing", "planning", "cancelled"],
  proposed: ["intake", "cancelled"],
  intake: ["active", "cancelled"],
  active: ["paused", "completed", "archived", "cancelled"],
  paused: ["executing", "active", "completed", "archived", "cancelled"],
  completed: [],
  archived: [],
  cancelled: [],
});

/** pending → {approved, rejected, needs_review → pending, expired} */
export const approvalMachine = defineStateMachine<ApprovalStatus>("approval", {
  pending: ["approved", "rejected", "needs_review", "expired"],
  needs_review: ["pending"],
  approved: [],
  rejected: [],
  expired: [],
});

/** provisioning → ready → in_use ⇄ idle → {merged, discarded, failed} → destroyed */
export const workspaceMachine = defineStateMachine<WorkspaceStatus>("workspace", {
  provisioning: ["ready", "failed"],
  ready: ["in_use"],
  in_use: ["idle", "merged", "discarded", "failed"],
  idle: ["in_use", "merged", "discarded", "failed"],
  merged: ["destroyed"],
  discarded: ["destroyed"],
  failed: ["destroyed"],
  destroyed: [],
});

export const EXPERIMENT_STATUSES = [
  "designed",
  "baseline",
  "running",
  "analyzing",
  "adopted",
  "rejected",
  "inconclusive",
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/** designed → baseline → running → analyzing → {adopted, rejected, inconclusive} */
export const experimentMachine = defineStateMachine<ExperimentStatus>("experiment", {
  designed: ["baseline"],
  baseline: ["running"],
  running: ["analyzing"],
  analyzing: ["adopted", "rejected", "inconclusive"],
  adopted: [],
  rejected: [],
  inconclusive: [],
});

/** candidate → active → {superseded, archived, rejected}; below-threshold candidates are rejected (_DECISIONS §10). */
export const memoryMachine = defineStateMachine<MemoryStatus>("memory", {
  candidate: ["active", "rejected"],
  active: ["superseded", "archived", "rejected"],
  superseded: [],
  archived: [],
  rejected: [],
});
