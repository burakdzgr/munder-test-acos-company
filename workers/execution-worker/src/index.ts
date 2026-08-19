export const packageName = "@acos/execution-worker" as const;

export {
  createExecutionActivities,
  type ExecutionActivities,
  type ExecutionActivityDeps,
  type ExecutionContext,
  type CommandResult,
} from "./activities.js";
export {
  createGatewayClient,
  GatewayUnreachableError,
  type InvokeGateway,
} from "./gateway-client.js";
export {
  createIntakeExecutionActivities,
  createIntakeSandboxClient,
  intakeWorkspaceId,
  INTAKE_ANALYZERS,
  type IntakeSandboxClient,
  type IntakeExecutionActivities,
  type AnalyzerResult,
} from "./intake.js";
