// M2 kanıtı (AGENT-BRIEF §5, brief satırı 199) — DOĞAL bir DONE'dan Observatory
// soketine kadar tek koşuda giden zincir:
//
//   complete_task → REVIEW → (bağımsız incelemeci) CHANGES_REQUESTED → rework
//   → re-review → QA → lead git.merge → DONE → `task.completed` → outbox relay
//   → JetStream `memory-trigger` durable → memoryConsolidationWorkflow
//   (Temporal, gerçek) → `memories` satırı + `memory.created` → relay → /ws
//
// NEDEN AYRI BİR TEST: `review-flow.int.test.ts` zaten DONE'a kadar olan yarıyı
// (Docker + gerçek sandbox-manager ile) kapsıyor — brief §6.4 "zaten geçen
// testi tekrar yazma" diyor. Kapsanmayan yarı DONE'DAN SONRASIYDI: hiçbir test
// `task.completed`'ın gerçekten bir konsolidasyon başlattığını, anının
// yazıldığını ve olayın /ws'e düştüğünü uçtan uca görmemişti
// (`memory-trigger.int.test.ts` sahte bir `start` kullanıyor,
// `memory-pipeline.int.test.ts` workflow'u ELLE başlatıp görevi doğrudan
// `status: "DONE"` olarak INSERT ediyor). Bu test tam o dikişi çakıyor.
//
// AYRICA ÇAKILAN REGRESYON (2026-08-15 canlı bulgusu): `pickReviewer`
// incelemeci olarak bir MANAGER seçebiliyor ama `TaskStateService.actorClasses`
// `reviewer` sınıfını yalnız `task_assignments`'tan ya da pozisyonun
// `default_role`'ünden (`reviewer`|`lead`) türetiyor — yani manager kendi
// verdiğini uygulayamıyor ve REVIEW→CHANGES_REQUESTED "manager may not perform"
// ile patlıyordu. Seed burada BİLEREK tek uygun kod incelemecisini `manager`
// yapıyor: `reviews.requestReview`'ün `task_assignments` yazımı geri alınırsa
// bu test kırmızıya döner.
//
// SINIR: sandbox-manager'ın internal HTTP yüzeyi burada sahte (git plumbing'i
// gerçek Docker ile `review-flow.int.test.ts` kanıtlıyor). Merge'ün host
// tarafındaki her adımı — `mergeEligibility` kapısı, workspace `merged`
// geçişi, `recordMerge`, `TaskStateService` ile QA→DONE — GERÇEK kodla koşuyor.
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { connect, type NatsConnection } from "nats";
import WebSocket from "ws";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { uuidv7 } from "@acos/domain";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  TasksService,
  TaskStateService,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agents,
  events,
  memories,
  memoryEvidence,
  orgEdges,
  orgUnits,
  positions,
  projects,
  repositories,
  reviews,
  taskAssignments,
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
import { ToolGateway } from "../../src/modules/tools/gateway.js";
import { createSandboxDispatchPort } from "../../src/modules/tools/dispatch.js";
// test-only cross-package relative importları (tsc test/'i dışlar; runtime
// bağımlılık matrisini import'lar değil paket grafiği yönetir) —
// `review-flow.int.test.ts` ile aynı kalıp
import { createAgentTaskActivities } from "../../../../workers/agent-worker/src/activities/agent-task.js";
import { createReviewActivities } from "../../../../workers/agent-worker/src/review/activities.js";
import { createMemoryActivities } from "../../../../workers/agent-worker/src/memory/activities.js";
import { startNats, startPostgres, startTemporal, type StartedPostgreSqlContainer } from "./helpers";

const require = createRequire(import.meta.url);
const memoryWorkflowsPath = require.resolve(
  "../../../../workers/agent-worker/src/workflows/memory/index.ts",
);

const MASTER_KEY = Buffer.alloc(32, 23).toString("base64");
const INTERNAL_TOKEN = "memory-chain-token-0123456789";
const MERGE_COMMIT = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
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
let taskId = "";
const agentId: Record<string, string> = {};

/** reviewWorkflow / agentTaskWorkflow "start" çağrılarının kuyruğu. */
interface PendingReview {
  companyId: string;
  reviewId: string;
  taskId: string;
  reviewerAgentId: string;
  authorAgentId: string;
}
const pendingReviews: PendingReview[] = [];
const pendingReworks: { agentId: string; taskId: string }[] = [];

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
    if (Date.now() > deadline) {
      const [taskRow] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      const reviewRows = await db.select().from(reviews).where(eq(reviews.companyId, companyId));
      const memoryRows = await db.select().from(memories).where(eq(memories.companyId, companyId));
      console.error(
        `DIAG task=${taskRow?.status} reviews=${JSON.stringify(
          reviewRows.map((r) => ({ kind: r.kind, status: r.status })),
        )} memories=${memoryRows.length}`,
      );
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** /ws test istemcisi (ws-gateway.int.test.ts ile aynı minimal şekil). */
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

/** Şirket olayı taşıyan /ws frame'lerindeki tüm event tiplerini düzleştirir. */
function wsEventTypes(probe: WsProbe): string[] {
  return probe.frames
    .filter((f): f is { events: Array<{ type: string }> } =>
      Array.isArray((f as { events?: unknown }).events),
    )
    .flatMap((f) => f.events.map((e) => e.type));
}

/**
 * sandbox-manager'ın internal API'sinin sahtesi. Sadece HTTP sınırı sahte:
 * dispatch, workspace ve merge muhasebesinin tamamı gerçek kodda kalıyor.
 */
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
      if (url === "/internal/v1/repos") return reply({ barePath: "/data/repos/x.git", headCommit: "0".repeat(40), created: true });
      if (url === "/internal/v1/worktrees") return reply({ volumeName: "ws-1-x", baseCommit: "0".repeat(40), created: true });
      if (url === "/internal/v1/workspaces") return reply({ workspaceId: "stub", containerId: "stub", status: "ready" });
      if (url.endsWith("/exec")) return reply({ exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false });
      if (url === "/internal/v1/worktrees/push") return reply({ pushed: true, remoteHead: MERGE_COMMIT });
      // 15 §3.6: merge sunucu tarafındadır — burada yalnız git çağrısı sahte
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

/** Sahibin `complete_task`'ı — gerçek agent activity, LLM'siz. */
async function ownerSubmitsForReview(ownerAgentId: string): Promise<Record<string, unknown>> {
  return agentActivities.executeActionActivity({
    companyId,
    agentId: ownerAgentId,
    taskId,
    sessionId: uuidv7(),
    stepId: uuidv7(),
    action: {
      type: "complete_task",
      result: {
        summary: "CSV dışa aktarma uçtan uca çalışıyor.",
        criteria: [{ criterion: "CSV üretiliyor", met: true, evidence: "src/export.ts" }],
        artifactIds: [],
        cost: { tokensIn: 0, tokensOut: 0, cents: 0 },
      },
    },
  });
}

/** reviewWorkflow'un gövdesi birebir (review.workflow.ts §27-46). */
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

/** Temporal'ın "start" semantiği: kuyruğa düşen her run sırayla koşar. */
async function drainWorkflowStarts(): Promise<void> {
  for (let guard = 0; guard < 12; guard += 1) {
    const review = pendingReviews.shift();
    if (review) {
      await runReviewWorkflow(review);
      continue;
    }
    const rework = pendingReworks.shift();
    if (rework) {
      await ownerSubmitsForReview(rework.agentId);
      continue;
    }
    return;
  }
  throw new Error("inceleme/rework döngüsü kapanmadı — sonsuz döngü koruması");
}

beforeAll(async () => {
  [pgContainer, natsHandle, temporal] = await Promise.all([
    startPostgres(),
    startNats(),
    startTemporal(),
  ]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // teardown yarışı: konteyner dururken idle client FATAL
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  nc = await connect({ servers: natsHandle.url });
  await provisionJetStream(nc); // stream + T21 durable'lar (memory-trigger dahil)

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
  app.realtime!.attachNats(nc); // /ws canlı fanout (T23)
  relay = new OutboxRelay({ connectionString: pgContainer.getConnectionUri(), nats: nc });
  await relay.start();

  // ---- kurucu + şirket: /ws yetkilendirmesi üyeliğe bakar, bu yüzden REST ----
  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { email: "founder@m2.local", password: "correct-horse-battery", displayName: "F" },
  });
  for (const c of setup.cookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }
  const companyResponse = await app.inject({
    method: "POST",
    url: "/api/v1/companies",
    headers: { cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`, "x-csrf-token": csrfToken },
    payload: { name: "MemChainCo", slug: "memchainco", currency: "USD" },
  });
  expect(companyResponse.statusCode, companyResponse.body).toBeLessThan(300);
  companyId = companyResponse.json().id;
  ctx = companyContext(companyId);
  const [founder] = await db.select().from(users).where(eq(users.email, "founder@m2.local"));

  // ---- org: yazar (member) + tek uygun kod incelemecisi (MANAGER) + QA ----
  // Kod incelemecisinin `default_role`'ü BİLEREK "manager": `actorClasses`
  // ondan `reviewer` sınıfı TÜRETMEZ — sınıf yalnızca `requestReview`'ün
  // yazdığı `task_assignments` satırından gelir (2026-08-15 canlı bulgusu).
  const [eng] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Engineering", slug: "eng" })
    .returning();
  const [backend] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend", parentId: eng!.id })
    .returning();
  const positionId: Record<string, string> = {};
  for (const [title, role] of [
    ["Backend Engineer", "member"],
    ["Engineering Manager", "manager"],
    ["QA Engineer", "qa"],
  ] as const) {
    const [position] = await db
      .insert(positions)
      .values({ companyId, title, seniorityTrack: ["mid"], defaultRole: role })
      .returning();
    positionId[title] = position!.id;
  }
  const hire = async (name: string, employeeNumber: number, title: string, unitId: string, autonomy: number) =>
    (
      await db
        .insert(agents)
        .values({
          companyId,
          employeeNumber,
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
  agentId.dev = await hire("Alex Demir", 1, "Backend Engineer", backend!.id, 2);
  agentId.manager = await hire("Kerem Yıldız", 2, "Engineering Manager", backend!.id, 4);
  agentId.qa = await hire("Baran Çelik", 3, "QA Engineer", eng!.id, 3);
  await db.insert(orgEdges).values([
    { companyId, fromAgentId: agentId.dev!, kind: "reports_to", toAgentId: agentId.manager! },
    { companyId, fromAgentId: agentId.manager!, kind: "manages", toAgentId: agentId.dev! },
    { companyId, fromAgentId: agentId.dev!, kind: "member_of", toUnitId: backend!.id },
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

  // ---- proje + repo + görev + canlı workspace satırı ----
  const [project] = await db
    .insert(projects)
    .values({
      companyId,
      slug: "memchainproj",
      name: "Memory Chain Project",
      objectiveMd: "csv export",
      createdByUserId: founder!.id,
    })
    .returning();
  projectId = project!.id;
  const [repository] = await db
    .insert(repositories)
    .values({ companyId, projectId, name: "app", barePath: "/data/repos/memchain.git" })
    .returning();

  const tasksService = new TasksService(guardedDb);
  const taskState = new TaskStateService(guardedDb);
  const task = await tasksService.create(
    ctx,
    {
      kind: "task",
      title: "CSV dışa aktarma",
      objective: "CSV export works.",
      projectId,
      // 32 §6 canned konsolidasyon fixture'ı: proje-kapsamlı bir `failure` +
      // ajan-kapsamlı bir `procedural` üretir. M3'ün uyardığı gibi ANI İÇERİĞİ
      // scripted modda sentetiktir — bu test içeriğe değil zincire bakar.
      context: { taskFixture: "csv-implementation" },
    },
    { kind: "founder" },
  );
  taskId = task.id;
  await taskState.transition(ctx, taskId, "BACKLOG", { kind: "founder" });
  await taskState.transition(ctx, taskId, "PLANNED", { kind: "founder" });
  await taskState.assign(ctx, taskId, { agentId: agentId.dev! }, { kind: "founder" });
  await db.insert(workspaces).values({
    companyId,
    projectId,
    taskId,
    repositoryId: repository!.id,
    agentId: agentId.dev!,
    isolationLevel: "coding",
    image: "acos/workspace-node",
    branch: `task/${task.number}-csv-export`,
    volumePath: `ws-${task.number}-memchain`,
    status: "in_use",
  });

  // ---- Temporal: GERÇEK memoryConsolidationWorkflow, `memory` kuyruğunda ----
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

  // ---- memory-trigger tüketicisi: main.ts:183-211 ile AYNI `start` gövdesi ----
  memoryTrigger = await startMemoryTrigger({
    nats: nc,
    // 12 §5.0 satır 2 sayacını bu senaryonun dışında tutmak için eşik yüksek:
    // testin iddiası "task.completed TEK BİR konsolidasyon başlattı".
    thresholdFor: async () => 10_000,
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

  // ---- araç geçidi + ajan/inceleme activity'leri ----
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
    // bu senaryoda hiçbir model çağrısı yok: `executeActionActivity` doğrudan
    // sürülüyor, router yalnızca fabrika imzasını doyurur
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
}, 600_000);

afterAll(async () => {
  await memoryTrigger?.stop().catch(() => {});
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

describe("M2 — doğal DONE → hafıza zinciri (12 §5.0 satır 1)", () => {
  it(
    "complete_task → REVIEW → incelemeci → QA → merge → DONE → task.completed → konsolidasyon → memory.created → /ws",
    async () => {
      // --- /ws önce bağlanır: memory.created CANLI yayında yakalanmalı ---
      const probe = new WsProbe({ cookie: `acos_session=${sessionCookie}` });
      await probe.expectFrame((f) => (f as { op?: string }).op === "hello", 20_000);
      probe.send({ op: "subscribe", topics: [`events:${companyId}`] });
      await probe.expectFrame((f) => (f as { op?: string }).op === "sub_ok", 20_000);

      // --- halka 1: sahibin complete_task'ı görevi REVIEW'a taşır ---
      const submitted = await ownerSubmitsForReview(agentId.dev!);
      expect(submitted).toMatchObject({ ok: true, completed: false, reviewRequested: true });
      const [afterSubmit] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(afterSubmit!.status).toBe("REVIEW");

      // `requestReview` incelemeci olarak MANAGER'ı seçti ve onu görev
      // atamasına da yazdı — `reviewer` aktör sınıfının TEK kaynağı bu satır
      const assignments = await db
        .select()
        .from(taskAssignments)
        .where(and(eq(taskAssignments.taskId, taskId), eq(taskAssignments.agentId, agentId.manager!)));
      expect(assignments.map((a) => a.role)).toContain("reviewer");

      // --- halka 2-4: inceleme → rework → re-review → QA → lead merge → DONE ---
      await drainWorkflowStarts();
      const [done] = await db.select().from(tasks).where(eq(tasks.id, taskId));
      expect(done!.status, "görev doğal yoldan DONE'a ulaşmadı").toBe("DONE");

      const reviewRows = await db.select().from(reviews).where(eq(reviews.taskId, taskId));
      const code = reviewRows.find((r) => r.kind === "code")!;
      const qa = reviewRows.find((r) => r.kind === "qa")!;
      expect(code.status).toBe("approved");
      expect(code.reviewerAgentId).toBe(agentId.manager); // INV-14: yazar değil
      expect(code.reviewerAgentId).not.toBe(code.authorAgentId);
      expect(code.mergedCommit).toBe(MERGE_COMMIT);
      expect(qa.status).toBe("approved");

      // durum geçişleri incelemecinin KENDİ kimliğiyle sürüldü (INV-13/INV-14)
      const allEvents = await db.select().from(events).where(eq(events.companyId, companyId));
      const statusLegs = allEvents
        .filter((e) => e.type === "task.status.changed" && e.taskId === taskId)
        .map((e) => e.payload as { from: string; to: string; byActor: { kind: string; id: string | null } });
      expect(statusLegs.find((l) => l.from === "REVIEW" && l.to === "CHANGES_REQUESTED")?.byActor.id).toBe(
        agentId.manager,
      );
      expect(statusLegs.find((l) => l.from === "REVIEW" && l.to === "QA")?.byActor.id).toBe(agentId.manager);
      expect(statusLegs.find((l) => l.from === "QA" && l.to === "DONE")?.byActor.kind).toBe("system");

      // merge workspace'i kapattı (T38 makinesi) ve `task.completed` düştü
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.taskId, taskId));
      expect(ws!.status).toBe("merged");
      const completed = allEvents.filter((e) => e.type === "task.completed" && e.taskId === taskId);
      expect(completed).toHaveLength(1);

      // --- halka 5-7: relay → JetStream → memory-trigger → konsolidasyon ---
      // ELLE HİÇBİR WORKFLOW BAŞLATILMIYOR: buradan sonrası tamamen olay güdümlü
      const memoryRows = await pollUntil(
        async () => {
          const rows = await db.select().from(memories).where(eq(memories.companyId, companyId));
          return rows.length >= 2 ? rows : null;
        },
        "task.completed'dan doğan hafıza satırları",
      );

      // deterministik workflow id (12 §5) — tetikleyici gerçekten bu run'ı açtı
      const handle = client.workflow.getHandle(`memory-consolidation-${companyId}-task-${taskId}`);
      // Hafıza satırları workflow'un SON adımından önce görünür (persist →
      // promotion değerlendirmesi → run raporu). Durumu beklemeden okumak
      // CI'da RUNNING yakalıyordu; yerelde daha hızlı bittiği için sessizdi.
      await pollUntil(
        async () => ((await handle.describe()).status.name === "COMPLETED" ? true : null),
        "konsolidasyon workflow'unun tamamlanması",
      );
      expect(await handle.result()).toMatchObject({ extracted: 2, persisted: 2 });

      // INV-15 kapsam izolasyonu: her satır bu şirkete ait ve kapsam referansı
      // ya bu proje ya da görevin sahibi
      for (const row of memoryRows) {
        expect(row.companyId).toBe(companyId);
        expect([projectId, agentId.dev]).toContain(row.scopeRef);
      }
      const projectMemory = memoryRows.find((r) => r.scope === "project")!;
      const agentMemory = memoryRows.find((r) => r.scope === "agent")!;
      expect(projectMemory.scopeRef).toBe(projectId);
      expect(agentMemory.scopeRef).toBe(agentId.dev);

      // pencere GERÇEKTEN bu koşunun olaylarından kuruldu (12 §5.7 kanıt yolu)
      const evidence = await db
        .select()
        .from(memoryEvidence)
        .where(eq(memoryEvidence.memoryId, projectMemory.id));
      expect(evidence.length).toBeGreaterThan(0);
      const taskEventIds = new Set(allEvents.filter((e) => e.taskId === taskId).map((e) => e.id));
      for (const item of evidence) {
        expect(item.kind).toBe("event");
        expect(taskEventIds.has(item.ref)).toBe(true);
      }

      // --- halka 8: memory.created olayı + /ws yayını ---
      const createdEvents = await db
        .select()
        .from(events)
        .where(and(eq(events.companyId, companyId), eq(events.type, "memory.created")));
      expect(createdEvents.length).toBeGreaterThanOrEqual(2);
      const createdMemoryIds = createdEvents.map((e) => (e.payload as { memoryId: string }).memoryId);
      expect(createdMemoryIds).toContain(projectMemory.id);

      await probe.expectFrame(
        (f) =>
          Array.isArray((f as { events?: Array<{ type: string }> }).events) &&
          (f as { events: Array<{ type: string }> }).events.some((e) => e.type === "memory.created"),
      );
      // aynı sokette görevin kapanışı da göründü — panel ikisini de canlı alır
      expect(wsEventTypes(probe)).toContain("task.completed");
      probe.close();
    },
    600_000,
  );
});
