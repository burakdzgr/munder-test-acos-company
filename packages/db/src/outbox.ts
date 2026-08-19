// Transactional outbox (10 §3–4, _DECISIONS §9): events are appended in the
// SAME transaction as the state change, with gap-free per-company seq. A
// pg_notify('acos_outbox') fires on commit to wake the relay (T21).
import { sql } from "drizzle-orm";
import { uuidv7 } from "@acos/domain";
import { events } from "./schema/events.js";
import type { GuardedDb } from "./tenant.js";
import type { CompanyContext } from "./context.js";
import { nextSequenceBlock } from "./sequences.js";

/** Drizzle transaction handle (works for guarded and system dbs alike). */
export type Tx = Parameters<Parameters<GuardedDb["transaction"]>[0]>[0];

export interface EventActor {
  readonly kind: "agent" | "founder" | "system";
  readonly id: string | null;
}

export interface NewEventInput {
  readonly type: string;
  readonly version?: number;
  readonly actor: EventActor;
  readonly taskId?: string | null;
  readonly projectId?: string | null;
  readonly agentId?: string | null;
  readonly correlationId?: string | null;
  readonly causationId?: string | null;
  readonly payload: unknown;
}

export interface AppendedEvent {
  readonly id: string;
  readonly companyId: string;
  readonly seq: number;
  readonly type: string;
}

const TYPE_PATTERN = /^[a-z]+(\.[a-z_]+){1,3}$/;

/**
 * Appends a batch of events with consecutive seq values. Payload-vs-catalog
 * validation is wired by callers via @acos/events (T14/T21).
 */
export async function appendEvents(
  tx: Tx,
  ctx: CompanyContext,
  inputs: readonly NewEventInput[],
): Promise<AppendedEvent[]> {
  if (inputs.length === 0) return [];
  for (const input of inputs) {
    if (!TYPE_PATTERN.test(input.type)) {
      throw new Error(`event type "${input.type}" violates domain.entity.action naming`);
    }
  }
  const firstSeq = await nextSequenceBlock(tx, ctx, "event_seq", inputs.length);
  const rows = inputs.map((input, i) => ({
    id: uuidv7(),
    companyId: ctx.companyId,
    seq: firstSeq + i,
    type: input.type,
    version: input.version ?? 1,
    actor: input.actor,
    taskId: input.taskId ?? null,
    projectId: input.projectId ?? null,
    agentId: input.agentId ?? null,
    correlationId: input.correlationId ?? null,
    causationId: input.causationId ?? null,
    payload: input.payload,
  }));
  await tx.insert(events).values(rows);
  // NOTIFY is delivered on COMMIT — exactly the outbox wake-up semantics we want.
  await tx.execute(sql`SELECT pg_notify('acos_outbox', ${ctx.companyId})`);
  return rows.map((r) => ({ id: r.id, companyId: r.companyId, seq: r.seq, type: r.type }));
}

/** Single-event convenience — the `withOutbox(tx, event)` of 28 §2. */
export async function withOutbox(
  tx: Tx,
  ctx: CompanyContext,
  input: NewEventInput,
): Promise<AppendedEvent> {
  const [appended] = await appendEvents(tx, ctx, [input]);
  return appended!;
}
