export const packageName = "@acos/sandbox-manager" as const;

export { DockerSandbox, SandboxError, type DockerSandboxDeps } from "./docker.js";
export {
  TerminalSession,
  RING_BYTES,
  type TerminalTransport,
  type TerminalLogSink,
} from "./terminal.js";
export { buildApp, type AppDeps } from "./app.js";
export { parseSquidAccessLine, type EgressLogEntry } from "./egress.js";
