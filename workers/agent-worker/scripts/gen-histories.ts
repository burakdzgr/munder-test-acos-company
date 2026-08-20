// Golden-history generator (32 §3, T36): records real Temporal histories of
// agentTaskWorkflow against CANNED activity stubs (no Postgres, no LLM) and
// writes them to test/histories/*.json. Re-run deliberately after intended
// workflow changes: `pnpm --filter @acos/agent-worker gen:histories` — the
// replay suite (test/replay) then guards every refactor against
// nondeterminism.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import proto from "@temporalio/proto";
const { temporal } = proto;
import { NativeConnection, Worker } from "@temporalio/worker";
import { startTemporal } from "../test/integration/helpers";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../src/workflows/index.ts");
const outDir = join(dirname(fileURLToPath(import.meta.url)), "../test/histories");

const COMPANY = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const TASK = "33333333-3333-4333-8333-333333333333";
const APPROVAL = "44444444-4444-4444-8444-444444444444";

/** Canned activity set — pure data, deterministic per call order. */
function stubActivities(actions: object[]) {
  let call = 0;
  return {
    // E4/T31: the workflow asks the runtime first (patched "t31-cli-runtime");
    // canned stubs answer "steps" like the base activity set does.
    async resolveAgentRuntimeActivity() {
      return { kind: "steps" as const, reason: "stub" };
    },
    async startAgentSessionActivity() {},
    async getGuardSnapshotActivity() {
      return {
        budgetCents: null,
        spentCents: 0,
        remainingCents: null,
        estimatedNextStepCents: 0,
        deadline: null,
      };
    },
    async buildWorkingSetActivity() {
      return { messages: [{ role: "system", content: "golden" }], digest: "golden" };
    },
    async callModelActivity() {
      const action = actions[Math.min(call, actions.length - 1)];
      call += 1;
      return {
        text: JSON.stringify(action),
        usage: { inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 },
        model: "golden",
        costCents: 0,
        latencyMs: 1,
      };
    },
    async executeActionActivity(input: { action: { type: string } }) {
      if (input.action.type === "escalate") {
        return {
          ok: true,
          approvalId: APPROVAL,
          approvalStatus: "pending",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        };
      }
      return { ok: true, exitCode: 0 };
    },
    async persistStepActivity() {
      return { inserted: true };
    },
    async resumeFromWaitActivity() {},
    async expireApprovalActivity() {
      return { status: "expired" };
    },
    async guardEscalateActivity() {},
    async closeAgentSessionActivity() {},
  };
}

const TOOLLESS_REVIEW = [
  { type: "update_task_status", taskId: TASK, to: "IN_PROGRESS", note: "golden" },
  { type: "use_tool", tool: "noop", input: {}, reason: "golden step" },
  { type: "request_review", taskId: TASK, artifactId: APPROVAL, summary: "golden review" },
];

const APPROVAL_ESCALATE = [
  { type: "update_task_status", taskId: TASK, to: "IN_PROGRESS", note: "golden" },
  {
    type: "escalate",
    reason: "golden escalation",
    attempted: ["golden attempt"],
    options: [],
    recommendation: "approve",
  },
  {
    type: "complete_task",
    result: {
      summary: "approved and done",
      criteria: [],
      artifactIds: [],
      cost: { tokensIn: 0, tokensOut: 0, cents: 0 },
    },
  },
];

async function record(
  client: Client,
  connection: NativeConnection,
  name: string,
  actions: object[],
  afterStart?: (handle: import("@temporalio/client").WorkflowHandle) => Promise<void>,
): Promise<void> {
  const worker = await Worker.create({
    connection,
    namespace: "acos",
    taskQueue: "golden-histories",
    workflowsPath,
    activities: stubActivities(actions) as unknown as Record<string, (...args: never[]) => unknown>,
  });
  const run = worker.run();
  const handle = await client.workflow.start("agentTaskWorkflow", {
    taskQueue: "golden-histories",
    workflowId: `golden.${name}`,
    args: [{ companyId: COMPANY, agentId: AGENT, taskId: TASK, sessionId: TASK, attempt: 1 }],
  });
  if (afterStart) await afterStart(handle);
  await handle.result();
  const history = await handle.fetchHistory();
  // exact binary proto round-trip — historyToJSON chokes on payload metadata
  // bytes in this SDK version (recorded deviation from 32 §3's "JSON"), the
  // encoded History is byte-identical either way
  const bytes = temporal.api.history.v1.History.encodeDelimited(
    temporal.api.history.v1.History.create(history),
  ).finish();
  writeFileSync(join(outDir, `${name}.bin`), bytes);
  console.log(`recorded ${name}.bin (${history.events?.length ?? 0} events)`);
  worker.shutdown();
  await run;
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const temporal = await startTemporal();
  const connection = await NativeConnection.connect({ address: temporal.address });
  const clientConnection = await Connection.connect({ address: temporal.address });
  const client = new Client({ connection: clientConnection, namespace: "acos" });

  await record(client, connection, "toolless-review", TOOLLESS_REVIEW);
  await record(client, connection, "approval-escalate", APPROVAL_ESCALATE, async (handle) => {
    // let the workflow reach the durable approval wait, then decide
    await new Promise((r) => setTimeout(r, 2_000));
    await handle.signal("approvalVerdict", { approvalId: APPROVAL, verdict: "approved" });
  });

  await clientConnection.close();
  await connection.close();
  await temporal.container.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
