// Crash-replay determinism net (32 §3, 09 §7, T36): the golden histories in
// test/histories/ replay against HEAD workflow code offline
// (Worker.runReplayHistories — no Temporal server). Any nondeterministic
// change to agentTaskWorkflow fails here BEFORE it can strand in-flight
// runs; intended changes regenerate the histories via gen:histories.
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import proto from "@temporalio/proto";
const { temporal } = proto;
import { Worker } from "@temporalio/worker";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../../src/workflows/index.ts");
const historiesDir = join(dirname(fileURLToPath(import.meta.url)), "../histories");

describe("golden replay histories (T36)", () => {
  const files = readdirSync(historiesDir).filter((f) => f.endsWith(".bin"));

  it("has the checked-in golden set", () => {
    expect(files.sort()).toEqual(["approval-escalate.bin", "toolless-review.bin"]);
  });

  it("every history replays against HEAD without nondeterminism", async () => {
    const histories = files.map((file) => ({
      workflowId: `golden.${file.replace(/\.bin$/, "")}`,
      history: temporal.api.history.v1.History.decodeDelimited(
        readFileSync(join(historiesDir, file)),
      ),
    }));
    const results = [];
    for await (const result of Worker.runReplayHistories({ workflowsPath }, histories)) {
      results.push(result);
    }
    expect(results).toHaveLength(files.length);
    for (const result of results) {
      expect(result.error, `${result.workflowId} must replay cleanly`).toBeUndefined();
    }
  }, 120_000);
});
