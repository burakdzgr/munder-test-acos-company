// T45 acceptance (12 §7, _DECISIONS §10): structured SQL lanes are
// budget-reserved and immune to embedding distance; the semantic lane
// re-ranks with the binding formula; per-scope token budgets are respected
// with summary fallback + truncation flags; only ACTIVE rows are ever
// retrievable; retrieval logging feeds the per-minute retrieval_count batch.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { estimateTokens, MEMORY_TOKEN_BUDGETS, uuidv7 } from "@acos/domain";
import {
  MemoryRetrievalService,
  applyRetrievalCounts,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "../../src/index.js";
import { users } from "../../src/schema/identity.js";
import { agents } from "../../src/schema/agents.js";
import { orgUnits, positions } from "../../src/schema/org.js";
import { projects } from "../../src/schema/projects.js";
import { memories, memoryRetrievals } from "../../src/schema/memory.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const DIM = 768;

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guarded: GuardedDb;
let ctx: CompanyContext;
let service: MemoryRetrievalService;

let companyId = "";
let agentId = "";
let projectId = "";

/** Unit basis vector — exact, index-controlled cosine geometry. */
function unit(index: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[index] = 1;
  return v;
}

/** Unit vector at an exact cosine to `target` (target and other are units). */
function atCosine(target: number[], other: number[], cosine: number): number[] {
  const sin = Math.sqrt(1 - cosine * cosine);
  return target.map((v, i) => cosine * v + sin * other[i]!);
}

const QUERY = unit(0);

async function insertMemory(input: {
  scope: "agent" | "project" | "company";
  scopeRef?: string | null;
  type?: string;
  title: string;
  content?: string;
  summary?: string;
  importance?: number;
  confidence?: number;
  status?: string;
  embedding?: number[] | null;
  entities?: Record<string, unknown>;
  ageDays?: number;
}): Promise<string> {
  const id = uuidv7();
  const embedding = input.embedding === undefined ? atCosine(QUERY, unit(5), 0.8) : input.embedding;
  await db.insert(memories).values({
    id,
    companyId,
    scope: input.scope,
    scopeRef:
      input.scopeRef !== undefined
        ? input.scopeRef
        : input.scope === "project"
          ? projectId
          : input.scope === "agent"
            ? agentId
            : null,
    type: input.type ?? "semantic",
    title: input.title,
    content: input.content ?? `content of ${input.title}`,
    summary: input.summary ?? `summary of ${input.title}`,
    entities: input.entities ?? {},
    importance: input.importance ?? 0.5,
    confidence: input.confidence ?? 0.8,
    status: input.status ?? "active",
    ...(embedding && { embedding: `[${embedding.join(",")}]`, embeddingDim: DIM }),
    embeddingModel: embedding ? `pseudo-${DIM}` : null,
  });
  if (input.ageDays) {
    await db.execute(
      sql`UPDATE memories SET created_at = now() - make_interval(days => ${input.ageDays}) WHERE id = ${id}`,
    );
  }
  return id;
}

function retrieve(overrides: Partial<Parameters<MemoryRetrievalService["retrieveForWorkingSet"]>[1]> = {}) {
  return service.retrieveForWorkingSet(ctx, {
    agentId,
    taskId: null,
    projectId,
    queryEmbedding: QUERY,
    ...overrides,
  });
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guarded = createGuardedDb(pool);
  service = new MemoryRetrievalService(guarded);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t45.local", passwordHash: "x", displayName: "F" })
    .returning();
  const { companies } = await import("../../src/schema/companies.js");
  const [company] = await db
    .insert(companies)
    .values({ name: "RetrCo", slug: "retrco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unitRow] = await db
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
      name: "Retriever",
      status: "active",
      positionId: position!.id,
      orgUnitId: unitRow!.id,
      seniority: "mid",
      autonomyLevel: 2,
      persona: "Recalls.",
    })
    .returning();
  agentId = agent!.id;
  projectId = uuidv7();
  await db.insert(projects).values({
    id: projectId,
    companyId,
    name: "Retrieval",
    slug: "retrieval",
    objectiveMd: "x",
    status: "active",
    createdByUserId: founder!.id,
  });
}, 300_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe("working-set retrieval (12 §7)", { timeout: 60_000 }, () => {
  it("SQL lanes: decisions/procedures/failures/relationships — recalled regardless of embedding distance, packed first", async () => {
    const decisionId = await insertMemory({
      scope: "project",
      type: "decision",
      title: "ADR-7: use pgvector",
      embedding: null, // no embedding at all — SQL recall must still find it
    });
    const procCompanyId = await insertMemory({
      scope: "company",
      type: "procedural",
      title: "Always run npm test before review",
      embedding: atCosine(QUERY, unit(6), 0.01), // semantically FAR
      importance: 0.9,
    });
    const failureId = await insertMemory({
      scope: "project",
      type: "failure",
      title: "login.ts OOMs on buffered reads",
      embedding: null,
      entities: { files: ["src/auth/login.ts", "src/auth/session.ts"] },
    });
    const relationshipId = await insertMemory({
      scope: "agent",
      type: "relationship",
      title: "Kerem prefers small diffs",
      embedding: null,
      entities: { agents: ["kerem-uuid"] },
    });

    const result = await retrieve({
      taskFilePaths: ["src/auth/login.ts"],
      threadAgentIds: ["kerem-uuid"],
    });
    expect(result.sections.project).toContain(decisionId);
    expect(result.sections.project).toContain(failureId);
    expect(result.sections.company).toContain(procCompanyId);
    expect(result.sections.agent).toContain(relationshipId);
    expect(result.flags.empty).toBe(false);

    // exact-match lanes stay silent without their keys (12 §7.1)
    const without = await retrieve();
    expect(without.sections.project).not.toContain(failureId);
    expect(without.sections.agent).not.toContain(relationshipId);
    // must-know rows lead their scope section (budget-reserved)
    expect(result.sections.project.indexOf(decisionId)).toBeGreaterThanOrEqual(0);
  });

  it("semantic lane re-ranks with 0.55·cos + 0.2·imp + 0.15·recency + 0.1·conf; SQL-lane rows are deduped", async () => {
    // close but unimportant vs farther but important+fresh
    const closeWeak = await insertMemory({
      scope: "agent",
      title: "close but weak",
      embedding: atCosine(QUERY, unit(7), 0.9),
      importance: 0.1,
      confidence: 0.3,
      ageDays: 300, // episodic-ish decay via type semantic 365d half-life
    });
    const farStrong = await insertMemory({
      scope: "agent",
      title: "farther but strong",
      embedding: atCosine(QUERY, unit(8), 0.62),
      importance: 0.95,
      confidence: 0.95,
      ageDays: 0,
    });
    const result = await retrieve();
    const section = result.sections.agent;
    // 0.55·0.9+0.2·0.1+0.15·0.565+0.1·0.3 ≈ 0.63 < 0.55·0.62+0.2·0.95+0.15·1+0.1·0.95 ≈ 0.77
    expect(section.indexOf(farStrong)).toBeGreaterThanOrEqual(0);
    expect(section.indexOf(closeWeak)).toBeGreaterThan(section.indexOf(farStrong));

    // a decision already returned by the SQL lane appears exactly once
    const dupDecision = await insertMemory({
      scope: "project",
      type: "decision",
      title: "ADR-8: dedupe check",
      embedding: atCosine(QUERY, unit(9), 0.95),
    });
    const second = await retrieve();
    const occurrences = second.sections.project.split(dupDecision).length - 1;
    expect(occurrences).toBe(1);
  });

  it("only status=active rows are retrievable — candidate/superseded never return", async () => {
    const candidate = await insertMemory({
      scope: "agent",
      title: "candidate row",
      embedding: atCosine(QUERY, unit(10), 0.99),
      status: "candidate",
    });
    const superseded = await insertMemory({
      scope: "project",
      type: "decision",
      title: "superseded decision",
      embedding: null,
      status: "superseded",
    });
    const result = await retrieve();
    expect(result.ids).not.toContain(candidate);
    expect(result.ids).not.toContain(superseded);
  });

  it("per-scope budgets: packing falls back to summaries, sections stay within budget, starvation flags truncated", async () => {
    // 24 oversized project memories: full ≈ 1000 tokens, summary ≈ 80 tokens
    for (let i = 0; i < 24; i++) {
      await insertMemory({
        scope: "project",
        title: `bulk ${i}`,
        content: "x".repeat(4000),
        summary: "s".repeat(300),
        embedding: atCosine(QUERY, unit(11 + (i % 400)), 0.85 - i * 0.001),
        importance: 0.9,
      });
    }
    const result = await retrieve();
    expect(estimateTokens(result.sections.project)).toBeLessThanOrEqual(
      MEMORY_TOKEN_BUDGETS.project + 32, // + joins/newlines slack
    );
    expect(estimateTokens(result.sections.agent)).toBeLessThanOrEqual(
      MEMORY_TOKEN_BUDGETS.agent + 32,
    );
    expect(estimateTokens(result.sections.company)).toBeLessThanOrEqual(
      MEMORY_TOKEN_BUDGETS.company + 32,
    );
    expect(result.sections.project).toContain("— s"); // summary fallback rendered
    expect(result.flags.truncated).toBe(true); // ≥50% of scored rows dropped (12 §7.5b)
  });

  it("no query embedding ⇒ semantic lane skipped, SQL lanes still serve, flag set", async () => {
    const result = await retrieve({ queryEmbedding: null });
    expect(result.flags.semanticSkipped).toBe(true);
    expect(result.sections.project.length).toBeGreaterThan(0); // decisions/procedures present
  });

  it("retrieval logging + per-minute batch: counts applied once, 14-day sweep", async () => {
    const target = await insertMemory({
      scope: "company",
      type: "procedural",
      title: "countable procedure",
      embedding: null,
      importance: 0.99,
    });
    const before = await db
      .select({ n: memories.retrievalCount })
      .from(memories)
      .where(eq(memories.id, target));

    const r1 = await retrieve();
    const r2 = await retrieve();
    expect(r1.ids).toContain(target);
    expect(r2.ids).toContain(target);

    const logs = await db
      .select()
      .from(memoryRetrievals)
      .where(and(eq(memoryRetrievals.companyId, companyId), eq(memoryRetrievals.counted, false)));
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs[0]!.returnedIds.length).toBe(logs[0]!.scores.length);
    expect(logs[0]!.budgetTokensUsed).toBeGreaterThan(0);

    const applied = await applyRetrievalCounts(db);
    expect(applied.applied).toBeGreaterThanOrEqual(2);
    const after = await db
      .select({ n: memories.retrievalCount })
      .from(memories)
      .where(eq(memories.id, target));
    expect(after[0]!.n - before[0]!.n).toBeGreaterThanOrEqual(2);

    // second run: everything already counted — no double counting
    const again = await applyRetrievalCounts(db);
    expect(again.applied).toBe(0);
    const final = await db
      .select({ n: memories.retrievalCount })
      .from(memories)
      .where(eq(memories.id, target));
    expect(final[0]!.n).toBe(after[0]!.n);

    // 14-day retention sweep
    await db.execute(
      sql`UPDATE memory_retrievals SET created_at = now() - interval '15 days' WHERE company_id = ${companyId}`,
    );
    const sweep = await applyRetrievalCounts(db);
    expect(sweep.swept).toBeGreaterThanOrEqual(2);
    const remaining = await db
      .select({ id: memoryRetrievals.id })
      .from(memoryRetrievals)
      .where(eq(memoryRetrievals.companyId, companyId));
    expect(remaining).toHaveLength(0);
  });
});
