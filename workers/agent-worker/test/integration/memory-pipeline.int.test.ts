// T44 acceptance — the memory pipeline suite of 32 §2, at BOTH embedding
// dimensions (1536/768, ADR-020): extract → score → scope → evidence → embed
// (pseudo-deterministic vectors) → pgvector similarity → merge / contradiction
// flag → persist with status. Fake LLM throughout (canned consolidation
// fixtures, 32 §6) — every run is fully deterministic. Demo steps 20–21:
// a completed scripted task produces typed memory rows with evidence refs and
// provenance, consolidation reports its counts.
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { uuidv7 } from "@acos/domain";
import {
  appendEvents,
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
  events,
  memories,
  memoryEvidence,
  memoryRelations,
  memoryVersions,
  orgUnits,
  positions,
  projects,
  tasks,
  users,
} from "@acos/db/schema";
import { pseudoEmbedding } from "@acos/llm/testing";
import { TASK_QUEUES } from "@acos/config";
import { createMemoryActivities } from "../../src/memory/activities.js";
import { workflowIds } from "../../src/client.js";
import type { ConsolidationReport } from "../../src/workflows/memory/index.js";
import { startPostgres, startTemporal } from "./helpers";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../../src/workflows/memory/index.ts");

let pgContainer: Awaited<ReturnType<typeof startPostgres>>;
let temporal: Awaited<ReturnType<typeof startTemporal>>;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let clientConnection: Connection;
let client: Client;

let companyId = "";
let founderId = "";
let ownerAgentId = "";
let taskCounter = 0;

/** Unit vector at an exact cosine to `target` (Gram-Schmidt mix). */
function atCosine(target: number[], other: number[], cosine: number): number[] {
  const dot = target.reduce((sum, v, i) => sum + v * other[i]!, 0);
  const orth = other.map((v, i) => v - dot * target[i]!);
  const norm = Math.sqrt(orth.reduce((sum, v) => sum + v * v, 0)) || 1;
  const sin = Math.sqrt(1 - cosine * cosine);
  return target.map((v, i) => cosine * v + sin * (orth[i]! / norm));
}

function vec(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

async function seedProject(name: string): Promise<string> {
  const id = uuidv7();
  await db.insert(projects).values({
    id,
    companyId,
    name,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    objectiveMd: "Pipeline test project.",
    status: "active",
    createdByUserId: founderId,
  });
  return id;
}

/** Task + its significant events (the 12 §5.0 trigger window). */
async function seedTask(input: {
  fixture: string;
  projectId: string | null;
  eventCount?: number;
}): Promise<{ taskId: string; eventIds: string[] }> {
  taskCounter += 1;
  const [task] = await db
    .insert(tasks)
    .values({
      companyId,
      number: taskCounter,
      kind: "task",
      title: `Memory pipeline task ${taskCounter}`,
      objective: "Consolidation trigger window.",
      status: "DONE",
      ownerAgentId,
      projectId: input.projectId,
      context: { taskFixture: input.fixture },
    })
    .returning();
  const taskId = task!.id;
  const eventIds: string[] = [];
  const count = input.eventCount ?? 2;
  if (count > 0) {
    await guardedDb.transaction(async (tx) => {
      const appended = await appendEvents(
        tx,
        ctx,
        Array.from({ length: count }, (_, i) => ({
          type: "task.status.changed",
          actor: { kind: "agent" as const, id: ownerAgentId },
          taskId,
          agentId: ownerAgentId,
          payload: {
            from: i === 0 ? "IN_PROGRESS" : "REVIEW",
            to: i === 0 ? "REVIEW" : "DONE",
            byActor: { kind: "agent", id: ownerAgentId },
          },
        })),
      );
      eventIds.push(...appended.map((e) => e.id));
    });
  }
  return { taskId, eventIds };
}

async function runConsolidation(
  taskId: string,
  opts: { trigger?: "task_completed" | "task_failed"; queue?: string; refSuffix?: string } = {},
): Promise<ConsolidationReport> {
  return client.workflow.execute("memoryConsolidationWorkflow", {
    taskQueue: opts.queue ?? TASK_QUEUES.memory,
    workflowId: workflowIds.consolidation(companyId, `task-${taskId}${opts.refSuffix ?? ""}`),
    args: [{ companyId, taskId, trigger: opts.trigger ?? "task_completed" }],
  });
}

async function eventsOfType(type: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.companyId, companyId), eq(events.type, type)))
    .orderBy(asc(events.seq));
}

beforeAll(async () => {
  [pgContainer, temporal] = await Promise.all([startPostgres(), startTemporal()]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t44.local", passwordHash: "x", displayName: "F" })
    .returning();
  founderId = founder!.id;
  const [company] = await db
    .insert(companies)
    .values({ name: "MemCo", slug: "memco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Eng", slug: "eng" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      employeeNumber: 1,
      name: "Mem Dev",
      status: "active",
      positionId: position!.id,
      orgUnitId: unit!.id,
      seniority: "mid",
      autonomyLevel: 2,
      persona: "Remembers.",
    })
    .returning();
  ownerAgentId = agent!.id;

  clientConnection = await Connection.connect({ address: temporal.address });
  client = new Client({ connection: clientConnection, namespace: "acos" });
}, 300_000);

afterAll(async () => {
  await clientConnection?.close();
  await pool?.end();
  await temporal?.container.stop();
  await pgContainer?.stop();
});

describe.each([{ dim: 768 }, { dim: 1536 }])(
  "consolidation pipeline at dimension $dim (12 §5; ADR-020)",
  ({ dim }) => {
    let nativeConnection: NativeConnection;
    let worker: Worker;
    let workerRun: Promise<void>;
    let projectId = "";

    beforeAll(async () => {
      nativeConnection = await NativeConnection.connect({ address: temporal.address });
      worker = await Worker.create({
        connection: nativeConnection,
        namespace: "acos",
        taskQueue: TASK_QUEUES.memory,
        workflowsPath,
        activities: createMemoryActivities({ guardedDb, scripted: true, scriptedDim: dim }),
      });
      workerRun = worker.run();
      projectId = await seedProject(`Proj main ${dim}`);
    }, 120_000);

    afterAll(async () => {
      worker?.shutdown();
      await workerRun?.catch(() => {});
      await nativeConnection?.close();
    });

    it("extract → score → scope → embed → persist: typed rows with evidence + provenance (demo 20–21)", async () => {
      const { taskId, eventIds } = await seedTask({ fixture: "csv-implementation", projectId });
      const report = await runConsolidation(taskId);
      expect(report).toMatchObject({
        extracted: 2,
        persisted: 2,
        merged: 0,
        contradictions: 0,
        discarded: 0,
        hallucinatedEvidence: 0,
      });

      // failure lesson names files → project scope (rule 1); the personal
      // procedure has none → agent scope (rule 2)
      const rows = await db
        .select()
        .from(memories)
        .where(and(eq(memories.companyId, companyId), eq(memories.embeddingDim, dim)));
      const failure = rows.find((r) => r.type === "failure" && r.scopeRef === projectId);
      const procedural = rows.find((r) => r.type === "procedural" && r.scope === "agent");
      expect(failure).toBeDefined();
      expect(procedural).toBeDefined();
      expect(failure!.scope).toBe("project");
      expect(procedural!.scopeRef).toBe(ownerAgentId);
      // importance ≥ 0.45 ⇒ active (12 §5.9); embedding stored per-dimension
      for (const row of [failure!, procedural!]) {
        expect(row.status).toBe("active");
        expect(row.embedding).not.toBeNull();
        expect(row.embeddingDim).toBe(dim);
        expect(row.embeddingModel).toBe(`pseudo-${dim}`);
        expect(row.sourceEventId).toBe(eventIds[0]!);
        expect(row.createdByAgentId).toBe(ownerAgentId);
      }
      // confidence formula (12 §5.8): base cap 0.6 + 2 event refs ⇒ 0.9
      expect(failure!.confidence).toBeCloseTo(0.9, 5);

      // version 1 + evidence rows resolve to the REAL window events
      const versions = await db
        .select()
        .from(memoryVersions)
        .where(
          and(eq(memoryVersions.companyId, companyId), eq(memoryVersions.memoryId, failure!.id)),
        );
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ version: 1, changeReason: "consolidation" });
      const evidence = await db
        .select()
        .from(memoryEvidence)
        .where(
          and(eq(memoryEvidence.companyId, companyId), eq(memoryEvidence.memoryId, failure!.id)),
        );
      expect(evidence.length).toBe(2);
      for (const item of evidence) {
        expect(item.kind).toBe("event");
        expect(eventIds).toContain(item.ref);
      }

      const created = await eventsOfType("memory.created");
      expect(created.length).toBeGreaterThanOrEqual(2);
      const completed = await eventsOfType("memory.consolidation.completed");
      const mine = completed.filter((e) => e.taskId === taskId);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.payload).toMatchObject({ candidates: 2, persisted: 2, merged: 0, discarded: 0 });
    }, 90_000);

    it("near-duplicate fast path (cosine ≥ 0.95): merge, version bump, no new rows", async () => {
      const before = await db
        .select({ id: memories.id })
        .from(memories)
        .where(and(eq(memories.companyId, companyId), eq(memories.embeddingDim, dim)));

      // a second completed task in the same scopes re-extracts the SAME canned
      // candidates ⇒ identical pseudo-vectors ⇒ cosine 1.0
      const { taskId } = await seedTask({ fixture: "csv-implementation", projectId });
      const report = await runConsolidation(taskId);
      expect(report).toMatchObject({ extracted: 2, persisted: 0, merged: 2 });

      const after = await db
        .select()
        .from(memories)
        .where(and(eq(memories.companyId, companyId), eq(memories.embeddingDim, dim)));
      expect(after.length).toBe(before.length); // merged, not duplicated
      const failure = after.find((r) => r.type === "failure" && r.scopeRef === projectId)!;
      expect(failure.version).toBe(2);
      expect(failure.lastVerifiedAt).not.toBeNull();

      const versions = await db
        .select()
        .from(memoryVersions)
        .where(
          and(eq(memoryVersions.companyId, companyId), eq(memoryVersions.memoryId, failure.id)),
        )
        .orderBy(asc(memoryVersions.version));
      expect(versions.map((v) => v.changeReason)).toEqual(["consolidation", "consolidation_merge"]);
      // evidence of the new window appended (2 original + 2 merged)
      const evidence = await db
        .select()
        .from(memoryEvidence)
        .where(
          and(eq(memoryEvidence.companyId, companyId), eq(memoryEvidence.memoryId, failure.id)),
        );
      expect(evidence.length).toBe(4);
      const updated = await eventsOfType("memory.updated");
      expect(updated.length).toBeGreaterThanOrEqual(2);
    }, 90_000);

    it("compare band 0.86–0.95 ⇒ duplicate merge into the neighbor", async () => {
      const mergeProjectId = await seedProject(`Proj merge ${dim}`);
      const candidateText =
        "Retry uploads with exponential backoff\n" +
        "S3 uploads flake under load; retry 3x with exponential backoff starting at 500ms.\n" +
        "S3 uploads flake under load; retry 3x with exponential backoff starting at 500ms.";
      const target = pseudoEmbedding(candidateText, dim);
      const neighborVec = atCosine(target, pseudoEmbedding("neighbor-merge", dim), 0.9);
      const [neighbor] = await db
        .insert(memories)
        .values({
          companyId,
          scope: "project",
          scopeRef: mergeProjectId,
          type: "failure",
          title: "Upload retries need backoff",
          content: "Uploads to S3 should retry with backoff on 5xx.",
          summary: "Retry uploads with backoff.",
          importance: 0.6,
          confidence: 0.8,
          status: "active",
          embedding: vec(neighborVec),
          embeddingDim: dim,
          embeddingModel: `pseudo-${dim}`,
        })
        .returning();

      const { taskId } = await seedTask({ fixture: "single-lesson", projectId: mergeProjectId });
      const report = await runConsolidation(taskId);
      expect(report).toMatchObject({ extracted: 1, persisted: 0, merged: 1, contradictions: 0 });

      const rows = await db
        .select()
        .from(memories)
        .where(and(eq(memories.companyId, companyId), eq(memories.scopeRef, mergeProjectId)));
      expect(rows).toHaveLength(1); // only the neighbor — merged into it
      expect(rows[0]!.id).toBe(neighbor!.id);
      expect(rows[0]!.version).toBe(2);
    }, 90_000);

    it("compare band 0.70–0.86 ⇒ contradiction: both survive, relation + capped confidence", async () => {
      const contraProjectId = await seedProject(`Proj contra ${dim}`);
      const candidateText =
        "Retry uploads with exponential backoff\n" +
        "S3 uploads flake under load; retry 3x with exponential backoff starting at 500ms.\n" +
        "S3 uploads flake under load; retry 3x with exponential backoff starting at 500ms.";
      const target = pseudoEmbedding(candidateText, dim);
      const neighborVec = atCosine(target, pseudoEmbedding("neighbor-contra", dim), 0.78);
      const [neighbor] = await db
        .insert(memories)
        .values({
          companyId,
          scope: "project",
          scopeRef: contraProjectId,
          type: "failure",
          title: "Never retry S3 uploads",
          content: "Upload retries amplify load; fail fast and surface the error instead.",
          summary: "Do not retry uploads.",
          importance: 0.6,
          confidence: 0.8,
          status: "active",
          embedding: vec(neighborVec),
          embeddingDim: dim,
          embeddingModel: `pseudo-${dim}`,
        })
        .returning();

      const { taskId } = await seedTask({ fixture: "single-lesson", projectId: contraProjectId });
      const report = await runConsolidation(taskId);
      expect(report).toMatchObject({ extracted: 1, persisted: 1, merged: 0, contradictions: 1 });

      const rows = await db
        .select()
        .from(memories)
        .where(and(eq(memories.companyId, companyId), eq(memories.scopeRef, contraProjectId)));
      expect(rows).toHaveLength(2); // both survive — never auto-resolved (12 §5.6)
      const candidate = rows.find((r) => r.id !== neighbor!.id)!;
      expect(candidate.confidence).toBeLessThanOrEqual(0.6); // contradiction cap

      const relations = await db
        .select()
        .from(memoryRelations)
        .where(
          and(
            eq(memoryRelations.companyId, companyId),
            inArray(memoryRelations.fromMemoryId, [candidate.id]),
          ),
        );
      expect(relations).toHaveLength(1);
      expect(relations[0]).toMatchObject({ toMemoryId: neighbor!.id, kind: "contradicts" });
      const detected = await eventsOfType("memory.contradiction.detected");
      expect(
        detected.some(
          (e) =>
            (e.payload as { memoryIdA?: string }).memoryIdA === candidate.id &&
            (e.payload as { memoryIdB?: string }).memoryIdB === neighbor!.id,
        ),
      ).toBe(true);
    }, 90_000);

    it("FAILED task ⇒ failure lesson in the 0.30–0.45 band persists as status=candidate (demo 20)", async () => {
      const failedProjectId = await seedProject(`Proj failed ${dim}`);
      // 1 window event ⇒ no evidence bonus: 0.3 + 0.1 (costly trigger) = 0.4
      const { taskId, eventIds } = await seedTask({
        fixture: "flaky-test-failure",
        projectId: failedProjectId,
        eventCount: 1,
      });
      const report = await runConsolidation(taskId, { trigger: "task_failed" });
      expect(report).toMatchObject({ extracted: 1, persisted: 1, merged: 0, discarded: 0 });

      const rows = await db
        .select()
        .from(memories)
        .where(and(eq(memories.companyId, companyId), eq(memories.scopeRef, failedProjectId)));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.type).toBe("failure");
      expect(rows[0]!.status).toBe("candidate"); // 12 §5.9 low-importance queue
      expect(rows[0]!.importance).toBeCloseTo(0.4, 5);
      const evidence = await db
        .select()
        .from(memoryEvidence)
        .where(
          and(eq(memoryEvidence.companyId, companyId), eq(memoryEvidence.memoryId, rows[0]!.id)),
        );
      expect(evidence).toHaveLength(1);
      expect(evidence[0]!.ref).toBe(eventIds[0]!);
    }, 90_000);

    it("adjusted importance < 0.30 ⇒ discarded, nothing persisted", async () => {
      const discardProjectId = await seedProject(`Proj discard ${dim}`);
      const { taskId } = await seedTask({ fixture: "low-importance", projectId: discardProjectId });
      const report = await runConsolidation(taskId);
      expect(report).toMatchObject({ extracted: 1, persisted: 0, merged: 0, discarded: 1 });
      const rows = await db
        .select({ id: memories.id })
        .from(memories)
        .where(and(eq(memories.companyId, companyId), eq(memories.scopeRef, discardProjectId)));
      expect(rows).toHaveLength(0);
    }, 90_000);

    it("every evidence ref unresolvable ⇒ hallucinated_evidence discard (12 §5.7)", async () => {
      const hallProjectId = await seedProject(`Proj hall ${dim}`);
      // no window events → the scripted extraction fabricates a ref that
      // resolves against nothing
      const { taskId } = await seedTask({
        fixture: "single-lesson",
        projectId: hallProjectId,
        eventCount: 0,
      });
      const report = await runConsolidation(taskId);
      expect(report).toMatchObject({
        extracted: 1,
        persisted: 0,
        merged: 0,
        hallucinatedEvidence: 1,
      });
      const rows = await db
        .select({ id: memories.id })
        .from(memories)
        .where(and(eq(memories.companyId, companyId), eq(memories.scopeRef, hallProjectId)));
      expect(rows).toHaveLength(0);
    }, 90_000);
  },
);

describe("promotion chaining after consolidation (12 §6.2, T46)", () => {
  const QUEUE = "memory-promotion-chain";
  let nativeConnection: NativeConnection;
  let worker: Worker;
  let workerRun: Promise<void>;

  beforeAll(async () => {
    nativeConnection = await NativeConnection.connect({ address: temporal.address });
    worker = await Worker.create({
      connection: nativeConnection,
      namespace: "acos",
      taskQueue: QUEUE,
      workflowsPath,
      activities: createMemoryActivities({ guardedDb, scripted: true, scriptedDim: 768 }),
    });
    workerRun = worker.run();
    const { seedPromotionPolicies, companyContext: cc } = await import("@acos/db");
    await seedPromotionPolicies(guardedDb, cc(companyId));
  }, 120_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRun?.catch(() => {});
    await nativeConnection?.close();
  });

  it("a merge that crosses the evidence threshold proposes a promotion; founder approval activates the copy", async () => {
    // the agent-scope procedural memory from the 768 runs already carries
    // evidence from 2 tasks; one more consolidation merge pushes it to 3
    // distinct tasks ⇒ the agent→project rule fires right after the run
    const promoProjectId = await seedProject("Proj promo-chain");
    const { taskId } = await seedTask({ fixture: "csv-implementation", projectId: promoProjectId });
    const report = await runConsolidation(taskId, { queue: QUEUE });
    expect(report.merged).toBeGreaterThanOrEqual(1);

    const { memoryPromotions, memoryRelations } = await import("@acos/db/schema");
    const promotions = await db
      .select()
      .from(memoryPromotions)
      .where(eq(memoryPromotions.companyId, companyId));
    expect(promotions.length).toBeGreaterThanOrEqual(1);
    const promotion = promotions.find((p) => p.targetScope === "project")!;
    expect(promotion).toBeDefined();
    expect(promotion.status).toBe("proposed");
    expect(promotion.evidenceCount).toBeGreaterThanOrEqual(3);
    expect(promotion.distinctTaskCount).toBeGreaterThanOrEqual(2);

    // candidate copy + derived_from lineage (12 §6.3)
    const copy = (
      await db.select().from(memories).where(eq(memories.id, promotion.targetMemoryId!))
    )[0]!;
    expect(copy.scope).toBe("project");
    expect(copy.status).toBe("candidate");
    const lineage = await db
      .select()
      .from(memoryRelations)
      .where(
        and(
          eq(memoryRelations.fromMemoryId, copy.id),
          eq(memoryRelations.kind, "derived_from"),
        ),
      );
    expect(lineage).toHaveLength(1);
    expect(lineage[0]!.toMemoryId).toBe(promotion.sourceMemoryId);
    const proposedEvents = await eventsOfType("memory.promotion.proposed");
    expect(proposedEvents.length).toBeGreaterThanOrEqual(1);

    // founder approves → active at the new scope + memory.promoted; the
    // original stays active (promotion copies, never moves)
    const { MemoryPromotionService, companyContext: cc } = await import("@acos/db");
    const service = new MemoryPromotionService(guardedDb);
    const decided = await service.decide(cc(companyId), promotion.id, {
      verdict: "approved",
      approverAgentId: null,
    });
    expect(decided.status).toBe("active");
    const original = (
      await db.select().from(memories).where(eq(memories.id, promotion.sourceMemoryId))
    )[0]!;
    expect(original.status).toBe("active");
    const promotedEvents = await eventsOfType("memory.promoted");
    expect(
      promotedEvents.some(
        (e) => (e.payload as { newMemoryId?: string }).newMemoryId === copy.id,
      ),
    ).toBe(true);
  }, 90_000);
});

describe("embedding failure path (12 §5.4)", () => {
  const QUEUE = "memory-embedfail";
  let nativeConnection: NativeConnection;
  let worker: Worker;
  let workerRun: Promise<void>;

  beforeAll(async () => {
    nativeConnection = await NativeConnection.connect({ address: temporal.address });
    worker = await Worker.create({
      connection: nativeConnection,
      namespace: "acos",
      taskQueue: QUEUE,
      workflowsPath,
      activities: createMemoryActivities({
        guardedDb,
        scripted: true,
        scriptedDim: 768,
        embedOverride: async () => {
          throw new Error("embedding provider down");
        },
      }),
    });
    workerRun = worker.run();
  }, 120_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRun?.catch(() => {});
    await nativeConnection?.close();
  });

  it("persists with a NULL embedding + memory.embedding.failed; SQL lanes still serve it", async () => {
    const failProjectId = await seedProject("Proj embedfail");
    const { taskId } = await seedTask({ fixture: "single-lesson", projectId: failProjectId });
    const report = await runConsolidation(taskId, { queue: QUEUE, refSuffix: "-embedfail" });
    expect(report).toMatchObject({ extracted: 1, persisted: 1, merged: 0 });

    const rows = await db
      .select()
      .from(memories)
      .where(and(eq(memories.companyId, companyId), eq(memories.scopeRef, failProjectId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.embedding).toBeNull();
    expect(rows[0]!.embeddingDim).toBeNull();
    expect(rows[0]!.status).toBe("active");

    const failed = await eventsOfType("memory.embedding.failed");
    expect(
      failed.some((e) => (e.payload as { memoryId?: string }).memoryId === rows[0]!.id),
    ).toBe(true);
  }, 90_000);
});
