// T34 acceptance — the guard suite of 32 §3 on TestWorkflowEnvironment with
// time skipping and stub activities: budget guard, time-skipped deadline,
// loop detector, step cap, managerDirective(pause), cancel, and the 50-step
// continueAsNew with carried state.
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { STEP_HARD_CAP, uuidv7 } from "@acos/domain";
import { TASK_QUEUES } from "@acos/config";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../../src/workflows/index.ts");

const COMPANY = "018f0000-0000-7000-8000-00000000c0c0";
const AGENT = "018f0000-0000-7000-8000-0000000000a1";
const TASK = "018f0000-0000-7000-8000-0000000000t1".replace("t1", "b1");

interface StubOptions {
  /** JSON actions returned per step (cycled when exhausted). */
  script: Array<Record<string, unknown>>;
  snapshot?: Partial<{
    budgetCents: number | null;
    spentCents: number;
    remainingCents: number | null;
    estimatedNextStepCents: number;
    deadline: string | null;
  }>;
}

function makeStubActivities(options: StubOptions) {
  const calls = {
    guardEscalate: [] as Array<{ guard: string; detail: string }>,
    persisted: [] as Array<{ stepNo: number; actionType: string }>,
    sessionClosed: [] as string[],
    executed: [] as string[],
  };
  let scriptIndex = 0;
  const activities = {
    async startAgentSessionActivity() {},
    async buildWorkingSetActivity(input: { stepNo: number }) {
      return { messages: [{ role: "user", content: `step ${input.stepNo}` }], digest: "d" };
    },
    async callModelActivity() {
      const action = options.script[Math.min(scriptIndex, options.script.length - 1)]!;
      scriptIndex += 1;
      return {
        text: JSON.stringify(action),
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
        model: "stub",
        costCents: 0,
        latencyMs: 1,
      };
    },
    async executeActionActivity(input: { action: { type: string } }) {
      calls.executed.push(input.action.type);
      return { ok: true, exitCode: 0 };
    },
    async persistStepActivity(input: { stepNo: number; action: { type: string } }) {
      calls.persisted.push({ stepNo: input.stepNo, actionType: input.action.type });
      return { inserted: true };
    },
    async resumeFromWaitActivity() {},
    async getGuardSnapshotActivity() {
      return {
        budgetCents: null,
        spentCents: 0,
        remainingCents: null,
        estimatedNextStepCents: 0,
        deadline: null,
        ...options.snapshot,
      };
    },
    async guardEscalateActivity(input: { guard: string; detail: string }) {
      calls.guardEscalate.push({ guard: input.guard, detail: input.detail });
    },
    async closeAgentSessionActivity(input: { status: string }) {
      calls.sessionClosed.push(input.status);
    },
    async triageInboxActivity() {
      return { verdict: "ignore" as const };
    },
    async markInboxReadActivity() {},
    async echoActivity(note: string) {
      return `echo:${note}`;
    },
  };
  return { activities, calls };
}

/**
 * Distinct use_tool actions — loop-detector-safe filler.
 *
 * This is only true because normalization keeps numbered siblings APART. The
 * workflow's old private normalizer folded every digit to a placeholder, so
 * `file-1.ts` and `file-2.ts` hashed alike and this "filler" tripped guard (d)
 * on its 4th step — which is why (c) could never reach the cap it measures.
 */
const distinctTool = (n: number) => ({
  type: "use_tool",
  tool: "write_file",
  input: { path: `src/file-${n}.ts` },
  reason: `step ${n}`,
});

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 300_000);

afterAll(async () => {
  await env?.teardown();
});

async function runWorkflow(
  stub: ReturnType<typeof makeStubActivities>,
  opts: { workflowId: string; signalScript?: (handle: import("@temporalio/client").WorkflowHandle) => Promise<void> },
) {
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue: TASK_QUEUES.agentTasks,
    workflowsPath,
    activities: stub.activities as never,
  });
  return worker.runUntil(async () => {
    const handle = await env.client.workflow.start("agentTaskWorkflow", {
      taskQueue: TASK_QUEUES.agentTasks,
      workflowId: opts.workflowId,
      args: [{ companyId: COMPANY, agentId: AGENT, taskId: TASK, sessionId: uuidv7(), attempt: 1 }],
      followRuns: true,
    });
    await opts.signalScript?.(handle);
    return handle.result();
  });
}

describe("runaway guards (08 §9, 32 §3)", () => {
  it("(a) budget exhausted stops before the step and escalates with the spend report", async () => {
    const stub = makeStubActivities({
      script: [distinctTool(1)],
      snapshot: { budgetCents: 100, spentCents: 100, remainingCents: 0, estimatedNextStepCents: 5 },
    });
    const result = await runWorkflow(stub, { workflowId: `guard-budget-${Date.now()}` });
    expect(result).toMatchObject({ outcome: "guard_stopped" });
    expect(stub.calls.guardEscalate).toHaveLength(1);
    expect(stub.calls.guardEscalate[0]).toMatchObject({ guard: "budget" });
    expect(stub.calls.persisted).toHaveLength(0); // the step never started
  }, 60_000);

  it("(b) deadline passes mid-wait (time-skipped) → forced escalation, work continues", async () => {
    const stub = makeStubActivities({
      script: [
        { type: "wait_for", what: "timer", timeoutMinutes: 240 }, // 4h park
        distinctTool(2),
        { type: "request_review", taskId: TASK, artifactId: uuidv7(), summary: "done" },
      ],
      snapshot: { deadline: new Date(Date.now() + 60 * 60_000).toISOString() }, // 1h deadline
    });
    const result = await runWorkflow(stub, { workflowId: `guard-deadline-${Date.now()}` });
    // the 4h wait_for skipped past the 1h deadline; the NEXT step escalated
    expect(stub.calls.guardEscalate.map((g) => g.guard)).toContain("deadline");
    expect(result).toMatchObject({ outcome: "review_requested" });
  }, 60_000);

  it("(d) loop detector: 3 identical actions within the window force help", async () => {
    const same = { type: "use_tool", tool: "run_command", input: { command: "npm test" }, reason: "again" };
    const stub = makeStubActivities({ script: [same, same, same, same] });
    const result = await runWorkflow(stub, { workflowId: `guard-loop-${Date.now()}` });
    expect(result).toMatchObject({ outcome: "guard_stopped" });
    expect(stub.calls.guardEscalate[0]).toMatchObject({ guard: "loop" });
    // the tripping step is persisted with the guard observation, not executed
    expect(stub.calls.persisted).toHaveLength(3);
    expect(stub.calls.executed).toHaveLength(2); // 3rd identical never ran
  }, 60_000);

  it("(d) normalization: volatile uuids/timestamps do NOT defeat the detector", async () => {
    const withUuid = () => ({
      type: "use_tool",
      tool: "run_command",
      input: { command: "npm test", nonce: uuidv7() }, // fresh uuid each step
      reason: "same thing",
    });
    const stub = makeStubActivities({ script: [withUuid(), withUuid(), withUuid(), withUuid()] });
    const result = await runWorkflow(stub, { workflowId: `guard-loop-norm-${Date.now()}` });
    expect(result).toMatchObject({ outcome: "guard_stopped" });
    expect(stub.calls.guardEscalate[0]).toMatchObject({ guard: "loop" });
  }, 60_000);

  it(`(c)+(§10) continueAsNew every 50 local steps; cumulative cap trips at ${STEP_HARD_CAP}`, async () => {
    // The cap is CUMULATIVE across continues, so this walks three runs:
    // 1..50, 51..100, 101..120 — then the 121st step is refused.
    const script = Array.from({ length: STEP_HARD_CAP + 10 }, (_, i) => distinctTool(i + 1));
    const stub = makeStubActivities({ script });
    const workflowId = `guard-can-${Date.now()}`;
    const result = await runWorkflow(stub, { workflowId });
    expect(result).toMatchObject({ outcome: "guard_stopped" });
    // guard (c) is evaluated at the TOP of the loop against completed steps, so
    // exactly STEP_HARD_CAP steps run and the next one is refused before it starts
    expect(stub.calls.persisted).toHaveLength(STEP_HARD_CAP);
    expect(stub.calls.persisted[STEP_HARD_CAP - 1]).toMatchObject({ stepNo: STEP_HARD_CAP });
    expect(stub.calls.guardEscalate[0]).toMatchObject({ guard: "step_cap" });
    // the FIRST run's history ends in ContinueAsNew — proof the boundary fired
    const firstRun = env.client.workflow.getHandle(workflowId);
    const history = await firstRun.fetchHistory();
    const continued = history.events?.some(
      (e) => e.workflowExecutionContinuedAsNewEventAttributes !== undefined,
    );
    expect(continued).toBe(true);
    // session stayed open across the continue — closed exactly once at the end
    expect(stub.calls.sessionClosed).toHaveLength(1);
  }, 240_000);

  it("managerDirective(pause) parks the loop; resume continues; cancel ends it", async () => {
    // both steps park on wait_for(reply) — signal timing is deterministic
    const wait = { type: "wait_for", what: "reply", timeoutMinutes: 240 };
    const stub = makeStubActivities({ script: [wait, wait] });
    const inboxItem = (n: number) => ({
      signalId: `sig-${n}`,
      messageId: uuidv7(),
      channelId: uuidv7(),
      senderAgentId: null,
      kind: "text",
      preview: "wake up",
      mentioned: false,
      sentAt: new Date().toISOString(),
    });
    const waitForExecuted = async (count: number) => {
      const deadline = Date.now() + 30_000;
      while (stub.calls.executed.length < count) {
        if (Date.now() > deadline) throw new Error("wait_for never executed");
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const result = await runWorkflow(stub, {
      workflowId: `guard-pause-${Date.now()}`,
      signalScript: async (handle) => {
        await waitForExecuted(1); // step 1 parked on wait_for
        await handle.signal("managerDirective", { directive: "pause" });
        await handle.signal("messageReceived", inboxItem(1)); // wakes the wait…
        await env.sleep("5m"); // …but the loop top parks on paused
        expect(stub.calls.persisted).toHaveLength(1); // only the wait step
        await handle.signal("managerDirective", { directive: "resume" });
        await waitForExecuted(2); // step 2 runs and parks again
        await handle.signal("cancel", { by: "test", reason: "done" });
      },
    });
    expect(result).toMatchObject({ outcome: "abandoned" });
    expect(stub.calls.persisted).toHaveLength(2);
    expect(stub.calls.sessionClosed).toEqual(["failed"]);
  }, 60_000);
});
