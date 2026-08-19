// Gap-free per-company counters (10 §3, 20 §3.4): the counter row is locked
// (UPDATE … RETURNING) inside the SAME transaction as the row consuming the
// number — rollback rolls the counter back too, so no gaps ever.
import { sql } from "drizzle-orm";
import type { CompanyContext } from "./context.js";
import type { Tx } from "./outbox.js";

export type SequenceName =
  | "event_seq"
  | "task_number"
  | "employee_number"
  | "decision_number"
  | "incident_number"
  | "approval_number";

/** Reserves `count` consecutive values; returns the first of the block. */
export async function nextSequenceBlock(
  tx: Tx,
  ctx: CompanyContext,
  name: SequenceName,
  count: number,
): Promise<number> {
  await tx.execute(
    sql`INSERT INTO company_sequences (company_id, name, value) VALUES (${ctx.companyId}, ${name}, 0) ON CONFLICT DO NOTHING`,
  );
  const result = await tx.execute(
    sql`UPDATE company_sequences SET value = value + ${count} WHERE company_id = ${ctx.companyId} AND name = ${name} RETURNING value`,
  );
  const value = Number((result.rows[0] as { value: string | number }).value);
  return value - count + 1;
}

export async function nextSequenceValue(
  tx: Tx,
  ctx: CompanyContext,
  name: SequenceName,
): Promise<number> {
  return nextSequenceBlock(tx, ctx, name, 1);
}
