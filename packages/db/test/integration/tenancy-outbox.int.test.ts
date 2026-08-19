// T13 acceptance: tenancy negatives, gap-free seq under concurrent tx,
// outbox row committed atomically with the state change.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sql, eq } from "drizzle-orm";
import {
  AgentRepository,
  TaskRepository,
  CompanyRepository,
  appendEvents,
  withOutbox,
  beginIdempotent,
  completeIdempotent,
  companyContext,
  createDb,
  createGuardedDb,
  nextSequenceValue,
  runMigrations,
  TenancyViolationError,
  TENANT_TABLES,
  PLATFORM_TABLES,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "../../src/index.js";
import { users } from "../../src/schema/identity.js";
import { agents } from "../../src/schema/agents.js";
import { tasks } from "../../src/schema/tasks.js";
import { events } from "../../src/schema/events.js";
import { orgUnits, positions } from "../../src/schema/org.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

let container: StartedPostgreSqlContainer;
let pool: Pool;
let system: Db;
let guarded: GuardedDb;
let ctxA: CompanyContext;
let ctxB: CompanyContext;
let positionA: string;
let unitA: string;

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 10 });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  system = createDb(pool);
  guarded = createGuardedDb(pool);

  const [founder] = await system
    .insert(users)
    .values({ email: "founder@acme.local", passwordHash: "x", displayName: "Founder" })
    .returning();
  const companyRepo = new CompanyRepository(system);
  const a = await system.transaction((tx) =>
    companyRepo.insert(tx, { name: "Acme", slug: "acme", createdByUserId: founder!.id }),
  );
  const b = await system.transaction((tx) =>
    companyRepo.insert(tx, { name: "Globex", slug: "globex", createdByUserId: founder!.id }),
  );
  ctxA = companyContext(a.id);
  ctxB = companyContext(b.id);

  const [unit] = await system
    .insert(orgUnits)
    .values({ companyId: ctxA.companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  const [position] = await system
    .insert(positions)
    .values({
      companyId: ctxA.companyId,
      title: "Engineer",
      seniorityTrack: ["junior", "mid"],
      defaultRole: "member",
    })
    .returning();
  unitA = unit!.id;
  positionA = position!.id;
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("tenancy guard (S4)", () => {
  it("derives the tenant-table list from schema metadata (every non-platform table covered)", () => {
    // companies has no company_id column — it IS the tenant boundary.
    expect(PLATFORM_TABLES).toEqual([
      "companies",
      "model_providers",
      "personal_access_tokens",
      "rate_limits",
      "sessions",
      "tools",
      "users",
    ]);
    for (const table of ["tasks", "agents", "memories", "events", "approvals", "assets"]) {
      expect(TENANT_TABLES).toContain(table);
    }
  });

  const expectTenancyRejection = async (promise: Promise<unknown>) => {
    await promise.then(
      () => {
        throw new Error("expected TenancyViolationError, but query succeeded");
      },
      (err: unknown) => {
        const root = (err as { cause?: unknown }).cause ?? err;
        expect(root).toBeInstanceOf(TenancyViolationError);
      },
    );
  };

  it("REJECTS a tenant-table query lacking a company filter (raw SQL)", async () => {
    await expectTenancyRejection(guarded.execute(sql`SELECT id FROM tasks`));
    await expectTenancyRejection(guarded.execute(sql`DELETE FROM agents`));
  });

  it("REJECTS an unscoped query-builder select on a tenant table", async () => {
    await expectTenancyRejection(guarded.select().from(agents));
  });

  it("allows company-scoped tenant queries and platform-table queries", async () => {
    await expect(
      guarded.select().from(agents).where(eq(agents.companyId, ctxA.companyId)),
    ).resolves.toEqual([]);
    await expect(guarded.select({ id: users.id }).from(users)).resolves.toHaveLength(1);
  });
});

describe("repositories + two-company isolation (R2 basis)", () => {
  it("repository reads never leak across companies", async () => {
    const repoA = new AgentRepository(guarded, ctxA);
    await guarded.transaction(async (tx) => {
      const employeeNumber = await nextSequenceValue(tx, ctxA, "employee_number");
      await repoA.insert(tx, {
        employeeNumber,
        name: "Alex",
        positionId: positionA,
        orgUnitId: unitA,
        persona: "Backend engineer.",
      });
    });

    const repoB = new AgentRepository(guarded, ctxB);
    expect(await repoA.list()).toHaveLength(1);
    expect(await repoB.list()).toHaveLength(0);
  });
});

describe("gap-free per-company seq (10 §3)", () => {
  it("20 concurrent transactions produce seq 1..20 with no gaps or duplicates", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        guarded.transaction((tx) =>
          withOutbox(tx, ctxB, {
            type: "agent.hired",
            actor: { kind: "system", id: null },
            payload: { i },
          }),
        ),
      ),
    );
    const rows = await guarded
      .select({ seq: events.seq })
      .from(events)
      .where(eq(events.companyId, ctxB.companyId));
    const seqs = rows.map((r) => Number(r.seq)).sort((x, y) => x - y);
    expect(seqs).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("a rolled-back transaction leaves no gap", async () => {
    await expect(
      guarded.transaction(async (tx) => {
        await withOutbox(tx, ctxB, {
          type: "task.created",
          actor: { kind: "system", id: null },
          payload: {},
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const appended = await guarded.transaction((tx) =>
      withOutbox(tx, ctxB, { type: "task.created", actor: { kind: "system", id: null }, payload: {} }),
    );
    expect(appended.seq).toBe(21); // continues without a hole
  });

  it("batch append reserves consecutive seq values", async () => {
    const batch = await guarded.transaction((tx) =>
      appendEvents(tx, ctxB, [
        { type: "org.unit.created", actor: { kind: "founder", id: null }, payload: {} },
        { type: "org.unit.updated", actor: { kind: "founder", id: null }, payload: {} },
      ]),
    );
    expect(batch.map((e) => e.seq)).toEqual([22, 23]);
  });

  it("rejects event types violating domain.entity.action naming", async () => {
    await expect(
      guarded.transaction((tx) =>
        withOutbox(tx, ctxB, { type: "BadType", actor: { kind: "system", id: null }, payload: {} }),
      ),
    ).rejects.toThrow("naming");
  });
});

describe("outbox atomicity (_DECISIONS §9)", () => {
  it("state change + event commit together — or not at all", async () => {
    const repo = new TaskRepository(guarded, ctxA);

    // failure after both writes → NEITHER persists
    await expect(
      guarded.transaction(async (tx) => {
        const number = await nextSequenceValue(tx, ctxA, "task_number");
        const task = await repo.insert(tx, {
          number,
          kind: "task",
          title: "Doomed",
          objective: "Never lands",
        });
        await withOutbox(tx, ctxA, {
          type: "task.created",
          actor: { kind: "founder", id: null },
          taskId: task.id,
          payload: { number },
        });
        throw new Error("post-write failure");
      }),
    ).rejects.toThrow("post-write failure");
    expect(await repo.list()).toHaveLength(0);

    // success → BOTH persist, event carries the task ref
    const created = await guarded.transaction(async (tx) => {
      const number = await nextSequenceValue(tx, ctxA, "task_number");
      const task = await repo.insert(tx, {
        number,
        kind: "task",
        title: "Real",
        objective: "Lands",
      });
      await withOutbox(tx, ctxA, {
        type: "task.created",
        actor: { kind: "founder", id: null },
        taskId: task.id,
        payload: { number },
      });
      return task;
    });
    expect(await repo.list()).toHaveLength(1);
    const [event] = await guarded
      .select()
      .from(events)
      .where(eq(events.companyId, ctxA.companyId));
    expect(event!.taskId).toBe(created.id);
    expect(event!.publishedAt).toBeNull(); // relay (T21) marks it later
    expect(Number(created.number)).toBe(1); // task_number sequence independent of event_seq
  });
});

describe("idempotency-key helper (21 §3.6)", () => {
  it("fresh → replay → mismatch lifecycle", async () => {
    const request = { key: "k1", endpoint: "/api/tasks", requestHash: "h1" };
    const first = await guarded.transaction((tx) => beginIdempotent(tx, ctxA, request));
    expect(first).toEqual({ kind: "fresh" });

    await guarded.transaction((tx) =>
      completeIdempotent(tx, ctxA, request, 201, { id: "task-1" }),
    );

    const replay = await guarded.transaction((tx) => beginIdempotent(tx, ctxA, request));
    expect(replay).toEqual({
      kind: "replay",
      responseStatus: 201,
      responseBody: { id: "task-1" },
    });

    const mismatch = await guarded.transaction((tx) =>
      beginIdempotent(tx, ctxA, { ...request, requestHash: "h2" }),
    );
    expect(mismatch).toEqual({ kind: "mismatch" });
  });
});
