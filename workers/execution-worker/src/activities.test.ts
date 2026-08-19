// T40 unit surface: activity result semantics (non-zero exit is a RESULT,
// only infra throws), heartbeating during runs, the gateway wire client's
// retryable/non-retryable split. MockActivityEnvironment provides a real
// activity context so heartbeats are observable.
import { describe, expect, it } from "vitest";
import { MockActivityEnvironment } from "@temporalio/testing";
import type { ToolInvokeWireResponse } from "@acos/contracts";
import { createExecutionActivities } from "./activities.js";
import { createGatewayClient, GatewayUnreachableError } from "./gateway-client.js";

const CTX = {
  companyId: "018f0000-0000-7000-8000-00000000c0c0",
  agentId: "018f0000-0000-7000-8000-00000000a9e7",
  taskId: "018f0000-0000-7000-8000-000000007a5c",
};

function gatewayResponse(overrides: Partial<ToolInvokeWireResponse> = {}): ToolInvokeWireResponse {
  return {
    invocationId: "018f0000-0000-7000-8000-00000000feed",
    decision: "allow",
    status: "succeeded",
    reason: null,
    riskClass: "R1",
    output: {
      exitCode: 0,
      stdoutTail: "42 passing",
      stderrTail: "",
      durationMs: 1234,
      terminalSessionId: "018f0000-0000-7000-8000-00000000ea11",
      provenance: "workspace",
    },
    costCents: 2,
    ...overrides,
  };
}

describe("execution activities (T40)", () => {
  it("runTestsActivity defaults to `npm test`, heartbeats, and maps the result", async () => {
    const calls: unknown[] = [];
    const activities = createExecutionActivities({
      invokeGateway: async (req) => {
        calls.push(req);
        return gatewayResponse();
      },
    });
    const env = new MockActivityEnvironment();
    const heartbeats: unknown[] = [];
    env.on("heartbeat", (d) => heartbeats.push(d));

    const result = await env.run(activities.runTestsActivity, { ...CTX });
    expect(result).toMatchObject({
      decision: "allow",
      status: "succeeded",
      exitCode: 0,
      stdoutTail: "42 passing",
      costCents: 2,
    });
    expect(calls[0]).toMatchObject({
      toolName: "terminal.run",
      input: { command: "npm test", timeoutSec: 600 },
    });
    expect(heartbeats.length).toBeGreaterThan(0); // liveness beat fired
  });

  it("a non-zero exit code is a RESULT the workflow reasons about — never a throw (08 §12)", async () => {
    const activities = createExecutionActivities({
      invokeGateway: async () =>
        gatewayResponse({
          output: {
            exitCode: 1,
            stdoutTail: "",
            stderrTail: "1 failing",
            durationMs: 900,
            terminalSessionId: "018f0000-0000-7000-8000-00000000ea11",
          },
        }),
    });
    const env = new MockActivityEnvironment();
    const result = await env.run(activities.runCommandActivity, { ...CTX, command: "npm test" });
    expect(result).toMatchObject({ exitCode: 1, stderrTail: "1 failing", status: "succeeded" });
  });

  it("a gateway DENY is a result too — the agent must see the structured refusal", async () => {
    const activities = createExecutionActivities({
      invokeGateway: async () =>
        gatewayResponse({
          decision: "deny",
          status: "denied",
          reason: "NO_PERMISSION_GRANT",
          output: undefined,
          costCents: 0,
        }),
    });
    const env = new MockActivityEnvironment();
    const result = await env.run(activities.buildActivity, { ...CTX });
    expect(result).toMatchObject({
      decision: "deny",
      status: "denied",
      exitCode: null,
      reason: "NO_PERMISSION_GRANT",
    });
  });

  it("infra failure (gateway unreachable) throws — the retryable class", async () => {
    const activities = createExecutionActivities({
      invokeGateway: async () => {
        throw new GatewayUnreachableError("connect ECONNREFUSED");
      },
    });
    const env = new MockActivityEnvironment();
    await expect(
      env.run(activities.runCommandActivity, { ...CTX, command: "ls" }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("gitOperationActivity maps ops onto git.diff / git.commit tools", async () => {
    const calls: { toolName: string; input: unknown }[] = [];
    const activities = createExecutionActivities({
      invokeGateway: async (req) => {
        calls.push({ toolName: req.toolName, input: req.input });
        return gatewayResponse({ output: undefined });
      },
    });
    const env = new MockActivityEnvironment();
    await env.run(activities.gitOperationActivity, { ...CTX, op: "diff", stat: true });
    await env.run(activities.gitOperationActivity, {
      ...CTX,
      op: "commit",
      message: "feat: csv export",
    });
    expect(calls).toEqual([
      { toolName: "git.diff", input: { stat: true } },
      { toolName: "git.commit", input: { message: "feat: csv export" } },
    ]);
  });
});

describe("gateway wire client", () => {
  const okJson = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200 });

  it("parses a valid response and passes the internal bearer", async () => {
    let seenAuth = "";
    const invoke = createGatewayClient({
      serverUrl: "http://server:3000",
      internalApiToken: "tok-0123456789abcdef",
      fetchImpl: async (_url, init) => {
        seenAuth = (init?.headers as Record<string, string>).authorization;
        return okJson(gatewayResponse());
      },
    });
    const res = await invoke({ ...CTX, toolName: "terminal.run", input: { command: "ls" } });
    expect(res.status).toBe("succeeded");
    expect(seenAuth).toBe("Bearer tok-0123456789abcdef");
  });

  it("5xx and network errors throw GatewayUnreachableError (retryable)", async () => {
    const flaky = createGatewayClient({
      serverUrl: "http://server:3000",
      internalApiToken: "tok-0123456789abcdef",
      fetchImpl: async () => new Response("boom", { status: 502 }),
    });
    await expect(
      flaky({ ...CTX, toolName: "terminal.run", input: {} }),
    ).rejects.toBeInstanceOf(GatewayUnreachableError);

    const dead = createGatewayClient({
      serverUrl: "http://server:3000",
      internalApiToken: "tok-0123456789abcdef",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    await expect(dead({ ...CTX, toolName: "terminal.run", input: {} })).rejects.toBeInstanceOf(
      GatewayUnreachableError,
    );
  });
});
