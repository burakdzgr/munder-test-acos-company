// Consumer idempotency (10 §6): per-consumer, per-company last_seq
// high-water-mark — events arrive in per-company order on one consumer, so
// `seq <= last_seq → skip` suffices for single-writer consumers.
import { sql } from "drizzle-orm";
import type { Db } from "@acos/db";

export type DedupeOutcome = "processed" | "skipped";

/**
 * Runs `handler` exactly once per (consumer, companyId, seq): the HWM row is
 * locked, compared, and advanced in the SAME transaction as the handler's
 * side effects.
 */
export async function withSeqDedupe(
  db: Db,
  consumer: string,
  event: { companyId: string; seq: number },
  handler: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<void>,
): Promise<DedupeOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`INSERT INTO consumer_offsets (consumer, company_id, last_seq)
          VALUES (${consumer}, ${event.companyId}, 0)
          ON CONFLICT DO NOTHING`,
    );
    const result = await tx.execute(
      sql`SELECT last_seq FROM consumer_offsets
          WHERE consumer = ${consumer} AND company_id = ${event.companyId}
          FOR UPDATE`,
    );
    const lastSeq = Number((result.rows[0] as { last_seq: string | number }).last_seq);
    if (event.seq <= lastSeq) return "skipped";
    await handler(tx);
    await tx.execute(
      sql`UPDATE consumer_offsets SET last_seq = ${event.seq}, updated_at = now()
          WHERE consumer = ${consumer} AND company_id = ${event.companyId}`,
    );
    return "processed";
  });
}
