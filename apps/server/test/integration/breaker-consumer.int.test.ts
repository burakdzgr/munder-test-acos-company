// 26 §5 madde 3 — devre kesicinin sinyal yarısı.
//
// A4'ün canlı kanıtı şunu ortaya çıkardı: kesici ajan satırlarını `paused`
// yapıyordu ama KOŞAN agentTaskWorkflow o satırı okumuyor. Doküman
// "sessions signalled managerDirective(pause)" diyor; o tel yoktu, yani
// kesici tetiklendikten sonra döngü bir sonraki adımını yine başlatıyordu.
//
// Test zincirin gerçek halkalarını kullanıyor: gerçek Postgres, gerçek
// outbox → gerçek NATS JetStream → gerçek `cost-aggregator` durable'ı →
// consumer. Sahte olan tek şey Temporal sinyal transport'u (hangi workflow
// id'ye hangi direktifin gittiğini yakalayan bir casus) — burada kanıtlanan
// şey sinyalin DOĞRU OTURUMA ulaşması, Temporal'ın sinyal taşıyabildiği değil
// (onu guards.int.test.ts zaten kapsıyor).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { connect, type NatsConnection } from "nats";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  CostService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
} from "@acos/db";
import {
  agentSessions,
  agents,
  companies,
  orgUnits,
  positions,
  tasks,
  users,
} from "@acos/db/schema";
import { OutboxRelay } from "../../src/modules/events/relay.js";
import { provisionJetStream } from "../../src/modules/events/jetstream.js";
import {
  startBreakerConsumer,
  type BreakerConsumerHandle,
  type BreakerDirectiveInput,
} from "../../src/modules/costs/breaker-consumer.js";
import { startNats, startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let pgContainer: StartedPostgreSqlContainer;
let natsHandle: Awaited<ReturnType<typeof startNats>>;
let pool: Pool;
let db: Db;
let nc: NatsConnection;
let relay: OutboxRelay;
let consumer: BreakerConsumerHandle;
let ctx: CompanyContext;
let companyId = "";
let SPENDER = "";
let CEO = "";
let spenderTaskId = "";

/** Consumer'ın gönderdiği direktifler + ulaştığı workflow id'leri. */
const directives: BreakerDirectiveInput[] = [];
const signalled: Array<{ workflowId: string; directive: string }> = [];

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("koşul zaman aşımına uğradı");
}

beforeAll(async () => {
  [pgContainer, natsHandle] = await Promise.all([startPostgres(), startNats()]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {});
  db = createDb(pool);
  nc = await connect({ servers: natsHandle.url });
  // stream + T21 durable'ları (cost-aggregator dahil) — consumer onu tüketiyor
  await provisionJetStream(nc);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@breaker.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "BreakerCo", slug: "breakerco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  // 26 §5: executive/lead track kritiktir — kesici onlara dokunmaz.
  const [devPos] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  const [execPos] = await db
    .insert(positions)
    .values({ companyId, title: "CEO", seniorityTrack: ["executive"], defaultRole: "manager" })
    .returning();
  const mkAgent = async (n: number, name: string, positionId: string) => {
    const [row] = await db
      .insert(agents)
      .values({
        companyId,
        employeeNumber: n,
        name,
        status: "active",
        positionId,
        orgUnitId: unit!.id,
        seniority: "mid",
        autonomyLevel: 2,
        persona: "x",
      })
      .returning();
    return row!.id;
  };
  SPENDER = await mkAgent(1, "Serkan Spender", devPos!.id);
  CEO = await mkAgent(2, "Ceyda CEO", execPos!.id);

  const [task] = await db
    .insert(tasks)
    .values({
      companyId,
      number: 1,
      kind: "task",
      title: "Pahalı iş",
      objective: "x",
      status: "IN_PROGRESS",
      ownerAgentId: SPENDER,
    })
    .returning();
  spenderTaskId = task!.id;

  // Canlı oturum: sinyalin hedefleyeceği workflow bu satırdan türetiliyor.
  await db.insert(agentSessions).values({
    companyId,
    agentId: SPENDER,
    taskId: spenderTaskId,
    workflowId: `agent-task.${spenderTaskId}.${SPENDER}`,
    runId: "01a0052e-0000-7000-8000-000000000001",
    status: "running",
  });

  relay = new OutboxRelay({
    connectionString: pgContainer.getConnectionUri(),
    nats: nc,
    leaderRetryMs: 300,
    pollMs: 300,
    onError: () => {},
  });
  await relay.start();
  await waitFor(() => relay.isLeader);

  const guardedDb = createGuardedDb(pool);
  consumer = await startBreakerConsumer({
    nats: nc,
    signal: async (input) => {
      directives.push(input);
      const rows = await guardedDb
        .select({ workflowId: agentSessions.workflowId, agentId: agentSessions.agentId })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.companyId, input.companyId),
            inArray(agentSessions.agentId, input.agentIds),
            sql`${agentSessions.status} IN ('starting','running','waiting')`,
          ),
        );
      for (const row of rows) {
        if (!row.workflowId) continue;
        signalled.push({ workflowId: row.workflowId, directive: input.directive });
      }
    },
    resumedAgentIds: async () => [SPENDER],
    onError: () => {},
  });
}, 600_000);

afterAll(async () => {
  await consumer?.stop().catch(() => {});
  await relay?.stop();
  await nc?.close().catch(() => {});
  await pool?.end();
  await natsHandle?.container.stop();
  await pgContainer?.stop();
});

describe("devre kesici → managerDirective sinyali (26 §5)", { timeout: 60_000 }, () => {
  it("şirket hard bütçesi delinince duraklatılan ajanın CANLI oturumuna pause gider", async () => {
    const costs = new CostService(createGuardedDb(pool));
    const budget = await costs.setBudget(ctx, {
      scopeKind: "company",
      scopeRef: null,
      period: "daily",
      limitCents: 100,
      kind: "hard",
    });
    expect(budget.limitCents).toBe(100);

    // eşiği tek kalemde aş → budget.exceeded{scope:company} + tripBreaker
    await costs.recordCost(ctx, {
      kind: "llm",
      ref: { llm_call_id: "019ffe3e-f02d-71ab-bfdd-31c395cf2893" },
      agentId: SPENDER,
      taskId: spenderTaskId,
      amountCents: 150,
      quantity: 1,
    });

    await waitFor(() => directives.some((d) => d.directive === "pause"));
    const pause = directives.find((d) => d.directive === "pause")!;
    // kesicinin duraklattığı küme: SPENDER evet, CEO (executive) hayır
    expect(pause.agentIds).toContain(SPENDER);
    expect(pause.agentIds).not.toContain(CEO);

    // ve sinyal DOĞRU workflow id'sine gitti — bu wiring'in kendisi
    expect(signalled).toContainEqual({
      workflowId: `agent-task.${spenderTaskId}.${SPENDER}`,
      directive: "pause",
    });

    // veritabanı yarısı da olmuş olmalı (zaten vardı, birlikte tutuyoruz)
    const [row] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, SPENDER)));
    expect(row!.status).toBe("paused");
  });

  it("bütçe yükseltilince aynı oturuma resume gider", async () => {
    const costs = new CostService(createGuardedDb(pool));
    // tek şirket-günlük bütçe var; id'yi doğrudan okuyoruz
    const found = await db.execute(
      sql`SELECT id FROM budgets WHERE company_id = ${companyId} AND scope_kind = 'company' LIMIT 1`,
    );
    const budgetId = (found.rows as Array<{ id: string }>)[0]!.id;
    await costs.restoreBudget(ctx, budgetId, 100_000);

    await waitFor(() => signalled.some((s) => s.directive === "resume"));
    expect(signalled).toContainEqual({
      workflowId: `agent-task.${spenderTaskId}.${SPENDER}`,
      directive: "resume",
    });
  });
});
