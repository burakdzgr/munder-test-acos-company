export const packageName = "@acos/tools" as const;

export {
  DEFAULT_RATE_LIMITS,
  rateLimitFor,
  matchesToolPattern,
  elevateRisk,
  scrubSecretEnv,
  type ToolScope,
  type ToolSandboxLevel,
  type ToolDefinition,
  type ToolCostEstimate,
  type ToolRateLimit,
} from "./contract.js";
export {
  MVP_TOOLS,
  fsRead,
  fsWrite,
  fsSearch,
  gitCommit,
  gitBranch,
  gitDiff,
  gitMerge,
  terminalRun,
  dbInspect,
  webFetch,
  webSearch,
  taskQuery,
  memorySearch,
} from "./definitions.js";
export { toolRegistry, buildRegistry, getTool, listTools } from "./registry.js";
export {
  detectInjection,
  provenanceFence,
  derivesFromTainted,
  FENCE_PREAMBLE,
  TAINT_PATTERNS_VERSION,
  type InjectionScan,
  type FenceMeta,
} from "./taint.js";

export {
  ISOLATION_LEVELS,
  ISOLATION_LIMITS,
  WORKSPACE_NETWORK,
  EGRESS_PROXY_URL,
  isIsolationLevel,
  hardenedHostConfig,
  workspaceEnv,
  type IsolationLevel,
  type IsolationLimits,
  type WorkspaceMount,
  type HardenedHostConfig,
} from "./isolation.js";
