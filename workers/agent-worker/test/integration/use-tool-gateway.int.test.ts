// T40 (loop side): the scripted agent's use_tool actions leave the loop
// through the Tool Gateway seam — canonical script tool names are mapped
// onto registry tools (write_file→fs.write, run_command→terminal.run), the
// step-derived idempotency key rides along, and the gateway's structured
// result becomes the observation the script branches on ([lastExitCode:n]).
// The gateway itself is a recording fake here; the real gateway→sandbox
// chain is proven in the server's Docker-gated dispatch suite.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, asc, eq } from "drizzle-orm";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { uuidv7 } from "@acos/domain";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agentSteps,
  agents,
  companies,
  modelProviders,
  orgUnits,
  positions,
  tasks,
  users,
} from "@acos/db/schema";
import { ModelRouter, type ProviderAdapter } from "@acos/llm";
import { createScriptedAdapter, loadScript } from "@acos/llm/testing";
import { TASK_QUEUES } from "@acos/config";
import { createAgentTaskActivities, mapToolCall } from "../../src/activities/agent-task.js";
import { workflowIds } from "../../src/client.js";
import { startPostgres, startTemporal } from "./helpers";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../../src/workflows/index.ts");

let pgContainer: Awaited<ReturnType<typeof startPostgres>>;
let temporal: Awaited<ReturnType<typeof startTemporal>>;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let nativeConnection: NativeConnection;
let clientConnection: Connection;
let client: Client;
let worker: Worker;
let workerRun: Promise<void>;

let companyId = "";
let DEV = "";
let taskId = "";
const sessionId = uuidv7();

interface RecordedInvoke {
  toolName: string;
  input: unknown;
  idempotencyKey: string;
}
const invoked: RecordedInvoke[] = [];

beforeAll(async () => {
  [pgContainer, temporal] = await Promise.all([startPostgres(), startTemporal()]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t40.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "ToolCo", slug: "toolco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Eng", slug: "eng" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({
      companyId,
      title: "Backend Engineer",
      seniorityTrack: ["mid"],
      defaultRole: "backend-dev",
    })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      employeeNumber: 1,
      name: "Owen Owner",
      status: "active",
      positionId: position!.id,
      orgUnitId: unit!.id,
      seniority: "mid",
      autonomyLevel: 2,
      persona: "Backend engineer.",
    })
    .returning();
  DEV = agent!.id;
  const [task] = await db
    .insert(tasks)
    .values({
      companyId,
      number: 1,
      kind: "task",
      title: "Implement CSV export",
      objective: "CSV export works.",
      status: "ASSIGNED",
      ownerAgentId: DEV,
      successCriteria: ["exports CSV"],
      context: { taskFixture: "implement-feature" },
    })
    .returning();
  taskId = task!.id;

  const [provider] = await db
    .insert(modelProviders)
    .values({ kind: "ollama", name: "scripted" })
    .returning();
  const scriptsDir = join(dirname(require.resolve("@acos/llm/package.json")), "testing/scripts");
  const script = loadScript(
    readFileSync(join(scriptsDir, "backend-dev.task-implement.yaml"), "utf8"),
  );
  const adapter: ProviderAdapter = {
    ...createScriptedAdapter([script], { taskId }),
    providerId: provider!.id,
  };
  const router = new ModelRouter({
    providers: new Map([[provider!.id, adapter]]),
    logCall: () => {},
  });

  const activities = createAgentTaskActivities({
    guardedDb,
    router,
    routingFor: async () => ({
      bindings: [],
      profiles: [{ purpose: "reasoning", providerId: provider!.id, model: "scripted" }],
    }),
    // T40 seam under test: a recording gateway that answers like the real one
    invokeTool: async (req) => {
      invoked.push({
        toolName: req.toolName,
        input: req.input,
        idempotencyKey: req.idempotencyKey,
      });
      if (req.toolName === "terminal.run") {
        return {
          invocationId: uuidv7(),
          decision: "allow",
          status: "succeeded",
          reason: null,
          output: {
            exitCode: 0,
            stdoutTail: "12 passing",
            stderrTail: "",
            durationMs: 800,
            terminalSessionId: uuidv7(),
            provenance: "workspace",
          },
          costCents: 1,
        };
      }
      return {
        invocationId: uuidv7(),
        decision: "allow",
        status: "succeeded",
        reason: null,
        output: { byteSize: 42, created: true, lockConflicts: [], provenance: "workspace" },
        costCents: 0,
      };
    },
  });

  nativeConnection = await NativeConnection.connect({ address: temporal.address });
  worker = await Worker.create({
    connection: nativeConnection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.agentTasks,
    workflowsPath,
    activities: activities as unknown as Record<string, (...args: never[]) => unknown>,
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
  await pool?.end();
  await pgContainer?.stop();
  await temporal?.container.stop();
});

describe("use_tool → Tool Gateway wiring (T40)", () => {
  it("the scripted loop leaves via the gateway seam with mapped tools + step keys", async () => {
    const result = await client.workflow.execute("agentTaskWorkflow", {
      taskQueue: TASK_QUEUES.agentTasks,
      workflowId: workflowIds.agentTask(taskId, DEV),
      args: [{ companyId, agentId: DEV, taskId, sessionId, attempt: 1 }],
    });
    expect(result).toEqual({ outcome: "review_requested", steps: 4 });

    // the two use_tool steps hit the gateway with REGISTRY names (recorded
    // mapping from the canonical 32 §6.1 script vocabulary)
    expect(invoked.map((c) => c.toolName)).toEqual(["fs.write", "terminal.run"]);
    expect(invoked[0]!.input).toMatchObject({ path: "src/export/csv.ts" });
    expect(invoked[1]!.input).toMatchObject({ command: "npm test" });
    for (const call of invoked) {
      expect(call.idempotencyKey).toMatch(/^tool:[0-9a-f-]{36}$/);
    }

    // happy path: exitCode 0 observation ⇒ the nonzero-exit rework branch is
    // NOT taken and the task lands in REVIEW
    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
    expect(task!.status).toBe("REVIEW");

    const steps = await db
      .select()
      .from(agentSteps)
      .where(and(eq(agentSteps.companyId, companyId), eq(agentSteps.agentSessionId, sessionId)))
      .orderBy(asc(agentSteps.stepNo));
    expect(steps.map((s) => s.actionKind)).toEqual([
      "update_task_status",
      "use_tool",
      "use_tool",
      "request_review",
    ]);
  }, 180_000);

  it("mapToolCall translates the canonical script vocabulary and passes registry names through", () => {
    expect(mapToolCall("write_file", { path: "a.ts", contentRef: "fixture:v1" })).toEqual({
      toolName: "fs.write",
      input: { path: "a.ts", content: "// fixture:v1" },
    });
    expect(mapToolCall("run_command", { command: "npm test" })).toEqual({
      toolName: "terminal.run",
      input: { command: "npm test" },
    });
    expect(mapToolCall("terminal.run", { command: "ls" })).toEqual({
      toolName: "terminal.run",
      input: { command: "ls" },
    });
  });
});
