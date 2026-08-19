// Event catalog machinery (10 §4, §8, §10): defineEvent registers a
// (type, version) → Zod payload schema; producers validate before insert,
// consumers route by handled versions.
import { z } from "zod";

export const EVENT_TYPE_PATTERN = /^[a-z]+(\.[a-z_]+){1,3}$/;

export interface EventDefinition<P extends z.ZodType = z.ZodType> {
  readonly type: string;
  readonly version: number;
  readonly payload: P;
  /** true only for workspace.terminal.output — NATS ephemeral, never the events table. */
  readonly ephemeral: boolean;
}

const registry = new Map<string, EventDefinition>();

export const eventKey = (type: string, version: number): string => `${type}@v${version}`;

export function defineEvent<P extends z.ZodType>(definition: {
  type: string;
  version: number;
  payload: P;
  ephemeral?: boolean;
}): EventDefinition<P> {
  if (!EVENT_TYPE_PATTERN.test(definition.type)) {
    throw new Error(`event type "${definition.type}" violates domain.entity.action naming`);
  }
  const key = eventKey(definition.type, definition.version);
  if (registry.has(key)) {
    throw new Error(`duplicate event definition: ${key}`);
  }
  const entry: EventDefinition<P> = {
    type: definition.type,
    version: definition.version,
    payload: definition.payload,
    ephemeral: definition.ephemeral ?? false,
  };
  registry.set(key, entry);
  return entry;
}

export function getEventDefinition(type: string, version = 1): EventDefinition | undefined {
  return registry.get(eventKey(type, version));
}

/** Unique event types (all versions collapsed). */
export function knownEventTypes(): string[] {
  return [...new Set([...registry.values()].map((d) => d.type))].sort();
}

export function knownDurableEventTypes(): string[] {
  return [...new Set([...registry.values()].filter((d) => !d.ephemeral).map((d) => d.type))].sort();
}

export function knownEphemeralEventTypes(): string[] {
  return [...new Set([...registry.values()].filter((d) => d.ephemeral).map((d) => d.type))].sort();
}

export function isHandledVersion(handledVersions: readonly number[], version: number): boolean {
  return handledVersions.includes(version);
}

/** Validates a payload against its catalog schema; throws on unknown type or mismatch. */
export function parseEventPayload(type: string, version: number, payload: unknown): unknown {
  const definition = getEventDefinition(type, version);
  if (!definition) {
    throw new Error(`unknown event type/version: ${eventKey(type, version)}`);
  }
  return definition.payload.parse(payload);
}
