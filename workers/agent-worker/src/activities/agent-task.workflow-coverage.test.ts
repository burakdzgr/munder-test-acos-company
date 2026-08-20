// E4/T31 regression guard (2026-08-21): every activity the agent-task workflow
// proxies must be registered by the BASE activity set, createAgentTaskActivities.
// Integration suites (delegation-cascade, review-flow, cost-breaker, …) and any
// embedded worker build their Worker from that set alone; when T31 landed,
// `resolveAgentRuntimeActivity` existed only in main.ts's CLI-session set and
// every such Worker died with "Activity function resolveAgentRuntimeActivity is
// not registered on this Worker" → "Workflow execution failed". The one allowed
// exception is the CLI session activity itself: the workflow only reaches it
// after the resolver answered "cli", which the base set never does.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GuardedDb } from "@acos/db";
import type { ModelRouter } from "@acos/llm";
import { createAgentTaskActivities } from "./agent-task.js";

const CLI_ONLY = new Set(["runCliSessionActivity"]);

function baseActivities() {
  return createAgentTaskActivities({
    guardedDb: {} as unknown as GuardedDb, // constructors only capture the handle; nothing is queried here
    router: {} as unknown as ModelRouter,
    routingFor: async () => {
      throw new Error("not used");
    },
  });
}

describe("agent-task workflow ↔ base activity set", () => {
  it("every activity the workflow proxies is registered by createAgentTaskActivities (CLI session excepted)", () => {
    const src = readFileSync(fileURLToPath(new URL("../workflows/agent-task.workflow.ts", import.meta.url)), "utf8");
    const referenced = new Set<string>();
    for (const m of src.matchAll(/\b[A-Za-z_$][\w$]*\.([a-z][A-Za-z0-9]*Activity)\(/g)) referenced.add(m[1]!);
    expect(referenced.size).toBeGreaterThan(5);
    const registered = new Set(Object.keys(baseActivities()));
    const missing = [...referenced].filter((n) => !registered.has(n) && !CLI_ONLY.has(n));
    expect(missing, `workflow proxies activities the base Worker does not register: ${missing.join(", ")}`).toEqual([]);
  });

  it("the base resolver keeps every turn on the steps loop (the CLI-aware one overrides it in main.ts)", async () => {
    const r = await baseActivities().resolveAgentRuntimeActivity({ companyId: "c", agentId: "a", taskId: "t", sessionId: "s" });
    expect(r.kind).toBe("steps");
  });
});
