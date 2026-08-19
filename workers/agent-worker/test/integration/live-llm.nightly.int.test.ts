// Nightly live-model variant (T36; 32 §6 tier 3, M3 DoD "with real LLM
// calls"): the same toolless runtime driven by a REAL provider instead of
// the scripted fake. Never runs in per-PR CI — requires LIVE_LLM=1 and an
// ANTHROPIC_API_KEY (nightly.yml supplies both). A hard task budget plus the
// runaway guards cap the spend; the assertion is that the loop holds against
// a live model: schema-valid actions, accounted llm_calls, terminal outcome.
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
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
  agents,
  companies,
  llmCalls,
  modelProviders,
  orgUnits,
  positions,
  tasks,
  users,
} from "@acos/db/schema";
import { ModelRouter, createAnthropicAdapter } from "@acos/llm";
import { TASK_QUEUES } from "@acos/config";
import { createAgentTaskActivities } from "../../src/activities/agent-task.js";
import { startPostgres, startTemporal } from "./helpers";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../../src/workflows/index.ts");

const LIVE = process.env.LIVE_LLM === "1" && !!process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.LIVE_LLM_MODEL ?? "claude-haiku-4-5-20251001";

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
let AGENT = "";
let taskId = "";

describe.skipIf(!LIVE)("nightly: live-LLM toolless run (T36)", () => {
  beforeAll(async () => {
    [pgContainer, temporal] = await Promise.all([startPostgres(), startTemporal()]);
    await runMigrations(pgContainer.getConnectionUri());
    pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
    pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
    db = createDb(pool);
    guardedDb = createGuardedDb(pool);

    const [founder] = await db
      .insert(users)
      .values({ email: "founder@nightly.local", passwordHash: "x", displayName: "F" })
      .returning();
    const [company] = await db
      .insert(companies)
      .values({ name: "NightlyCo", slug: "nightlyco", createdByUserId: founder!.id })
      .returning();
    companyId = company!.id;
    ctx = companyContext(companyId);
    const [unit] = await db
      .insert(orgUnits)
      .values({ companyId, kind: "team", name: "Live", slug: "live" })
      .returning();
    const [position] = await db
      .insert(positions)
      .values({ companyId, title: "Analyst", seniorityTrack: ["mid"], defaultRole: "member" })
      .returning();
    AGENT = (
      await db
        .insert(agents)
        .values({
          companyId,
          employeeNumber: 1,
          name: "Liv Model",
          status: "active",
          positionId: position!.id,
          orgUnitId: unit!.id,
          seniority: "mid",
          autonomyLevel: 2,
          persona:
            "You run in a nightly evaluation. Do the task with the FEWEST steps: move it to IN_PROGRESS, then request_review with a short summary. Never invent tools.",
        })
        .returning()
    )[0]!.id;
    taskId = (
      await db
        .insert(tasks)
        .values({
          companyId,
          number: 1,
          kind: "task",
          title: "Write a two-sentence summary of the ACOS runtime",
          objective:
            "Toolless: set the task IN_PROGRESS, then hand it to review with your summary in the request_review summary field.",
          status: "ASSIGNED",
          ownerAgentId: AGENT,
          successCriteria: ["review requested"],
          budgetCents: 500, // 32 §6.3 hard cap — guard (a) stops runaway spend
        })
        .returning()
    )[0]!.id;

    const [provider] = await db
      .insert(modelProviders)
      .values({ kind: "anthropic", name: "anthropic-nightly" })
      .returning();
    const adapter = createAnthropicAdapter({
      providerId: provider!.id,
      apiKey: process.env.ANTHROPIC_API_KEY!,
    });
    const router = new ModelRouter({
      providers: new Map([[provider!.id, adapter]]),
      logCall: () => {},
    });

    nativeConnection = await NativeConnection.connect({ address: temporal.address });
    clientConnection = await Connection.connect({ address: temporal.address });
    client = new Client({ connection: clientConnection, namespace: "acos" });
    const activities = createAgentTaskActivities({
      guardedDb,
      router,
      routingFor: async () => ({
        bindings: [],
        profiles: [
          { purpose: "reasoning", providerId: provider!.id, model: MODEL, maxTokensPerCall: 1024 },
        ],
      }),
    });
    worker = await Worker.create({
      connection: nativeConnection,
      namespace: "acos",
      taskQueue: TASK_QUEUES.agentTasks,
      workflowsPath,
      activities: activities as unknown as Record<string, (...args: never[]) => unknown>,
    });
    workerRun = worker.run();
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

  it("a real model drives the loop to a terminal outcome within the budget", async () => {
    const result = (await client.workflow.execute("agentTaskWorkflow", {
      taskQueue: TASK_QUEUES.agentTasks,
      workflowId: `agent-task.${taskId}.${AGENT}`,
      args: [{ companyId, agentId: AGENT, taskId, sessionId: uuidv7(), attempt: 1 }],
    })) as { outcome: string; steps: number };

    // live models vary — the contract is: terminal outcome, bounded steps,
    // every call accounted, spend inside the hard cap
    expect(["review_requested", "completed", "abandoned", "guard_stopped"]).toContain(
      result.outcome,
    );
    expect(result.steps).toBeLessThanOrEqual(50);
    const calls = await db
      .select()
      .from(llmCalls)
      .where(and(eq(llmCalls.companyId, companyId), eq(llmCalls.taskId, taskId)));
    expect(calls.length).toBeGreaterThan(0);
    const [finalTask] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(finalTask!.spentCents).toBeLessThanOrEqual(500);
  }, 600_000);
});
