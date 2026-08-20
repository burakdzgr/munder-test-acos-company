export const packageName = "@acos/sandbox-manager" as const;

export {
  AGENT_SESSION_ENTRY,
  DockerSandbox,
  SandboxError,
  type AgentSessionOpen,
  type AgentSessionStatus,
  type DockerSandboxDeps,
} from "./docker.js";
export {
  TerminalSession,
  RING_BYTES,
  type TerminalTransport,
  type TerminalLogSink,
} from "./terminal.js";
export { buildApp, type AppDeps } from "./app.js";
export { parseSquidAccessLine, type EgressLogEntry } from "./egress.js";
