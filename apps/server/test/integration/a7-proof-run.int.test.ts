// A7 — TEK KANIT KOŞUSU (pazarlık dışı).
//
// Bu projenin bütün bloker'ları "kod var ama sistem çalışmıyor" boşluğunda
// yaşadı; tip sistemi ve birim testleri hiçbirini görmedi. Brifing bu yüzden
// üç ayrı e2e değil, ÜÇÜNÜ BİRDEN kanıtlayan tek bir senaryo istiyor:
//
//   Founder bir hedef verir → CEO decompose eder → alt görev gerçek artefakt
//   üretir → review→QA→merge → parent roll-up ile DONE → task.completed →
//   hafıza konsolidasyonu → memory.created → panelde görünür. Boyunca:
//   cost_entries yazılır, tasks.spent_cents artar, bütçe eşiği aşılınca devre
//   kesici ajanları duraklatır, bütçe yükseltilince otomatik devam eder.
//
// Assert edilenler: (1) devre kesici zinciri, (2) döngü kapanışı (A4 bağımlılık
// sinyali + A5 konteyner roll-up + A6 sweep), (3) hafıza zinciri.
//
// Sahte olan TEK şey sandbox-manager'ın HTTP sınırı ve Temporal'ın workflow
// "start" semantiği (kuyruğa düşen run'lar sırayla koşturuluyor). Postgres,
// NATS/JetStream, outbox relay, Tool Gateway, görev motoru, inceleme
// activity'leri, konsolidasyon workflow'u ve /ws yayını gerçek.
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { connect, type NatsConnection } from "nats";
import { WebSocket } from "ws";
import { and, eq } from "drizzle-orm";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { uuidv7 } from "@acos/domain";
import {
  CostService,
  TasksService,
  TaskStateService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  sweepStuckTasks,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agentSessions,
  agents,
  budgets,
  companies,
  costEntries,
  events,
  memories,
  orgEdges,
  orgUnits,
  positions,
  projects,
  repositories,
  reviews,
  tasks,
  toolPermissions,
  users,
  workspaces,
} from "@acos/db/schema";
import { ModelRouter } from "@acos/llm";
import { TASK_QUEUES } from "@acos/config";
import { buildApp, type App } from "../../src/app.js";
import { OutboxRelay } from "../../src/modules/events/relay.js";
import { provisionJetStream } from "../../src/modules/events/jetstream.js";
import { startMemoryTrigger, type MemoryTriggerHandle } from "../../src/modules/memory/trigger.js";
import {
  startDependencySignalBridge,
  type DependencyBridgeHandle,
  type DependencySignalInput,
} from "../../src/modules/tasks/dependency-signal.js";
import {
  startBreakerConsumer,
  type BreakerConsumerHandle,
  type BreakerDirectiveInput,
} from "../../src/modules/costs/breaker-consumer.js";
import { ToolGateway } from "../../src/modules/tools/gateway.js";
import { createSandboxDispatchPort } from "../../src/modules/tools/dispatch.js";
// test-only cross-package relative import'lar — task-done-memory-chain ile aynı kalıp
import { createAgentTaskActivities } from "../../../../workers/agent-worker/src/activities/agent-task.js";
import { createReviewActivities } from "../../../../workers/agent-worker/src/review/activities.js";
import { createMemoryActivities } from "../../../../workers/agent-worker/src/memory/activities.js";
import { startNats, startPostgres, startTemporal, type StartedPostgreSqlContainer } from "./helpers";

const require = createRequire(import.meta.url);
const memoryWorkflowsPath = require.resolve(
  "../../../../workers/agent-worker/src/workflows/memory/index.ts",
);

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const INTERNAL_TOKEN = "a7-proof-token-0123456789";
const MERGE_COMMIT = "f0e1d2c3b4a596877869504132231415a6b7c8d9";
const ok = async () => {};

let pgContainer: StartedPostgreSqlContainer;
let natsHandle: Awaited<ReturnType<typeof startNats>>;
let temporal: Awaited<ReturnType<typeof startTemporal>>;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let nc: NatsConnection;
let relay: OutboxRelay;
let memoryTrigger: MemoryTriggerHandle;
let dependencyBridge: DependencyBridgeHandle;
let breakerConsumer: BreakerConsumerHandle;
let app: App;
let wsUrl = "";
let sessionCookie = "";
let csrfToken = "";
let sandboxStub: Server;
let clientConnection: Connection;
let nativeConnection: NativeConnection;
let client: Client;
let memoryWorker: Worker;
let memoryWorkerRun: Promise<void>;

let companyId = "";
let projectId = "";
let repositoryId = "";
const agentId: Record<string, string> = {};

interface PendingReview {
  companyId: string;
  reviewId: string;
  taskId: string;
  reviewerAgentId: string;
  authorAgentId: string;
}
const pendingReviews: PendingReview[] = [];
const pendingReworks: { agentId: string; taskId: string }[] = [];

/** A4: köprünün gönderdiği bağımlılık sinyalleri. */
const dependencySignals: DependencySignalInput[] = [];
/** Devre kesicinin gönderdiği direktifler. */
const breakerDirectives: BreakerDirectiveInput[] = [];

let agentActivities: ReturnType<typeof createAgentTaskActivities>;
let reviewActivities: ReturnType<typeof createReviewActivities>;

async function pollUntil<T>(
  probe: () => Promise<T | null>,
  what: string,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`beklenirken zaman aşımı: ${what}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

class WsProbe {
  readonly frames: unknown[] = [];
  readonly socket: WebSocket;

  constructor(headers: Record<string, string>) {
    this.socket = new WebSocket(wsUrl, { headers });
    this.socket.on("message", (raw) => this.frames.push(JSON.parse(String(raw))));
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  async expectFrame<T>(predicate: (f: unknown) => boolean, timeoutMs = 60_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.frames.find(predicate);
      if (hit !== undefined) return hit as T;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`beklenen /ws frame gelmedi; ${this.frames.length} frame alındı`);
  }

  close(): void {
    this.socket.terminate();
  }
}

function wsEventTypes(probe: WsProbe): string[] {
  return probe.frames
    .filter((f): f is { events: Array<{ type: string }> } =>
      Array.isArray((f as { events?: unknown }).events),
    )
    .flatMap((f) => f.events.map((e) => e.type));
}

function startSandboxStub(): Promise<string> {
  sandboxStub = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      const url = req.url ?? "";
      const reply = (payload: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url === "/internal/v1/repos")
        return reply({ barePath: "/data/repos/x.git", headCommit: "0".repeat(40), created: true });
      if (url === "/internal/v1/worktrees")
        return reply({ volumeName: "ws-a7", baseCommit: "0".repeat(40), created: true });
      if (url === "/internal/v1/workspaces")
        return reply({ workspaceId: "stub", containerId: "stub", status: "ready" });
      if (url.endsWith("/exec"))
        return reply({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false });
      if (url === "/internal/v1/worktrees/push") return reply({ pushed: true, remoteHead: MERGE_COMMIT });
      if (url === "/internal/v1/repos/merge") return reply({ merged: true, mergeCommit: MERGE_COMMIT });
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) => {
    sandboxStub.listen(0, "127.0.0.1", () => {
      const address = sandboxStub.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

/** Sahibin `complete_task`'ı — gerçek agent activity. */
async function ownerSubmitsForReview(ownerAgentId: string, taskId: string): Promise<unknown> {
  return agentActivities.executeActionActivity({
    companyId,
    agentId: ownerAgentId,
    taskId,
    sessionId: uuidv7(),
    stepId: uuidv7(),
    action: {
      type: "complete_task",
      result: {
        summary: "İş bitti, dal merge'e hazır.",
        criteria: [{ criterion: "kabul", met: true, evidence: "src/x.ts" }],
        artifactIds: [],
        cost: { tokensIn: 0, tokensOut: 0, cents: 0 },
      },
    },
  });
}

async function runReviewWorkflow(input: PendingReview): Promise<void> {
  const started = await reviewActivities.startReviewActivity({
    companyId: input.companyId,
    reviewId: input.reviewId,
    reviewerAgentId: input.reviewerAgentId,
  });
  const decision = await reviewActivities.decideReviewActivity({
    companyId: input.companyId,
    reviewId: input.reviewId,
    taskId: input.taskId,
    kind: started.kind,
  });
  await reviewActivities.submitReviewVerdictActivity({
    companyId: input.companyId,
    reviewId: input.reviewId,
    taskId: input.taskId,
    reviewerAgentId: input.reviewerAgentId,
    verdict: decision.verdict,
    note: decision.note,
  });
}

async function drainWorkflowStarts(): Promise<void> {
  for (let guard = 0; guard < 20; guard += 1) {
    const review = pendingReviews.shift();
    if (review) {
      await runReviewWorkflow(review);
      continue;
    }
    const rework = pendingReworks.shift();
    if (rework) {
      await ownerSubmitsForReview(rework.agentId, rework.taskId);
      continue;
    }
    return;
  }
  throw new Error("inceleme/rework döngüsü kapanmadı — sonsuz döngü koruması");
}

/** Bir iş görevini teslimata kadar sürer: complete_task → review → QA → merge. */
async function deliver(taskId: string, ownerAgentId: string): Promise<void> {
  await ownerSubmitsForReview(ownerAgentId, taskId);
  await drainWorkflowStarts();
}

const statusOf = async (taskId: string) =>
  (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0]!.status;

beforeAll(async () => {
  [pgContainer, natsHandle, temporal] = await Promise.all([
    startPostgres(),
    startNats(),
    startTemporal(),
  ]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  nc = await connect({ servers: natsHandle.url });
  await provisionJetStream(nc);

  const sandboxUrl = await startSandboxStub();

  app = await buildApp({
    healthCheckers: { postgres: ok, nats: ok, temporal: ok },
    logger: false,
    db,
    guardedDb,
    masterKey: MASTER_KEY,
    internalApiToken: INTERNAL_TOKEN,
    sandboxManagerUrl: sandboxUrl,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as { port: number };
  wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  app.realtime!.attachNats(nc);
  relay = new OutboxRelay({ connectionString: pgContainer.getConnectionUri(), nats: nc });
  await relay.start();

  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { email: "founder@a7.local", password: "correct-horse-battery", displayName: "F" },
  });
  for (const c of setup.cookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }
  const companyResponse = await app.inject({
    method: "POST",
    url: "/api/v1/companies",
    headers: {
      cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
      "x-csrf-token": csrfToken,
    },
    payload: { name: "ProofCo", slug: "proofco", currency: "USD" },
  });
  expect(companyResponse.statusCode, companyResponse.body).toBeLessThan(300);
  companyId = companyResponse.json().id;
  ctx = companyContext(companyId);
  const [founder] = await db.select().from(users).where(eq(users.email, "founder@a7.local"));

  const [eng] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Engineering", slug: "eng" })
    .returning();
  const [backend] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend", parentId: eng!.id })
    .returning();
  const positionId: Record<string, string> = {};
  for (const [title, role, track] of [
    ["Backend Engineer", "member", "mid"],
    ["Engineering Manager", "manager", "lead"],
    ["QA Engineer", "qa", "mid"],
    ["CEO", "executive", "executive"],
  ] as const) {
    const [position] = await db
      .insert(positions)
      .values({ companyId, title, seniorityTrack: [track], defaultRole: role })
      .returning();
    positionId[title] = position!.id;
  }
  const hire = async (name: string, n: number, title: string, unitId: string, autonomy: number) =>
    (
      await db
        .insert(agents)
        .values({
          companyId,
          employeeNumber: n,
          name,
          status: "active",
          positionId: positionId[title]!,
          orgUnitId: unitId,
          seniority: "mid",
          autonomyLevel: autonomy,
          persona: `${name}.`,
        })
        .returning()
    )[0]!.id;
  agentId.ceo = await hire("Ceyda CEO", 1, "CEO", eng!.id, 5);
  agentId.dev = await hire("Alex Demir", 2, "Backend Engineer", backend!.id, 2);
  agentId.dev2 = await hire("Bora Kaya", 3, "Backend Engineer", backend!.id, 2);
  agentId.manager = await hire("Kerem Yıldız", 4, "Engineering Manager", backend!.id, 4);
  agentId.qa = await hire("Baran Çelik", 5, "QA Engineer", eng!.id, 3);
  await db.insert(orgEdges).values([
    { companyId, fromAgentId: agentId.dev!, kind: "reports_to", toAgentId: agentId.manager! },
    { companyId, fromAgentId: agentId.dev2!, kind: "reports_to", toAgentId: agentId.manager! },
    { companyId, fromAgentId: agentId.manager!, kind: "manages", toAgentId: agentId.dev! },
    { companyId, fromAgentId: agentId.dev!, kind: "member_of", toUnitId: backend!.id },
    { companyId, fromAgentId: agentId.dev2!, kind: "member_of", toUnitId: backend!.id },
    { companyId, fromAgentId: agentId.manager!, kind: "member_of", toUnitId: backend!.id },
    { companyId, fromAgentId: agentId.qa!, kind: "member_of", toUnitId: eng!.id },
  ]);
  for (const unit of [eng!.id, backend!.id]) {
    for (const toolName of ["fs.*", "git.*", "terminal.run"]) {
      await db
        .insert(toolPermissions)
        .values({ companyId, toolName, subjectKind: "org_unit", subjectId: unit })
        .onConflictDoNothing();
    }
  }

  const [project] = await db
    .insert(projects)
    .values({
      companyId,
      slug: "proofproj",
      name: "Proof Project",
      objectiveMd: "uçtan uca teslimat",
      createdByUserId: founder!.id,
    })
    .returning();
  projectId = project!.id;
  const [repository] = await db
    .insert(repositories)
    .values({ companyId, projectId, name: "app", barePath: "/data/repos/proof.git" })
    .returning();
  repositoryId = repository!.id;

  nativeConnection = await NativeConnection.connect({ address: temporal.address });
  clientConnection = await Connection.connect({ address: temporal.address });
  client = new Client({ connection: clientConnection, namespace: "acos" });
  memoryWorker = await Worker.create({
    connection: nativeConnection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.memory,
    workflowsPath: memoryWorkflowsPath,
    activities: createMemoryActivities({ guardedDb, scripted: true, scriptedDim: 768 }),
  });
  memoryWorkerRun = memoryWorker.run();

  memoryTrigger = await startMemoryTrigger({
    nats: nc,
    thresholdFor: async () => 10_000, // N-anlamlı-olay şeridini bu senaryonun dışında tut
    start: async ({ companyId: cid, taskId: tid, agentId: aid, sourceEventIds, trigger, triggerRef }) => {
      await client.workflow
        .start("memoryConsolidationWorkflow", {
          taskQueue: TASK_QUEUES.memory,
          workflowId: `memory-consolidation-${cid}-${triggerRef}`,
          args: [{ companyId: cid, taskId: tid, agentId: aid, sourceEventIds, trigger }],
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") throw err;
        });
    },
    onError: (err) => console.error("memory-trigger:", err),
  });

  // A4 köprüsü — main.ts ile aynı gövde
  dependencyBridge = await startDependencySignalBridge({
    nats: nc,
    signal: async (input) => {
      dependencySignals.push(input);
    },
    onError: (err) => console.error("dependency-bridge:", err),
  });

  // devre kesici consumer'ı — main.ts ile aynı gövde
  breakerConsumer = await startBreakerConsumer({
    nats: nc,
    signal: async (input) => {
      breakerDirectives.push(input);
    },
    resumedAgentIds: async () => [agentId.dev!, agentId.dev2!],
    onError: (err) => console.error("breaker-consumer:", err),
  });

  const gateway = new ToolGateway({
    db: guardedDb,
    dispatch: createSandboxDispatchPort({
      guardedDb,
      sandboxManagerUrl: sandboxUrl,
      internalApiToken: INTERNAL_TOKEN,
    }),
  });
  const invokeTool = (req: {
    companyId: string;
    agentId: string;
    taskId: string;
    toolName: string;
    input: unknown;
    idempotencyKey: string;
    agentSessionId?: string | undefined;
  }) =>
    gateway.invoke(companyContext(req.companyId), {
      agentId: req.agentId,
      taskId: req.taskId,
      toolName: req.toolName,
      input: req.input,
      idempotencyKey: req.idempotencyKey,
      ...(req.agentSessionId !== undefined && { agentSessionId: req.agentSessionId }),
    });

  agentActivities = createAgentTaskActivities({
    guardedDb,
    router: new ModelRouter({ providers: new Map(), logCall: () => {} }),
    routingFor: async () => ({ bindings: [], profiles: [] }),
    invokeTool,
    startReviewWorkflow: async (input) => {
      pendingReviews.push(input);
    },
  });
  reviewActivities = createReviewActivities({
    guardedDb,
    invokeTool,
    startReviewWorkflow: async (input) => {
      pendingReviews.push(input);
    },
    startAgentWorkflow: async (input) => {
      pendingReworks.push({ agentId: input.agentId, taskId: input.taskId });
    },
  });
}, 900_000);

afterAll(async () => {
  await memoryTrigger?.stop().catch(() => {});
  await dependencyBridge?.stop().catch(() => {});
  await breakerConsumer?.stop().catch(() => {});
  memoryWorker?.shutdown();
  await memoryWorkerRun?.catch(() => {});
  await relay?.stop();
  await app?.close();
  sandboxStub?.close();
  await clientConnection?.close();
  await nativeConnection?.close();
  await nc?.close().catch(() => {});
  await pool?.end();
  await Promise.all([
    pgContainer?.stop(),
    natsHandle?.container.stop(),
    temporal?.container.stop(),
  ]);
});

describe("A7 — tek kanıt koşusu", () => {
  it(
    "hedef → decompose → teslimat → roll-up → hafıza; boyunca maliyet, devre kesici ve sweep",
    async () => {
      const tasksService = new TasksService(guardedDb);
      const state = new TaskStateService(guardedDb);
      const costs = new CostService(guardedDb);

      // /ws önce bağlanır: memory.created CANLI yayında yakalanmalı
      const probe = new WsProbe({ cookie: `acos_session=${sessionCookie}` });
      await probe.expectFrame((f) => (f as { op?: string }).op === "hello", 20_000);
      probe.send({ op: "subscribe", topics: [`events:${companyId}`] });
      await probe.expectFrame((f) => (f as { op?: string }).op === "sub_ok", 20_000);

      // ---- FAZ 1: Founder hedefi verir, CEO decompose eder ----
      const goal = await tasksService.create(
        ctx,
        { kind: "goal", title: "CSV dışa aktarmayı yayına al", objective: "x", projectId },
        { kind: "founder" },
      );
      const initiative = await tasksService.create(
        ctx,
        { kind: "initiative", parentId: goal.id, title: "Export altyapısı", objective: "x" },
        { kind: "agent", agentId: agentId.ceo! },
      );
      const epic = await tasksService.create(
        ctx,
        { kind: "epic", parentId: initiative.id, title: "Export epiği", objective: "x" },
        { kind: "agent", agentId: agentId.ceo! },
      );
      const schemaTask = await tasksService.create(
        ctx,
        {
          kind: "task",
          parentId: epic.id,
          title: "Şema hazırlığı",
          objective: "x",
          context: { taskFixture: "csv-implementation" },
        },
        { kind: "agent", agentId: agentId.manager! },
      );
      const apiTask = await tasksService.create(
        ctx,
        {
          kind: "task",
          parentId: epic.id,
          title: "Export ucu",
          objective: "x",
          context: { taskFixture: "csv-implementation" },
        },
        { kind: "agent", agentId: agentId.manager! },
      );
      // API ucu şemayı bekler — DAG kenarı (07 §3)
      await tasksService.addDependency(ctx, apiTask.id, schemaTask.id);

      for (const [task, owner] of [
        [schemaTask, agentId.dev!],
        [apiTask, agentId.dev2!],
      ] as const) {
        await state.transition(ctx, task.id, "BACKLOG", { kind: "founder" });
        await state.transition(ctx, task.id, "PLANNED", { kind: "founder" });
        await state.assign(ctx, task.id, { agentId: owner }, { kind: "founder" });
        await db.insert(workspaces).values({
          companyId,
          projectId,
          taskId: task.id,
          repositoryId,
          agentId: owner,
          isolationLevel: "coding",
          image: "acos/workspace-node",
          branch: `task/${task.number}-x`,
          volumePath: `ws-${task.number}-proof`,
          status: "in_use",
        });
      }

      // API ucunun sahibi çalışıyor ve şemayı bekliyor: canlı oturum satırı
      // A4 köprüsünün sinyali hangi workflow'a göndereceğini buradan bulur
      const apiWorkflowId = `agent-task.${apiTask.id}.${agentId.dev2}`;
      await db.insert(agentSessions).values({
        companyId,
        agentId: agentId.dev2!,
        taskId: apiTask.id,
        workflowId: apiWorkflowId,
        runId: uuidv7(),
        status: "waiting",
      });

      // ---- FAZ 2: şema görevi teslim edilir (gerçek artefakt + merge) ----
      // her adımın maliyeti deftere yazılır (26 §2)
      await costs.recordCost(ctx, {
        kind: "llm",
        ref: { llm_call_id: uuidv7() },
        agentId: agentId.dev!,
        taskId: schemaTask.id,
        amountCents: 20,
        quantity: 1,
      });
      await deliver(schemaTask.id, agentId.dev!);
      expect(await statusOf(schemaTask.id), "şema görevi teslim edilmedi").toBe("DONE");
      // gerçek inceleme zinciri koştu: bağımsız incelemeci + QA + merge commit
      const schemaReviews = await db
        .select()
        .from(reviews)
        .where(eq(reviews.taskId, schemaTask.id));
      expect(schemaReviews.find((r) => r.kind === "code")?.reviewerAgentId).toBe(agentId.manager);
      expect(schemaReviews.find((r) => r.kind === "code")?.mergedCommit).toBe(MERGE_COMMIT);
      expect(schemaReviews.find((r) => r.kind === "qa")?.status).toBe("approved");

      // ---- KANIT 2a: A4 — bağımlılık çözüldü sinyali bekleyen göreve ulaştı ----
      const signal = await pollUntil(
        async () => dependencySignals.find((s) => s.taskId === apiTask.id) ?? null,
        "dependencyResolved sinyali",
      );
      expect(signal.dependsOnTaskId).toBe(schemaTask.id);
      expect(signal.result).toBe("DONE");

      // ---- FAZ 3: API görevi teslim edilir ----
      await costs.recordCost(ctx, {
        kind: "llm",
        ref: { llm_call_id: uuidv7() },
        agentId: agentId.dev2!,
        taskId: apiTask.id,
        amountCents: 25,
        quantity: 1,
      });
      await deliver(apiTask.id, agentId.dev2!);
      expect(await statusOf(apiTask.id), "API görevi teslim edilmedi").toBe("DONE");

      // ---- KANIT 2b: A5 — epik kapanınca konteynerler kendiliğinden kapanır ----
      // epik bir konteyner DEĞİL: kendi makinesini yürür
      expect(await statusOf(initiative.id)).not.toBe("DONE");
      await state.transition(ctx, epic.id, "BACKLOG", { kind: "founder" });
      await state.transition(ctx, epic.id, "PLANNED", { kind: "founder" });
      // epiğin sahibi mühendis: incelemeciyi müdür yapabilsin (INV-14 —
      // müdür kendi işini inceleyemez, tek uygun kod incelemecisi odur)
      await state.assign(ctx, epic.id, { agentId: agentId.dev! }, { kind: "founder" });
      await db.insert(workspaces).values({
        companyId,
        projectId,
        taskId: epic.id,
        repositoryId,
        agentId: agentId.dev!,
        isolationLevel: "coding",
        image: "acos/workspace-node",
        branch: `task/${epic.number}-epic`,
        volumePath: `ws-${epic.number}-proof`,
        status: "in_use",
      });
      await deliver(epic.id, agentId.dev!);
      expect(await statusOf(epic.id)).toBe("DONE");

      // …ve girişim + hedef ROLL-UP ile kapandı (elle hiçbir geçiş yok)
      expect(await statusOf(initiative.id), "girişim roll-up ile kapanmadı").toBe("DONE");
      expect(await statusOf(goal.id), "hedef roll-up ile kapanmadı").toBe("DONE");

      const goalCompleted = await db
        .select()
        .from(events)
        .where(
          and(
            eq(events.companyId, companyId),
            eq(events.type, "task.completed"),
            eq(events.taskId, goal.id),
          ),
        );
      expect(goalCompleted, "hedef için task.completed düşmedi").toHaveLength(1);

      // ---- KANIT 1: maliyet defteri + görev harcaması ----
      const ledger = await db
        .select()
        .from(costEntries)
        .where(eq(costEntries.companyId, companyId));
      expect(ledger.length).toBeGreaterThanOrEqual(2);
      const [schemaRow] = await db.select().from(tasks).where(eq(tasks.id, schemaTask.id));
      expect(schemaRow!.spentCents).toBeGreaterThanOrEqual(20);

      // ---- KANIT 3: hafıza zinciri — elle hiçbir workflow başlatılmadı ----
      const memoryRows = await pollUntil(
        async () => {
          const rows = await db.select().from(memories).where(eq(memories.companyId, companyId));
          return rows.length >= 2 ? rows : null;
        },
        "task.completed'dan doğan hafıza satırları",
      );
      expect(memoryRows.length).toBeGreaterThanOrEqual(2);
      // deterministik workflow id (12 §5) — tetikleyici gerçekten bu run'ı açtı
      const handle = client.workflow.getHandle(
        `memory-consolidation-${companyId}-task-${schemaTask.id}`,
      );
      await pollUntil(
        async () => ((await handle.describe()).status.name === "COMPLETED" ? true : null),
        "konsolidasyon workflow'unun tamamlanması",
      );

      // …ve panel bunu CANLI gördü
      await probe.expectFrame(
        () => wsEventTypes(probe).includes("memory.created"),
        60_000,
      );
      expect(wsEventTypes(probe)).toContain("task.completed");

      // ---- KANIT 1 (devamı): devre kesici zinciri ----
      const budget = await costs.setBudget(ctx, {
        scopeKind: "company",
        scopeRef: null,
        period: "daily",
        limitCents: 100,
        kind: "hard",
      });
      await costs.recordCost(ctx, {
        kind: "llm",
        ref: { llm_call_id: uuidv7() },
        agentId: agentId.dev!,
        taskId: apiTask.id,
        amountCents: 500, // eşiği tek kalemde aşar
        quantity: 1,
      });

      const pause = await pollUntil(
        async () => breakerDirectives.find((d) => d.directive === "pause") ?? null,
        "devre kesici pause direktifi",
      );
      // kritik olmayanlar duraklatıldı, CEO (executive) ayakta kaldı
      expect(pause.agentIds).toContain(agentId.dev!);
      expect(pause.agentIds).not.toContain(agentId.ceo!);
      const [pausedDev] = await db.select().from(agents).where(eq(agents.id, agentId.dev!));
      expect(pausedDev!.status).toBe("paused");
      const [liveCeo] = await db.select().from(agents).where(eq(agents.id, agentId.ceo!));
      expect(liveCeo!.status).toBe("active");

      // bütçe yükseltilince otomatik devam
      await costs.restoreBudget(ctx, budget.id, 100_000);
      await pollUntil(
        async () => breakerDirectives.find((d) => d.directive === "resume") ?? null,
        "devre kesici resume direktifi",
      );
      const [resumedDev] = await db.select().from(agents).where(eq(agents.id, agentId.dev!));
      expect(resumedDev!.status).toBe("active");
      const [restored] = await db.select().from(budgets).where(eq(budgets.id, budget.id));
      expect(restored!.limitCents).toBe(100_000);

      // ---- KANIT 2c: A6 — park edilmiş görevi sweep geri alır ----
      const parked = await tasksService.create(
        ctx,
        { kind: "task", title: "Yanıt bekleyen iş", objective: "x", projectId },
        { kind: "founder" },
      );
      await state.transition(ctx, parked.id, "BACKLOG", { kind: "founder" });
      await state.transition(ctx, parked.id, "PLANNED", { kind: "founder" });
      await state.assign(ctx, parked.id, { agentId: agentId.dev! }, { kind: "founder" });
      await state.transition(ctx, parked.id, "IN_PROGRESS", { kind: "agent", agentId: agentId.dev! });
      await state.transition(ctx, parked.id, "WAITING", { kind: "agent", agentId: agentId.dev! });

      const sweep = await sweepStuckTasks(db, guardedDb, {
        now: new Date(Date.now() + 3 * 60 * 60 * 1000),
      });
      const stuck = sweep.findings.find((f) => f.taskId === parked.id);
      expect(stuck, "sweep park edilmiş görevi bulamadı").toBeDefined();
      expect(stuck!.kind).toBe("waiting_past_sla");
      expect(stuck!.managerAgentId).toBe(agentId.manager);
      expect(stuck!.needsWorkflowRestart).toBe(true); // canlı oturumu yok
      expect(await statusOf(parked.id)).toBe("BLOCKED");

      probe.close();
    },
    900_000,
  );
});
