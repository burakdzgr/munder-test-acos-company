export const packageName = "@acos/domain" as const;

export * from "./state-machines/index.js";
export * from "./policies/index.js";

export { DomainError } from "./errors.js";
export { uuidv7, uuidv5, isUuid, isUuidv7, uuidv7Timestamp, type Uuidv7Options } from "./ids.js";

// Value objects
export {
  money,
  addMoney,
  subtractMoney,
  compareMoney,
  type Money,
} from "./value-objects/money.js";
export {
  RISK_CLASSES,
  isRiskClass,
  riskAtMost,
  TASK_RISKS,
  isTaskRisk,
  compareTaskRisk,
  RESOURCE_SCOPES,
  type RiskClass,
  type TaskRisk,
  type ResourceScope,
} from "./value-objects/risk.js";
export { AUTONOMY_LEVELS, isAutonomyLevel, type AutonomyLevel } from "./value-objects/autonomy.js";
export {
  SENIORITIES,
  isSeniority,
  compareSeniority,
  requiresPromotionReview,
  type Seniority,
} from "./value-objects/seniority.js";

// Entities + factories
export {
  createCompany,
  type Company,
  type CreateCompanyInput,
  type FactoryDeps,
} from "./entities/company.js";
export {
  UNIT_KINDS,
  createOrgUnit,
  type UnitKind,
  type OrgUnit,
  type CreateOrgUnitInput,
} from "./entities/org-unit.js";
export { createPosition, type Position, type CreatePositionInput } from "./entities/position.js";
export {
  EDGE_KINDS,
  UNIT_EDGE_KINDS,
  createOrgEdge,
  endOrgEdge,
  type EdgeKind,
  type OrgEdge,
  type CreateOrgEdgeInput,
} from "./entities/org-edge.js";
export {
  AGENT_STATUSES,
  RUNTIME_ACTIVITIES,
  createAgent,
  formatEmployeeNumber,
  type AgentStatus,
  type RuntimeActivity,
  type EmploymentInfo,
  type Agent,
  type CreateAgentInput,
} from "./entities/agent.js";
export {
  TASK_KINDS,
  PRIORITIES,
  TASK_STATUSES,
  createTask,
  formatTaskNumber,
  type TaskKind,
  type Priority,
  type TaskStatus,
  type TaskContext,
  type TaskResult,
  type Task,
  type CreateTaskInput,
} from "./entities/task.js";
export {
  PROJECT_STATUSES,
  WORKSPACE_STATUSES,
  ISOLATION_LEVELS,
  createProject,
  taskBranchName,
  type ProjectStatus,
  type WorkspaceStatus,
  type IsolationLevel,
  type Project,
  type CreateProjectInput,
} from "./entities/project.js";
export {
  MEMORY_SCOPES,
  MEMORY_TYPES,
  MEMORY_STATUSES,
  createMemory,
  type MemoryScope,
  type MemoryType,
  type MemoryStatus,
  type MemoryEntities,
  type Memory,
  type CreateMemoryInput,
} from "./entities/memory.js";
export {
  APPROVAL_STATUSES,
  URGENCIES,
  createApproval,
  type ApprovalStatus,
  type Urgency,
  type EndorsementChain,
  type Approval,
  type CreateApprovalInput,
} from "./entities/approval.js";
// D2/D3 (30 §, ADR-017): platform adapter'larının uyduğu saf port
export {
  SOCIAL_CAPABILITIES,
  capabilitiesOf,
  type SocialCapability,
  type SocialChannelPort,
  type SocialPublishInput,
  type SocialPublishResult,
  type SocialMetrics,
  type SocialComment,
} from "./ports/social-channel.js";
