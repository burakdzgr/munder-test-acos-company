import { describe, expect, it } from "vitest";
import {
  companySubjectWildcard,
  defineEvent,
  eventKey,
  EventEnvelopeSchema,
  getEventDefinition,
  isHandledVersion,
  parseEventPayload,
  parseSubject,
  subjectFor,
} from "./index.js";
import { z } from "zod";

const UUID = "018f0000-0000-7000-8000-000000000001";

describe("EventEnvelope (10 §4)", () => {
  const envelope = {
    id: UUID,
    companyId: UUID,
    seq: 42,
    type: "task.status.changed",
    version: 1,
    occurredAt: "2026-08-11T00:00:00Z",
    actor: { kind: "agent", id: UUID },
    subject: { taskId: UUID, projectId: null, agentId: UUID },
    correlationId: UUID,
    causationId: null,
    payload: {},
  };

  it("parses a valid envelope", () => {
    expect(() => EventEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it("rejects bad type names and non-positive seq", () => {
    expect(() => EventEnvelopeSchema.parse({ ...envelope, type: "BadName" })).toThrow();
    expect(() => EventEnvelopeSchema.parse({ ...envelope, seq: 0 })).toThrow();
  });
});

describe("subjects (co.<companyId>.<type>)", () => {
  it("builds and parses round-trip", () => {
    const subject = subjectFor(UUID, "agent.hired");
    expect(subject).toBe(`co.${UUID}.agent.hired`);
    expect(parseSubject(subject)).toEqual({ companyId: UUID, eventType: "agent.hired" });
    expect(companySubjectWildcard(UUID)).toBe(`co.${UUID}.>`);
    expect(parseSubject("nats.other")).toBeNull();
  });
});

describe("defineEvent registry", () => {
  it("rejects duplicates and bad names", () => {
    defineEvent({ type: "test.thing.happened", version: 7, payload: z.object({}) });
    expect(() =>
      defineEvent({ type: "test.thing.happened", version: 7, payload: z.object({}) }),
    ).toThrow("duplicate");
    expect(() =>
      defineEvent({ type: "NotValid", version: 1, payload: z.object({}) }),
    ).toThrow("naming");
  });

  it("versions route independently", () => {
    expect(eventKey("a.b", 2)).toBe("a.b@v2");
    expect(getEventDefinition("task.status.changed", 1)).toBeDefined();
    expect(getEventDefinition("task.status.changed", 99)).toBeUndefined();
    expect(isHandledVersion([1, 2], 2)).toBe(true);
    expect(isHandledVersion([1], 2)).toBe(false);
    expect(() => parseEventPayload("no.such.type", 1, {})).toThrow("unknown");
  });
});
