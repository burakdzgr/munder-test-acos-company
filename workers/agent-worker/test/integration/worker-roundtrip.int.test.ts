// T31 acceptance: a trivial workflow round-trips (a) against a REAL Temporal
// server (Testcontainers — same server family compose runs) and (b) in the
// TestWorkflowEnvironment harness (time-skipping test server). Plus the
// deterministic-ID conventions and REJECT_DUPLICATE dedupe of 09 §5.
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, Connection, WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { TASK_QUEUES } from "@acos/config";
import * as activities from "../../src/activities/index.js";
import { startAgentTaskWorkflow, workflowIds } from "../../src/client.js";
import { startTemporal } from "./helpers";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../../src/workflows/index.ts");

const COMPANY = "018f0000-0000-7000-8000-00000000c0c0";

describe("deterministic workflow ids (09 §5)", () => {
  it("builds the canonical id shapes", () => {
    expect(workflowIds.agentTask("t1", "a1")).toBe("agent-task.t1.a1");
    expect(workflowIds.agentInbox("a1")).toBe("agent-inbox.a1");
    expect(workflowIds.review("r1")).toBe("review.r1");
    expect(workflowIds.consolidation("c1", "b1")).toBe("memory-consolidation-c1-b1");
    expect(workflowIds.intake("p1")).toBe("intake.p1");
  });
});

describe("round-trip on a real Temporal server (compose family)", () => {
  let temporal: Awaited<ReturnType<typeof startTemporal>>;
  let nativeConnection: NativeConnection;
  let clientConnection: Connection;
  let client: Client;
  let worker: Worker;
  let workerRun: Promise<void>;

  beforeAll(async () => {
    temporal = await startTemporal();
    nativeConnection = await NativeConnection.connect({ address: temporal.address });
    worker = await Worker.create({
      connection: nativeConnection,
      namespace: "acos",
      taskQueue: TASK_QUEUES.agentTasks,
      workflowsPath,
      activities,
    });
    workerRun = worker.run();
    clientConnection = await Connection.connect({ address: temporal.address });
    client = new Client({ connection: clientConnection, namespace: "acos" });
  }, 300_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRun?.catch(() => {});
    await clientConnection?.close();
    await nativeConnection?.close();
    await temporal?.container.stop();
  });

  it("pingWorkflow round-trips through the echo activity", async () => {
    const handle = await client.workflow.start("pingWorkflow", {
      taskQueue: TASK_QUEUES.agentTasks,
      workflowId: "ping-roundtrip-1",
      args: [{ companyId: COMPANY, note: "compose" }],
    });
    await expect(handle.result()).resolves.toBe(`pong:${COMPANY}:echo:compose`);
  }, 60_000);

  it("agent-task starts dedupe: the second identical start is REJECT_DUPLICATE", async () => {
    const input = { companyId: COMPANY, note: "dedupe", taskId: "t-dedupe", agentId: "a-1" };
    const handle = await startAgentTaskWorkflow(client, "pingWorkflow", input);
    expect(handle.workflowId).toBe("agent-task.t-dedupe.a-1");
    await handle.result(); // completed — REJECT_DUPLICATE still refuses a restart
    await expect(startAgentTaskWorkflow(client, "pingWorkflow", input)).rejects.toBeInstanceOf(
      WorkflowExecutionAlreadyStartedError,
    );
  }, 60_000);
});

describe("TestWorkflowEnvironment harness (09 §10)", () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 300_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it("runs the same workflow in the time-skipping test env", async () => {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: TASK_QUEUES.agentTasks,
      workflowsPath,
      activities: {
        // activities are stubbed per test in the harness pattern (09 §10)
        echoActivity: async (note: string) => `stubbed:${note}`,
      },
    });
    await worker.runUntil(async () => {
      const result = await env.client.workflow.execute("pingWorkflow", {
        taskQueue: TASK_QUEUES.agentTasks,
        workflowId: "ping-test-env-1",
        args: [{ companyId: COMPANY, note: "harness" }],
      });
      expect(result).toBe(`pong:${COMPANY}:stubbed:harness`);
    });
  }, 120_000);
});
