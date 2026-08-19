import { describe, expect, it } from "vitest";
import { parseMemoryCandidates } from "./memory-candidate.js";

const candidate = {
  type: "semantic",
  title: "Bridge latency budget",
  content: "claude-cli-bridge exec budget is 180s; activity ceilings must exceed it.",
  summary: "Bridge exec budget is 180s.",
  entities: { files: ["scripts/claude-cli-bridge.mjs"] },
  suggested_scope: "project",
  scope_rationale: "runtime infra fact",
  importance: 0.7,
  importance_rationale: "kills sessions when violated",
  confidence: 0.9,
  confidence_rationale: "observed live",
  evidence_refs: [{ kind: "event", ref: "01a01a28-0000-7000-8000-000000000001" }],
};

describe("parseMemoryCandidates", () => {
  it("accepts a bare JSON array", () => {
    expect(parseMemoryCandidates(JSON.stringify([candidate]))).toHaveLength(1);
  });

  it("accepts a {candidates:[...]} envelope", () => {
    expect(parseMemoryCandidates(JSON.stringify({ candidates: [candidate] }))).toHaveLength(1);
  });

  it("accepts a fenced markdown block", () => {
    expect(parseMemoryCandidates("```json\n" + JSON.stringify([candidate]) + "\n```")).toHaveLength(1);
  });

  // canlı arıza 2026-08-19: model diziyi bir kez daha sardı ve konsolidasyon
  // "expected object, received array" ile düştü
  it("unwraps a double-wrapped array", () => {
    expect(parseMemoryCandidates(JSON.stringify([[candidate]]))).toHaveLength(1);
  });

  it("unwraps a double-wrapped candidates envelope", () => {
    expect(parseMemoryCandidates(JSON.stringify({ candidates: [[candidate]] }))).toHaveLength(1);
  });

  it("wraps a bare single-candidate object", () => {
    expect(parseMemoryCandidates(JSON.stringify(candidate))).toHaveLength(1);
  });

  it("still rejects schema-invalid candidates strictly", () => {
    expect(() => parseMemoryCandidates(JSON.stringify([{ ...candidate, evidence_refs: [] }]))).toThrow();
  });

  it("returns [] for an unrecognized object shape", () => {
    expect(parseMemoryCandidates(JSON.stringify({ note: "nothing" }))).toEqual([]);
  });
});
