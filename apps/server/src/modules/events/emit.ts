// T22: the single emission path for server modules. Every domain event is
// validated against the @acos/events catalog BEFORE it is appended to the
// outbox — an uncatalogued type or a payload that fails its schema aborts the
// surrounding transaction, so state changes can never commit with an
// unparseable event (10 §10 producer contract).
import { parseEventPayload } from "@acos/events";
import {
  appendEvents,
  type AppendedEvent,
  type CompanyContext,
  type NewEventInput,
  type Tx,
} from "@acos/db";

export async function emitDomainEvent(
  tx: Tx,
  ctx: CompanyContext,
  input: NewEventInput,
): Promise<AppendedEvent> {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}
