// Memory consolidation core (T44; 12 §5, _DECISIONS §10). Lives in @acos/db
// for the shared-single-implementation reason: the memoryConsolidationWorkflow
// activities, the promotion sweep (T45) and the Observatory REST surface all
// persist/merge/query through the SAME rules — the company-scope assert, the
// contradiction confidence cap and the versioning discipline cannot diverge.
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
import {
  MEMORY_SIGNIFICANT_PREFIXES,
  MEMORY_SIGNIFICANT_TYPES,
  parseEventPayload,
} from "@acos/events";
import { appendEvents, type NewEventInput, type Tx } from "./outbox.js";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import {
  agents,
  artifacts,
  auditLog,
  events,
  memories,
  memoryEvidence,
  memoryRelations,
  memoryVersions,
  reviews,
  tasks,
} from "./schema/index.js";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

export class MemoryError extends Error {
  constructor(
    public readonly code: "MEMORY_SCOPE_FORBIDDEN" | "MEMORY_NOT_FOUND" | "MEMORY_BAD_DIMENSION",
    message: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

/** Contradicting candidates persist with confidence capped here (12 §5.6). */
const CONTRADICTION_CONFIDENCE_CAP = 0.6;
/** importance ≥ 0.45 → active; 0.30–0.45 → candidate (12 §5.9). */
const IMPORTANCE_ACTIVE_THRESHOLD = 0.45;

/**
 * "Significant events" (12 §5.0): the trigger window is the catalog subset of
 * task transitions, review verdicts, build/test results and escalations. MVP
 * narrowing [recorded]: matched by type prefix instead of a
 * `memory_significant` catalog flag. The list now lives in `@acos/events`
 * (12 §5.0 names `packages/events` as its home) so the window here and the
 * `memory-trigger` N-significant-events counter cannot drift apart.
 */
const SIGNIFICANT_PREFIXES: string[] = [...MEMORY_SIGNIFICANT_PREFIXES];
const SIGNIFICANT_TYPES: string[] = [...MEMORY_SIGNIFICANT_TYPES];

export interface WindowEvent {
  id: string;
  type: string;
  occurredAt: string;
  payloadSummary: string;
}

export interface TriggerWindow {
  task: {
    id: string;
    title: string;
    status: string;
    projectId: string | null;
    ownerAgentId: string | null;
    fixtureKey: string | null;
  } | null;
  events: WindowEvent[];
  /**
   * 12 §5.0 rows 2–4 (N significant events / escalation resolved / experiment
   * concluded): those triggers have no owning task, so the window is anchored
   * on the acting agent instead. Absent/null for the task-completion window.
   */
  agent?: {
    id: string;
    name: string;
    /** the project the windowed events belong to, when they agree on one */
    projectId: string | null;
  } | null;
}

export interface SimilarMemory {
  id: string;
  title: string;
  content: string;
  summary: string;
  type: string;
  status: string;
  confidence: number;
  cosine: number;
}

export interface EvidenceInput {
  kind: "event" | "artifact" | "review" | "metric" | "statement";
  ref: string;
  weight?: number;
}

export interface RelationInput {
  toMemoryId: string;
  kind: "supports" | "contradicts" | "supersedes";
}

/**
 * Canonical kod referansları (REVISION TASK 5): entities.files / .symbols /
 * .commits / .tests anahtarları normalize edilir — benzersiz string dizileri,
 * anahtar başına 50 kayıt. Retrieval'ın CodeIndex lane'i bu anahtarlarla
 * (?| operatörü) eşleşir; normalizasyon eşleşmenin tip güvencesidir.
 */
export const CODE_REF_KEYS = ["files", "symbols", "commits", "tests"] as const;
export function normalizeCodeRefs(
  entities: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...entities };
  for (const key of CODE_REF_KEYS) {
    const raw = out[key];
    if (raw === undefined) continue;
    const arr = Array.isArray(raw) ? raw : [raw];
    const cleaned = [
      ...new Set(
        arr
          .filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 500)
          .map((v) => v.trim()),
      ),
    ].slice(0, 50);
    if (cleaned.length > 0) out[key] = cleaned;
    else delete out[key];
  }
  return out;
}

export interface PersistCandidateInput {
  scope: "agent" | "project" | "company"; // company is asserted away (12 §5.3)
  scopeRef: string;
  type: string;
  title: string;
  content: string;
  summary: string;
  entities: Record<string, unknown>;
  importance: number;
  confidence: number;
  sourceEventId: string | null;
  createdByAgentId: string | null;
  embedding: number[] | null;
  embeddingModel: string | null;
  /** set with a NULL embedding → memory.embedding.failed in the same tx (12 §5.4) */
  embedFailedError?: string | undefined;
  evidence: EvidenceInput[];
  relations: RelationInput[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function assertDimension(dim: number): void {
  if (!Number.isInteger(dim) || dim < 1 || dim > 4096) {
    throw new MemoryError("MEMORY_BAD_DIMENSION", `unsupported embedding dimension ${dim}`);
  }
}

export class MemoryConsolidationService {
  constructor(private readonly db: GuardedDb) {}

  /** Task-completion trigger window: the task + its significant events (12 §5.0). */
  async loadTaskWindow(ctx: CompanyContext, taskId: string): Promise<TriggerWindow> {
    const [task] = await this.db
      .select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        projectId: tasks.projectId,
        ownerAgentId: tasks.ownerAgentId,
        context: tasks.context,
      })
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
    if (!task) return { task: null, events: [] };

    const rows = await this.db
      .select({ id: events.id, type: events.type, occurredAt: events.occurredAt, payload: events.payload })
      .from(events)
      .where(
        and(
          eq(events.companyId, ctx.companyId),
          eq(events.taskId, taskId),
          or(
            ...SIGNIFICANT_PREFIXES.map((p) => like(events.type, `${p}%`)),
            inArray(events.type, SIGNIFICANT_TYPES),
          ),
        ),
      )
      .orderBy(asc(events.seq))
      .limit(200);

    const context = (task.context ?? {}) as Record<string, unknown>;
    return {
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        projectId: task.projectId,
        ownerAgentId: task.ownerAgentId,
        fixtureKey: typeof context.taskFixture === "string" ? context.taskFixture : null,
      },
      events: rows
        .filter((row): row is typeof row & { id: string } => row.id !== null)
        .map((row) => ({
          id: row.id,
          type: row.type,
          occurredAt: row.occurredAt.toISOString(),
          payloadSummary: JSON.stringify(row.payload).slice(0, 300),
        })),
    };
  }

  /**
   * Agent-scoped trigger window (12 §5.0 rows 2–4). "N significant events"
   * declares its window as "the N events since last run for that agent" — the
   * memory-trigger consumer counts them and hands the exact ids over in
   * `eventIds`; escalation/experiment triggers pass the single resolving event.
   * With no ids the last `limit` significant events of the agent are used.
   */
  async loadAgentWindow(
    ctx: CompanyContext,
    input: { agentId: string; eventIds?: string[]; limit?: number },
  ): Promise<TriggerWindow> {
    if (!UUID_RE.test(input.agentId)) return { task: null, events: [], agent: null };
    const [agent] = await this.db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, input.agentId)));
    if (!agent) return { task: null, events: [], agent: null };

    const limit = Math.min(input.limit ?? 200, 200);
    const ids = (input.eventIds ?? []).filter((id) => UUID_RE.test(id)).slice(0, limit);
    const significant = or(
      ...SIGNIFICANT_PREFIXES.map((p) => like(events.type, `${p}%`)),
      inArray(events.type, SIGNIFICANT_TYPES),
    );
    const rows = await this.db
      .select({
        id: events.id,
        seq: events.seq,
        type: events.type,
        occurredAt: events.occurredAt,
        payload: events.payload,
        projectId: events.projectId,
      })
      .from(events)
      .where(
        // explicit ids: the trigger already established which events belong to
        // this window, so they are NOT re-filtered by events.agent_id (the
        // resolving escalation/experiment event may carry no subject agent)
        ids.length > 0
          ? and(eq(events.companyId, ctx.companyId), inArray(events.id, ids))
          : and(
              eq(events.companyId, ctx.companyId),
              eq(events.agentId, input.agentId),
              significant,
            ),
      )
      // newest-first + limit, then re-ordered chronologically below: without
      // explicit ids the window is the TAIL of the agent's event stream
      .orderBy(desc(events.seq))
      .limit(limit);

    const chronological = [...rows].reverse();
    return {
      task: null,
      agent: {
        id: agent.id,
        name: agent.name,
        projectId: chronological.find((row) => row.projectId !== null)?.projectId ?? null,
      },
      events: chronological
        .filter((row): row is typeof row & { id: string } => row.id !== null)
        .map((row) => ({
          id: row.id,
          type: row.type,
          occurredAt: row.occurredAt.toISOString(),
          payloadSummary: JSON.stringify(row.payload).slice(0, 300),
        })),
    };
  }

  /**
   * pgvector cosine top-k within the candidate's EXACT scope, same embedding
   * dimension, status active|candidate (12 §5.5). Query-builder based so the
   * tenancy guard sees the company_id predicate.
   */
  async similarTopK(
    ctx: CompanyContext,
    input: { scope: string; scopeRef: string; embedding: number[]; dim: number; k?: number },
  ): Promise<SimilarMemory[]> {
    assertDimension(input.dim);
    const dimLit = sql.raw(String(input.dim));
    const qvec = vectorLiteral(input.embedding);
    const distance = sql<number>`(${memories.embedding}::vector(${dimLit}) <=> ${qvec}::vector(${dimLit}))`;
    const rows = await this.db
      .select({
        id: memories.id,
        title: memories.title,
        content: memories.content,
        summary: memories.summary,
        type: memories.type,
        status: memories.status,
        confidence: memories.confidence,
        distance,
      })
      .from(memories)
      .where(
        and(
          eq(memories.companyId, ctx.companyId),
          eq(memories.scope, input.scope),
          eq(memories.scopeRef, input.scopeRef),
          inArray(memories.status, ["active", "candidate"]),
          eq(memories.embeddingDim, input.dim),
          isNotNull(memories.embedding),
        ),
      )
      .orderBy(distance)
      .limit(input.k ?? 8);
    return rows.map(({ distance: d, ...row }) => ({ ...row, cosine: 1 - Number(d) }));
  }

  /**
   * Anti-hallucination evidence resolution (12 §5.7): event/artifact/review
   * refs must resolve to real rows (unresolvable → dropped); metric/statement
   * refs pass through (the confidence formula weighs them, 12 §5.8).
   */
  async resolveEvidence(
    ctx: CompanyContext,
    refs: EvidenceInput[],
  ): Promise<{ resolved: Required<EvidenceInput>[]; dropped: number; allFailed: boolean }> {
    const resolved: Required<EvidenceInput>[] = [];
    let dropped = 0;
    for (const ref of refs) {
      if (ref.kind === "metric" || ref.kind === "statement") {
        resolved.push({ kind: ref.kind, ref: ref.ref, weight: ref.kind === "metric" ? 1 : 0.5 });
        continue;
      }
      if (!UUID_RE.test(ref.ref)) {
        dropped += 1;
        continue;
      }
      let exists = false;
      if (ref.kind === "event") {
        const [row] = await this.db
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.companyId, ctx.companyId), eq(events.id, ref.ref)))
          .limit(1);
        exists = row !== undefined;
      } else if (ref.kind === "review") {
        const [row] = await this.db
          .select({ id: reviews.id })
          .from(reviews)
          .where(and(eq(reviews.companyId, ctx.companyId), eq(reviews.id, ref.ref)))
          .limit(1);
        exists = row !== undefined;
      } else {
        const [row] = await this.db
          .select({ id: artifacts.id })
          .from(artifacts)
          .where(and(eq(artifacts.companyId, ctx.companyId), eq(artifacts.id, ref.ref)))
          .limit(1);
        exists = row !== undefined;
      }
      if (exists) resolved.push({ kind: ref.kind, ref: ref.ref, weight: ref.weight ?? 1 });
      else dropped += 1;
    }
    return { resolved, dropped, allFailed: refs.length > 0 && resolved.length === 0 };
  }

  /**
   * Persist a surviving candidate (12 §5.9): memories row + version 1 +
   * evidence + relation rows and the outbox events, ONE transaction.
   * Company scope is structurally unreachable — hard assert (12 §5.3).
   */
  async persistCandidate(
    ctx: CompanyContext,
    input: PersistCandidateInput,
  ): Promise<{ memoryId: string; status: "active" | "candidate"; confidence: number }> {
    if (input.scope === "company") {
      throw new MemoryError(
        "MEMORY_SCOPE_FORBIDDEN",
        "consolidation can never create company-scope memory (12 §5.3; promotion only)",
      );
    }
    const hasContradiction = input.relations.some((r) => r.kind === "contradicts");
    const confidence = hasContradiction
      ? Math.min(input.confidence, CONTRADICTION_CONFIDENCE_CAP)
      : input.confidence;
    const status: "active" | "candidate" =
      input.importance >= IMPORTANCE_ACTIVE_THRESHOLD ? "active" : "candidate";

    return this.db.transaction(async (tx) => {
      const [memory] = await tx
        .insert(memories)
        .values({
          companyId: ctx.companyId,
          scope: input.scope,
          scopeRef: input.scopeRef,
          type: input.type,
          title: input.title,
          content: input.content,
          summary: input.summary,
          entities: normalizeCodeRefs(input.entities),
          importance: input.importance,
          confidence,
          status,
          sourceEventId: input.sourceEventId,
          createdByAgentId: input.createdByAgentId,
          ...(input.embedding && {
            embedding: vectorLiteral(input.embedding),
            embeddingDim: input.embedding.length,
          }),
          embeddingModel: input.embeddingModel,
        })
        .returning({ id: memories.id });
      const memoryId = memory!.id;

      await tx.insert(memoryVersions).values({
        companyId: ctx.companyId,
        memoryId,
        version: 1,
        title: input.title,
        content: input.content,
        summary: input.summary,
        importance: input.importance,
        confidence,
        status,
        changedBy: "system",
        changeReason: "consolidation",
      });

      for (const item of input.evidence) {
        const [evidenceRow] = await tx
          .insert(memoryEvidence)
          .values({
            companyId: ctx.companyId,
            memoryId,
            kind: item.kind,
            ref: item.ref,
            weight: item.weight ?? 1,
          })
          .returning({ id: memoryEvidence.id });
        await emitDomainEvent(tx, ctx, {
          type: "memory.evidence.added",
          actor: { kind: "system", id: null },
          payload: { memoryId, evidenceId: evidenceRow!.id, kind: item.kind, weight: item.weight ?? 1 },
        });
      }

      await emitDomainEvent(tx, ctx, {
        type: "memory.created",
        actor: { kind: "system", id: null },
        ...(input.createdByAgentId && { agentId: input.createdByAgentId }),
        payload: {
          memoryId,
          scope: input.scope,
          scopeRef: input.scopeRef,
          type: input.type,
          importance: input.importance,
          confidence,
          ...(input.sourceEventId && { sourceEventId: input.sourceEventId }),
        },
      });

      for (const relation of input.relations) {
        const [relationRow] = await tx
          .insert(memoryRelations)
          .values({
            companyId: ctx.companyId,
            fromMemoryId: memoryId,
            toMemoryId: relation.toMemoryId,
            kind: relation.kind,
            createdBy: "system",
          })
          .returning({ id: memoryRelations.id });
        await emitDomainEvent(tx, ctx, {
          type: "memory.relation.created",
          actor: { kind: "system", id: null },
          payload: {
            relationId: relationRow!.id,
            fromMemoryId: memoryId,
            toMemoryId: relation.toMemoryId,
            kind: relation.kind,
          },
        });
        if (relation.kind === "contradicts") {
          // both survive; never auto-resolved (12 §5.6)
          await emitDomainEvent(tx, ctx, {
            type: "memory.contradiction.detected",
            actor: { kind: "system", id: null },
            payload: { memoryIdA: memoryId, memoryIdB: relation.toMemoryId, relationId: relationRow!.id },
          });
        }
        if (relation.kind === "supersedes") {
          await tx
            .update(memories)
            .set({ status: "superseded", updatedAt: sql`now()` })
            .where(
              and(eq(memories.companyId, ctx.companyId), eq(memories.id, relation.toMemoryId)),
            );
          await emitDomainEvent(tx, ctx, {
            type: "memory.superseded",
            actor: { kind: "system", id: null },
            payload: { memoryId: relation.toMemoryId, byMemoryId: memoryId, reason: "consolidation refinement" },
          });
        }
      }

      if (input.embedding === null && input.embedFailedError !== undefined) {
        await emitDomainEvent(tx, ctx, {
          type: "memory.embedding.failed",
          actor: { kind: "system", id: null },
          payload: {
            memoryId,
            model: input.embeddingModel ?? "unknown",
            error: input.embedFailedError.slice(0, 500),
          },
        });
      }

      return { memoryId, status, confidence };
    });
  }

  /**
   * P1-B (UI/UX review): deterministic exact-duplicate probe — an ACTIVE
   * memory in the SAME scope with the SAME (case-insensitive) title. Runs
   * BEFORE the embedding spend so the fast-merge path also works in the
   * offline/scripted profile where embeddings are unavailable (the old flow
   * skipped similarity entirely on embed failure and stacked duplicates).
   */
  async findExactActive(
    ctx: CompanyContext,
    input: { scope: string; scopeRef: string | null; title: string },
  ): Promise<{ id: string } | null> {
    const [row] = await this.db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.companyId, ctx.companyId),
          eq(memories.scope, input.scope),
          input.scopeRef === null
            ? isNull(memories.scopeRef)
            : eq(memories.scopeRef, input.scopeRef),
          eq(memories.status, "active"),
          sql`lower(${memories.title}) = lower(${input.title})`,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Near-duplicate fast path + LLM-verdict duplicate merge (12 §5.5/§5.6):
   * append evidence, bump last_verified_at, keep content, new version row
   * with reason `consolidation_merge`; memory.updated in the same tx.
   */
  async mergeIntoExisting(
    ctx: CompanyContext,
    input: { memoryId: string; evidence: EvidenceInput[] },
  ): Promise<{ versionNo: number }> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(memories)
        .where(and(eq(memories.companyId, ctx.companyId), eq(memories.id, input.memoryId)))
        .for("update");
      if (!row) throw new MemoryError("MEMORY_NOT_FOUND", `memory ${input.memoryId} not found`);
      const versionNo = row.version + 1;

      await tx.insert(memoryVersions).values({
        companyId: ctx.companyId,
        memoryId: row.id,
        version: versionNo,
        title: row.title,
        content: row.content,
        summary: row.summary,
        importance: row.importance,
        confidence: row.confidence,
        status: row.status,
        changedBy: "system",
        changeReason: "consolidation_merge",
      });
      await tx
        .update(memories)
        .set({ version: versionNo, lastVerifiedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(memories.companyId, ctx.companyId), eq(memories.id, row.id)));

      const existing = await tx
        .select({ kind: memoryEvidence.kind, ref: memoryEvidence.ref })
        .from(memoryEvidence)
        .where(
          and(eq(memoryEvidence.companyId, ctx.companyId), eq(memoryEvidence.memoryId, row.id)),
        );
      const seen = new Set(existing.map((e) => `${e.kind}:${e.ref}`));
      for (const item of input.evidence) {
        if (seen.has(`${item.kind}:${item.ref}`)) continue;
        seen.add(`${item.kind}:${item.ref}`);
        const [evidenceRow] = await tx
          .insert(memoryEvidence)
          .values({
            companyId: ctx.companyId,
            memoryId: row.id,
            kind: item.kind,
            ref: item.ref,
            weight: item.weight ?? 1,
          })
          .returning({ id: memoryEvidence.id });
        await emitDomainEvent(tx, ctx, {
          type: "memory.evidence.added",
          actor: { kind: "system", id: null },
          payload: {
            memoryId: row.id,
            evidenceId: evidenceRow!.id,
            kind: item.kind,
            weight: item.weight ?? 1,
          },
        });
      }

      await emitDomainEvent(tx, ctx, {
        type: "memory.updated",
        actor: { kind: "system", id: null },
        payload: { memoryId: row.id, versionNo },
      });
      return { versionNo };
    });
  }

  /**
   * Founder memory edit / archive (12 §8.8, T48): every action writes a
   * memory_versions row (changed_by founder), an audit_log row (S7) and emits
   * memory.updated / memory.archived. Hard delete does not exist.
   */
  async founderUpdate(
    ctx: CompanyContext,
    memoryId: string,
    input: {
      byUserId: string;
      title?: string | undefined;
      content?: string | undefined;
      importance?: number | undefined;
      archive?: boolean | undefined;
      note?: string | undefined;
    },
  ): Promise<{ versionNo: number; status: string }> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(memories)
        .where(and(eq(memories.companyId, ctx.companyId), eq(memories.id, memoryId)))
        .for("update");
      if (!row) throw new MemoryError("MEMORY_NOT_FOUND", `memory ${memoryId} not found`);
      const title = input.title ?? row.title;
      const content = input.content ?? row.content;
      const importance = input.importance ?? row.importance;
      const status = input.archive ? "archived" : row.status;
      const versionNo = row.version + 1;
      await tx
        .update(memories)
        .set({ title, content, importance, status, version: versionNo, updatedAt: sql`now()` })
        .where(and(eq(memories.companyId, ctx.companyId), eq(memories.id, memoryId)));
      await tx.insert(memoryVersions).values({
        companyId: ctx.companyId,
        memoryId,
        version: versionNo,
        title,
        content,
        summary: row.summary,
        importance,
        confidence: row.confidence,
        status,
        changedBy: "founder",
        changeReason: input.archive
          ? `founder_archive${input.note ? `: ${input.note.slice(0, 300)}` : ""}`
          : `founder_edit${input.note ? `: ${input.note.slice(0, 300)}` : ""}`,
      });
      await tx.insert(auditLog).values({
        companyId: ctx.companyId,
        actorKind: "user",
        actorId: input.byUserId,
        action: input.archive ? "memory.founder_archive" : "memory.founder_edit",
        targetKind: "memory",
        targetId: memoryId,
        meta: { versionNo },
      });
      if (input.archive) {
        await emitDomainEvent(tx, ctx, {
          type: "memory.archived",
          actor: { kind: "founder", id: null },
          payload: { memoryId, reason: input.note ?? "founder archive" },
        });
      } else {
        await emitDomainEvent(tx, ctx, {
          type: "memory.updated",
          actor: { kind: "founder", id: null },
          payload: { memoryId, versionNo },
        });
      }
      return { versionNo, status };
    });
  }

  /** Run report event (12 §5.10) — catalog payload shape (10 §8). */
  async completeRun(
    ctx: CompanyContext,
    input: {
      batchId: string;
      taskId?: string | undefined;
      extracted: number;
      persisted: number;
      merged: number;
      discarded: number;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await emitDomainEvent(tx, ctx, {
        type: "memory.consolidation.completed",
        actor: { kind: "system", id: null },
        ...(input.taskId && { taskId: input.taskId }),
        payload: {
          batchId: input.batchId,
          candidates: input.extracted,
          persisted: input.persisted,
          merged: input.merged,
          discarded: input.discarded,
        },
      });
    });
  }
}
