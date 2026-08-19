// T30 acceptance: the canonical backend-dev.task-implement.yaml loads and
// drives a scripted sequence (branches honored); a schema-drifted script
// fails AT LOAD; pseudo-embeddings are deterministic content-hash vectors.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentActionSchema } from "../agent-action.js";
import { pseudoEmbedding, cannedConsolidation } from "./embeddings.js";
import {
  ScriptLoadError,
  ScriptedSession,
  createScriptedAdapter,
  loadScript,
} from "./scripted.js";

const CANONICAL = readFileSync(
  join(__dirname, "../../testing/scripts/backend-dev.task-implement.yaml"),
  "utf8",
);
const TASK_ID = "018f0000-0000-7000-8000-00000000aaaa";

describe("canonical script (32 §6.1)", () => {
  it("loads, validates every step against the AgentAction union", () => {
    const script = loadScript(CANONICAL);
    expect(script.match).toEqual({ role: "backend-dev", taskFixture: "implement-feature" });
    expect(script.steps).toHaveLength(7);
  });

  it("drives the happy-path sequence (green tests, no review signal)", () => {
    const session = new ScriptedSession(loadScript(CANONICAL), { taskId: TASK_ID });
    const actions = [];
    for (;;) {
      const action = session.next({ lastToolResult: { exitCode: 0 } });
      if (!action) break;
      actions.push(action);
    }
    // nonzero-branch fix step and changes_requested fix step are both skipped
    expect(actions.map((a) => a.type)).toEqual([
      "update_task_status",
      "use_tool",
      "use_tool",
      "request_review",
      "complete_task",
    ]);
    expect(actions[0]).toMatchObject({ taskId: TASK_ID, to: "IN_PROGRESS" });
    expect(actions[1]).toMatchObject({
      tool: "write_file",
      input: { path: "src/export/csv.ts", contentRef: "fixture:csv-impl-v1" },
    });
    for (const action of actions) expect(() => AgentActionSchema.parse(action)).not.toThrow();
  });

  it("takes the nonzero-exit branch and the changes_requested signal branch", () => {
    const session = new ScriptedSession(loadScript(CANONICAL), { taskId: TASK_ID });
    session.next(); // IN_PROGRESS
    session.next(); // write v1
    session.next(); // npm test
    const fix = session.next({ lastToolResult: { exitCode: 1 } }); // branch taken
    expect(fix).toMatchObject({ type: "use_tool", input: { contentRef: "fixture:csv-impl-v2" } });
    session.next(); // request_review
    const rework = session.next({ signals: { reviewVerdict: "changes_requested" } });
    expect(rework).toMatchObject({ type: "use_tool", input: { contentRef: "fixture:csv-impl-v3" } });
    const done = session.next();
    expect(done).toMatchObject({ type: "complete_task" });
    expect(session.exhausted).toBe(true);
  });
});

describe("schema drift fails at load (the honesty guarantee)", () => {
  it("unknown action type explodes", () => {
    expect(() =>
      loadScript(
        `match: { role: r, taskFixture: f }\nsteps:\n  - action: request_reviews\n    args: {}\n`,
      ),
    ).toThrow(ScriptLoadError);
  });

  it("a drifted enum value explodes", () => {
    expect(() =>
      loadScript(
        `match: { role: r, taskFixture: f }\nsteps:\n  - action: update_task_status\n    args: { status: DOING }\n`,
      ),
    ).toThrow(/drifts from the AgentAction schema/);
  });

  it("a malformed wait_for target explodes", () => {
    expect(() =>
      loadScript(
        `match: { role: r, taskFixture: f }\nsteps:\n  - action: wait_for\n    args: { what: vibes }\n`,
      ),
    ).toThrow(ScriptLoadError);
  });

  it("missing match block explodes", () => {
    expect(() => loadScript(`steps:\n  - action: think\n    args: { thought: hi }\n`)).toThrow(
      /invalid script shape/,
    );
  });
});

describe("scripted adapter (port-compatible)", () => {
  it("matches on role/taskFixture markers and returns parseable AgentAction JSON", async () => {
    const adapter = createScriptedAdapter([loadScript(CANONICAL)], { taskId: TASK_ID });
    const result = await adapter.complete({
      model: "scripted",
      messages: [
        { role: "system", content: "[role:backend-dev] [taskFixture:implement-feature]" },
        { role: "user", content: "next step?" },
      ],
    });
    const action = AgentActionSchema.parse(JSON.parse(result.text));
    expect(action).toMatchObject({ type: "update_task_status", to: "IN_PROGRESS" });
  });

  it("refuses unknown fixtures loudly", async () => {
    const adapter = createScriptedAdapter([loadScript(CANONICAL)]);
    await expect(
      adapter.complete({
        model: "scripted",
        messages: [{ role: "user", content: "[role:ceo] [taskFixture:unknown]" }],
      }),
    ).rejects.toThrow(/no script matches/);
  });
});

describe("pseudo-embeddings + canned consolidation (32 §6)", () => {
  it("is deterministic, content-sensitive and L2-normalized", () => {
    const a1 = pseudoEmbedding("CSV export streaming");
    const a2 = pseudoEmbedding("CSV export streaming");
    const b = pseudoEmbedding("completely different text");
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
    expect(a1).toHaveLength(768);
    expect(pseudoEmbedding("x", 1536)).toHaveLength(1536);
    const norm = Math.sqrt(a1.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("returns stable canned consolidation shapes", () => {
    const canned = cannedConsolidation("csv-implementation");
    expect(canned.memories.length).toBeGreaterThan(0);
    expect(canned.memories[0]).toHaveProperty("importance");
  });

  // M3: an unknown fixture must produce NOTHING. The old fallback invented a
  // "Consolidated: <key>" row with importance 0.5 — above the discard
  // threshold — so every real task run in scripted mode stored a fabricated
  // memory that looked exactly like a learned one in the panel.
  it("invents no memory for an unknown fixture (scripted mode does not learn)", () => {
    expect(cannedConsolidation("anything-else").memories).toHaveLength(0);
    expect(cannedConsolidation("none").memories).toHaveLength(0);
  });
});
