// Idempotency-key helper (20 §2.7, 21 §3.6): POST endpoints record their
// response under (company, key, endpoint); replays return the stored result.
import { and, eq, sql } from "drizzle-orm";
import { idempotencyKeys } from "./schema/companies.js";
import type { Tx } from "./outbox.js";
import type { CompanyContext } from "./context.js";

export type IdempotencyStart =
  | { kind: "fresh" }
  | { kind: "in_flight" }
  | { kind: "replay"; responseStatus: number; responseBody: unknown }
  | { kind: "mismatch" };

export interface IdempotencyRequest {
  readonly key: string;
  readonly endpoint: string;
  readonly requestHash: string;
}

/** Claims the key or reports its current state. */
export async function beginIdempotent(
  tx: Tx,
  ctx: CompanyContext,
  request: IdempotencyRequest,
): Promise<IdempotencyStart> {
  const inserted = await tx
    .insert(idempotencyKeys)
    .values({
      companyId: ctx.companyId,
      key: request.key,
      endpoint: request.endpoint,
      requestHash: request.requestHash,
      lockedAt: sql`now()`,
    })
    .onConflictDoNothing()
    .returning({ id: idempotencyKeys.id });
  if (inserted.length > 0) return { kind: "fresh" };

  const [existing] = await tx
    .select()
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.companyId, ctx.companyId),
        eq(idempotencyKeys.key, request.key),
        eq(idempotencyKeys.endpoint, request.endpoint),
      ),
    );
  if (!existing) return { kind: "in_flight" };
  if (existing.requestHash !== request.requestHash) return { kind: "mismatch" };
  if (existing.responseStatus === null) return { kind: "in_flight" };
  return {
    kind: "replay",
    responseStatus: existing.responseStatus,
    responseBody: existing.responseBody,
  };
}

/** Records the response for future replays. */
export async function completeIdempotent(
  tx: Tx,
  ctx: CompanyContext,
  request: Pick<IdempotencyRequest, "key" | "endpoint">,
  responseStatus: number,
  responseBody: unknown,
): Promise<void> {
  await tx
    .update(idempotencyKeys)
    .set({ responseStatus, responseBody })
    .where(
      and(
        eq(idempotencyKeys.companyId, ctx.companyId),
        eq(idempotencyKeys.key, request.key),
        eq(idempotencyKeys.endpoint, request.endpoint),
      ),
    );
}
