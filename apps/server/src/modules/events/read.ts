// T22 timeline read model (21 §3.11): cursor-paginated timeline (seq desc),
// deterministic replay (seq asc — the WS resume fallback of 22 §), single
// envelope fetch. All queries run on the guarded db (company_id in WHERE).
import { and, eq, gt, lt, sql, type SQL } from "drizzle-orm";
import type { CompanyContext, GuardedDb } from "@acos/db";
import { events } from "@acos/db/schema";

export interface EventEnvelopeDto {
  id: string;
  companyId: string;
  seq: number;
  type: string;
  version: number;
  occurredAt: string;
  actor: { kind: "agent" | "founder" | "system"; id: string | null };
  subject: { taskId: string | null; projectId: string | null; agentId: string | null };
  correlationId: string;
  causationId: string | null;
  payload: unknown;
}

export interface TimelineFilters {
  types?: string[] | undefined;
  actorKind?: string | undefined;
  actorId?: string | undefined;
  taskId?: string | undefined;
  projectId?: string | undefined;
  agentId?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

type EventRow = typeof events.$inferSelect;

/** Same row → envelope mapping the relay publishes (10 §4). */
export function toEnvelope(row: EventRow): EventEnvelopeDto {
  // id is app-side UUIDv7, always set; the column reads as nullable only
  // because the composite PK is declared at the table level.
  return {
    id: row.id!,
    companyId: row.companyId,
    seq: Number(row.seq),
    type: row.type,
    version: row.version,
    occurredAt: row.occurredAt.toISOString(),
    actor: row.actor as EventEnvelopeDto["actor"],
    subject: { taskId: row.taskId, projectId: row.projectId, agentId: row.agentId },
    correlationId: row.correlationId ?? row.id!, // root events correlate to themselves
    causationId: row.causationId,
    payload: row.payload,
  };
}

export const encodeCursor = (seq: number): string =>
  Buffer.from(String(seq), "utf8").toString("base64url");

export function decodeCursor(cursor: string): number | null {
  const seq = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

function filterConditions(ctx: CompanyContext, filters: TimelineFilters): SQL[] {
  const conditions: SQL[] = [eq(events.companyId, ctx.companyId) as SQL];
  if (filters.types && filters.types.length > 0) {
    const perType = filters.types.map((t) =>
      t.endsWith(".*")
        ? sql`${events.type} LIKE ${t.slice(0, -1) + "%"}`
        : sql`${events.type} = ${t}`,
    );
    conditions.push(sql`(${sql.join(perType, sql` OR `)})`);
  }
  if (filters.actorKind) conditions.push(sql`${events.actor}->>'kind' = ${filters.actorKind}`);
  if (filters.actorId) conditions.push(sql`${events.actor}->>'id' = ${filters.actorId}`);
  if (filters.taskId) conditions.push(eq(events.taskId, filters.taskId) as SQL);
  if (filters.projectId) conditions.push(eq(events.projectId, filters.projectId) as SQL);
  if (filters.agentId) conditions.push(eq(events.agentId, filters.agentId) as SQL);
  if (filters.from) conditions.push(sql`${events.occurredAt} >= ${filters.from}`);
  if (filters.to) conditions.push(sql`${events.occurredAt} <= ${filters.to}`);
  return conditions;
}

export class EventsReadService {
  constructor(private readonly db: GuardedDb) {}

  /** Timeline — newest first, cursor keyed on seq (21 §2.4). */
  async list(
    ctx: CompanyContext,
    filters: TimelineFilters,
    limit: number,
    cursor?: string | undefined,
  ): Promise<{ items: EventEnvelopeDto[]; nextCursor: string | null }> {
    const conditions = filterConditions(ctx, filters);
    if (cursor !== undefined) {
      const cursorSeq = decodeCursor(cursor);
      if (cursorSeq === null) return { items: [], nextCursor: null };
      conditions.push(lt(events.seq, cursorSeq) as SQL);
    }
    const rows = await this.db
      .select()
      .from(events)
      .where(and(...conditions))
      .orderBy(sql`${events.seq} DESC`)
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeCursor(Number(page[page.length - 1]!.seq)) : null;
    return { items: page.map(toEnvelope), nextCursor };
  }

  /** Replay — seq asc from a watermark; `nextSeq` feeds the next call. */
  async replay(
    ctx: CompanyContext,
    afterSeq: number,
    limit: number,
  ): Promise<{ items: EventEnvelopeDto[]; nextSeq: number }> {
    const rows = await this.db
      .select()
      .from(events)
      .where(and(eq(events.companyId, ctx.companyId), gt(events.seq, afterSeq)))
      .orderBy(sql`${events.seq} ASC`)
      .limit(limit);
    const items = rows.map(toEnvelope);
    return { items, nextSeq: items.length > 0 ? items[items.length - 1]!.seq : afterSeq };
  }

  async get(ctx: CompanyContext, eventId: string): Promise<EventEnvelopeDto | undefined> {
    const [row] = await this.db
      .select()
      .from(events)
      .where(and(eq(events.companyId, ctx.companyId), eq(events.id, eventId)));
    return row ? toEnvelope(row) : undefined;
  }
}
