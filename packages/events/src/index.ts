export const packageName = "@acos/events" as const;

export {
  defineEvent,
  eventKey,
  getEventDefinition,
  knownEventTypes,
  knownDurableEventTypes,
  knownEphemeralEventTypes,
  isHandledVersion,
  parseEventPayload,
  EVENT_TYPE_PATTERN,
  type EventDefinition,
} from "./define.js";
export {
  EventEnvelopeSchema,
  EventActorSchema,
  type EventEnvelope,
  type EventActor,
} from "./envelope.js";
export {
  SUBJECT_PREFIX,
  subjectFor,
  companySubjectWildcard,
  parseSubject,
} from "./subjects.js";
export {
  MEMORY_SIGNIFICANT_PREFIXES,
  MEMORY_SIGNIFICANT_TYPES,
  MEMORY_SIGNIFICANT_SUBJECT_FILTERS,
  isMemorySignificant,
} from "./significance.js";

// Catalog registration (side-effectful imports) + canonical exports.
export { CompanyCreatedV1 } from "./catalog/org.js";
export { AgentHiredV1 } from "./catalog/agents.js";
export { TaskCreatedV1, TaskStatusChangedV1 } from "./catalog/tasks.js";
export { AgentMessageSentV1 } from "./catalog/communication.js";
export { MemoryCreatedV1 } from "./catalog/memory-skills.js";
export { WorkspaceTerminalOutputV1, WorkspaceEgressDeniedV1 } from "./catalog/projects.js";
export {
  ApprovalRequestedV1,
  BudgetExceededV1,
  PolicyInjectionFlaggedV1,
} from "./catalog/governance.js";
export { OfficeAvatarMovedV1 } from "./catalog/office.js";
import "./catalog/marketing.js";
export {
  ApprovalBriefSchema,
  ApprovalBriefOptionSchema,
  ApprovalBriefCostSchema,
  hasTranscriptMarkers,
  type ApprovalBrief,
} from "./briefs.js";
