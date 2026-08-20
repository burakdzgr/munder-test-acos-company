// T41 regression guard (2026-08-21): every activity the agent-task workflow
// proxies must be registered by BOTH activity sets a Worker can be built from:
//   • the production set, createAgentTaskActivities (integration suites with a
//     real DB, any embedded worker) — the CLI session activity excepted, since
//     it is reachable only after resolveAgentRuntimeActivity answered "cli",
//     which the base set never does;
//   • the canned stub base, buildStubActivities (TestWorkflowEnvironment suites,
//     the golden-history generator) — NO exceptions: a stub Worker must never
//     die with "Activity function X is not registered" and swallow the failure
//     under test.
// History: when T31 landed, resolveAgentRuntimeActivity lived only in main.ts's
// CLI-session set and 12 integration tests died that way; the first fix covered
// the production set only, and hand-rolled stub suites (guards, workflow-crash,
// gen-histories) stayed red — hence the second half of this guard.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { GuardedDb } from "@acos/db";
import type { ModelRouter } from "@acos/llm";
import { createAgentTaskActivities } from "./agent-task.js";
import * as trivialActivities from "./index.js";
import { STUB_ACTIVITY_NAMES, buildStubActivities } from "../../test/support/stub-activities.js";

/** Reachable only behind the resolver's "cli" answer — never on a base Worker. */
const CLI_ONLY = new Set(["runCliSessionActivity"]);

function productionActivities() {
  return createAgentTaskActivities({
    guardedDb: {} as unknown as GuardedDb, // constructors only capture the handle; nothing is queried here
    router: {} as unknown as ModelRouter,
    routingFor: async () => {
      throw new Error("not used");
    },
  });
}

/** Every `<proxy>.<name>Activity(` the workflow source calls (dot may sit on its own line). */
function proxiedActivityNames(): Set<string> {
  const src = readFileSync(fileURLToPath(new URL("../workflows/agent-task.workflow.ts", import.meta.url)), "utf8");
  const names = new Set<string>();
  for (const m of src.matchAll(/\.\s*([a-z][A-Za-z0-9]*Activity)\s*\(/g)) names.add(m[1]!);
  return names;
}

describe("agent-task workflow ↔ activity sets (T41 guard)", () => {
  const referenced = proxiedActivityNames();

  it("sees the workflow's activity surface", () => {
    expect(referenced.size).toBeGreaterThan(10);
    expect(referenced.has("resolveAgentRuntimeActivity")).toBe(true);
    expect(referenced.has("reportWorkflowCrashActivity")).toBe(true);
  });

  it("PRODUCTION: every proxied activity is registered by createAgentTaskActivities (CLI session excepted)", () => {
    const registered = new Set(Object.keys(productionActivities()));
    const missing = [...referenced].filter((n) => !registered.has(n) && !CLI_ONLY.has(n));
    expect(missing, `workflow proxies activities the production Worker does not register: ${missing.join(", ")}`).toEqual([]);
  });

  it("STUB: every proxied activity is registered by buildStubActivities — no exceptions", () => {
    const registered = new Set(Object.keys(buildStubActivities()));
    const missing = [...referenced].filter((n) => !registered.has(n));
    expect(missing, `workflow proxies activities the canned stub base does not register: ${missing.join(", ")}`).toEqual([]);
  });

  it("STUB names are real: each one exists in the production set or the trivial control-plane set (no typos, no inventions)", () => {
    const real = new Set([...Object.keys(productionActivities()), ...Object.keys(trivialActivities)]);
    // the production set does not carry the CLI session activity; main.ts adds it — known, allowed
    const invented = STUB_ACTIVITY_NAMES.filter((n) => !real.has(n) && !CLI_ONLY.has(n));
    expect(invented, `stub base registers names no Worker really has: ${invented.join(", ")}`).toEqual([]);
  });

  it("overrides layer on top of the full base (a suite gets 'all registrations + mine')", async () => {
    const stub = buildStubActivities({
      async callModelActivity() {
        return { text: "{}", usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }, model: "x", costCents: 0, latencyMs: 1 };
      },
    });
    expect(Object.keys(stub).sort()).toEqual([...STUB_ACTIVITY_NAMES].sort());
    expect((await stub.callModelActivity()).model).toBe("x");
    expect((await stub.resolveAgentRuntimeActivity()).kind).toBe("steps");
    // the base resolver keeps every turn on the steps loop (production's config-aware one overrides it in main.ts)
    expect((await productionActivities().resolveAgentRuntimeActivity()).kind).toBe("steps");
  });

  it("a forgotten callModelActivity fails loudly, not as 'not registered'", async () => {
    await expect(buildStubActivities().callModelActivity()).rejects.toThrow(/callModelActivity is not stubbed/);
  });
});
