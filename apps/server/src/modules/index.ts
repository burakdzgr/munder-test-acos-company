// One Fastify plugin per domain module (28 §2). All stubs until their tasks
// land: auth T16, companies T17, org T18, agents T19, events/realtime T21–23,
// office-projector T25, tasks T27, comms T33, approvals T35, tool-gateway T39,
// projects T42, memory T44+, skills T47, policies/costs alongside.
import type { FastifyPluginAsync } from "fastify";

const stub: FastifyPluginAsync<{ name?: string }> = async () => {
  // routes land with the module's task
};

export const MODULE_NAMES = [
  "companies",
  "org",
  "agents",
  "tasks",
  "projects",
  "memory",
  "skills",
  "comms",
  "approvals",
  "policies",
  "costs",
  "events",
  "tool-gateway",
  "realtime",
  "office-projector",
  "auth",
] as const;

export const moduleStubs: Record<string, FastifyPluginAsync<{ name?: string }>> =
  Object.fromEntries(MODULE_NAMES.map((name) => [name, stub]));
