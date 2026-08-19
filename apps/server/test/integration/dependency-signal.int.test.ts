// A4 — `dependencyResolved` köprüsü (07 §3, 09 §9, 10 §5).
//
// 07 §3: "When a predecessor reaches DONE, the state-machine service emits
// `task.dependency.resolved` and signals `dependencyResolved` into every
// waiting dependent workflow."
//
// Emit vardı, workflow handler'ı vardı, arada gönderen yoktu — repoda tek bir
// signal("dependencyResolved", …) çağrısı bile bulunmuyordu. Bu testin
// tuttuğu şey tam olarak o eksik tel: A DONE olduğunda B'nin workflow'una
// sinyal ULAŞIYOR mu.
//
// Zincirin gerçek halkaları: gerçek Postgres → TaskStateService (tek durum
// yazarı) → outbox → gerçek NATS JetStream `workflow-signals` durable'ı →
// köprü. Sahte olan tek şey Temporal sinyal transport'u; kanıtlanan şey
// sinyalin DOĞRU workflow'a, DOĞRU yükle gitmesi (Temporal'ın sinyal
// taşıyabildiğini guards.int.test.ts zaten kapsıyor).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { connect, type NatsConnection } from "nats";
import { and, eq, sql } from "drizzle-orm";
import {
  TasksService,
  TaskStateService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agentSessions,
  agents,
  companies,
  orgUnits,
  positions,
  taskAssignments,
  users,
} from "@acos/db/schema";
import { OutboxRelay } from "../../src/modules/events/relay.js";
import { provisionJetStream } from "../../src/modules/events/jetstream.js";
import {
  startDependencySignalBridge,
  type DependencyBridgeHandle,
  type DependencySignalInput,
} from "../../src/modules/tasks/dependency-signal.js";
import { startPostgres, startNats, type StartedPostgreSqlContainer } from "./helpers";

let pgContainer: StartedPostgreSqlContainer;
let natsHandle: Awaited<ReturnType<typeof startNats>>;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let nc: NatsConnection;
let relay: OutboxRelay;
let bridge: DependencyBridgeHandle;
let ctx: CompanyContext;
let companyId = "";
let OWNER = "";
let REVIEWER = "";

/** Köprünün ürettiği sinyaller + ulaştıkları workflow id'leri. */
const signalled: Array<{ workflowId: string; payload: DependencySignalInput }> = [];

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("koşul zaman aşımına uğradı");
}

beforeAll(async () => {
  [pgContainer, natsHandle] = await Promise.all([startPostgres(), startNats()]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  nc = await connect({ servers: natsHandle.url });
  await provisionJetStream(nc);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@dep.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "DepCo", slug: "depco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  const hire = async (employeeNumber: number, name: string) =>
    (
      await db
        .insert(agents)
        .values({
          companyId,
          employeeNumber,
          name,
          status: "active",
          positionId: position!.id,
          orgUnitId: unit!.id,
          seniority: "mid",
          autonomyLevel: 2,
          persona: "x",
        })
        .returning()
    )[0]!.id;
  OWNER = await hire(1, "Deniz Dev");
  REVIEWER = await hire(2, "Rana Reviewer");

  relay = new OutboxRelay({
    connectionString: pgContainer.getConnectionUri(),
    nats: nc,
    leaderRetryMs: 300,
    pollMs: 300,
    onError: () => {},
  });
  await relay.start();
  await waitFor(() => relay.isLeader);

  bridge = await startDependencySignalBridge({
    nats: nc,
    signal: async (input) => {
      const sessions = await guardedDb
        .select({ workflowId: agentSessions.workflowId, taskId: agentSessions.taskId })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.companyId, input.companyId),
            eq(agentSessions.taskId, input.taskId),
            sql`${agentSessions.status} IN ('starting','running','waiting')`,
          ),
        );
      for (const session of sessions) {
        if (session.workflowId) signalled.push({ workflowId: session.workflowId, payload: input });
      }
    },
    onError: () => {},
  });
}, 600_000);

afterAll(async () => {
  await bridge?.stop().catch(() => {});
  await relay?.stop();
  await nc?.close().catch(() => {});
  await pool?.end();
  await natsHandle?.container.stop();
  await pgContainer?.stop();
});

describe("dependencyResolved köprüsü (07 §3)", { timeout: 60_000 }, () => {
  it("öncül DONE olunca bekleyen bağımlının workflow'una sinyal ulaşır", async () => {
    const tasks = new TasksService(guardedDb);
    const state = new TaskStateService(guardedDb);
    const blocker = await tasks.create(
      ctx,
      { kind: "task", title: "Şemayı hazırla", objective: "x", ownerAgentId: OWNER },
      { kind: "founder" },
    );
    const dependent = await tasks.create(
      ctx,
      { kind: "task", title: "API'yi yaz", objective: "x", ownerAgentId: OWNER },
      { kind: "founder" },
    );
    await tasks.addDependency(ctx, dependent.id, blocker.id);

    // bağımlının canlı oturumu — sinyalin hedefi bu satırdan türüyor
    const workflowId = `agent-task.${dependent.id}.${OWNER}`;
    await db.insert(agentSessions).values({
      companyId,
      agentId: OWNER,
      taskId: dependent.id,
      workflowId,
      runId: "01a0052e-0000-7000-8000-000000000042",
      status: "waiting",
    });

    // öncülü kanonik 07 §5 yolundan DONE'a taşı (tek durum yazarından)
    for (const to of ["BACKLOG", "PLANNED"] as const) {
      await state.transition(ctx, blocker.id, to, { kind: "founder" });
    }
    await state.assign(ctx, blocker.id, { agentId: OWNER }, { kind: "founder" });
    // 07 §5 izin matrisi: işi sahibi yürütür, kaliteyi motor kapatır
    const owner = { kind: "agent", agentId: OWNER } as const;
    await state.transition(ctx, blocker.id, "IN_PROGRESS", owner);
    await state.transition(ctx, blocker.id, "REVIEW", owner);
    // REVIEW → QA yalnız reviewer sınıfından geçer (INV-14): bağımsız bir
    // incelemeci ata — atama satırı yetki matrisinin okuduğu kanonik yer
    await db.insert(taskAssignments).values({
      companyId,
      taskId: blocker.id,
      agentId: REVIEWER,
      role: "reviewer",
      reason: "test",
    });
    await state.transition(ctx, blocker.id, "QA", { kind: "agent", agentId: REVIEWER });
    await state.transition(ctx, blocker.id, "DONE", { kind: "system" });

    await waitFor(() => signalled.length > 0);
    expect(signalled[0]!.workflowId).toBe(workflowId);
    expect(signalled[0]!.payload.dependsOnTaskId).toBe(blocker.id);
    expect(signalled[0]!.payload.taskId).toBe(dependent.id);
    // olay `result: "done"` yazıyor, sinyal sözleşmesi büyük harf bekliyor
    expect(signalled[0]!.payload.result).toBe("DONE");
  });
});
