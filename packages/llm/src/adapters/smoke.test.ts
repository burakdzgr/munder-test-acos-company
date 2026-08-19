// Adapter smoke (T29 acceptance — behind an env flag, NOT run in CI):
//   LLM_SMOKE=1 ANTHROPIC_API_KEY=... pnpm --filter @acos/llm test
// Hits the real provider once through the full router path.
import { describe, expect, it } from "vitest";
import { ModelRouter } from "../router.js";
import { createAnthropicAdapter } from "./ai-sdk.js";
import type { LlmCallLogEntry } from "../types.js";

const smokeEnabled = process.env.LLM_SMOKE === "1" && Boolean(process.env.ANTHROPIC_API_KEY);

describe.skipIf(!smokeEnabled)("anthropic adapter smoke (LLM_SMOKE=1)", () => {
  it("completes a trivial prompt through the router with accounting", async () => {
    const log: LlmCallLogEntry[] = [];
    const router = new ModelRouter({
      providers: new Map([
        ["anthropic", createAnthropicAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! })],
      ]),
      logCall: (entry) => {
        log.push(entry);
      },
      defaultMaxTokens: 64,
    });
    const result = await router.complete(
      {
        purpose: "fast",
        messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
      },
      {
        bindings: [],
        profiles: [
          { purpose: "fast", providerId: "anthropic", model: "claude-haiku-4-5-20251001" },
        ],
      },
    );
    expect(result.text.toLowerCase()).toContain("pong");
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(log[0]).toMatchObject({ status: "ok", providerId: "anthropic" });
  }, 60_000);
});

describe.skipIf(smokeEnabled)("smoke placeholder", () => {
  it("is skipped unless LLM_SMOKE=1 with a provider key", () => {
    expect(smokeEnabled).toBe(false);
  });
});
