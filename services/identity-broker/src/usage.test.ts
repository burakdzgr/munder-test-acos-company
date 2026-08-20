import { describe, expect, it } from "vitest";
import { MAX_PARSE_BYTES, UsageAccumulator } from "./usage.js";

const sse = (events: unknown[]) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");

describe("UsageAccumulator — meter what upstream billed (session-level llm_calls)", () => {
  it("merges message_start (input side) + message_delta (output side) from an SSE stream, across chunk boundaries", () => {
    const acc = new UsageAccumulator("text/event-stream");
    const body = sse([
      {
        type: "message_start",
        message: {
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 901, output_tokens: 1, cache_creation_input_tokens: 7, cache_read_input_tokens: 4000 },
        },
      },
      { type: "content_block_delta", delta: { text: "hi" } },
      { type: "message_delta", usage: { output_tokens: 47 } },
      { type: "message_stop" },
    ]);
    // feed in awkward 17-byte chunks so lines split mid-JSON
    for (let i = 0; i < body.length; i += 17) acc.push(body.slice(i, i + 17));
    expect(acc.result()).toEqual({
      model: "claude-sonnet-4-5",
      usage: { inputTokens: 901, outputTokens: 47, cacheCreationInputTokens: 7, cacheReadInputTokens: 4000 },
    });
  });

  it("parses a non-streaming JSON body", () => {
    const acc = new UsageAccumulator("application/json");
    acc.push(JSON.stringify({ model: "claude-haiku-4-5", usage: { input_tokens: 3, output_tokens: 9 } }));
    expect(acc.result()).toEqual({
      model: "claude-haiku-4-5",
      usage: { inputTokens: 3, outputTokens: 9, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    });
  });

  it("returns null usage for error bodies / garbage without throwing", () => {
    const acc = new UsageAccumulator("application/json");
    acc.push('{"type":"error","error":{"type":"authentication_error"}}');
    expect(acc.result()).toEqual({ model: null, usage: null });
    const acc2 = new UsageAccumulator("text/html");
    acc2.push("<html>nope</html>");
    expect(acc2.result()).toEqual({ model: null, usage: null });
  });

  it("stops buffering past MAX_PARSE_BYTES (memory bound) but does not throw", () => {
    const acc = new UsageAccumulator("text/event-stream");
    acc.push(Buffer.alloc(MAX_PARSE_BYTES + 1, 0x61));
    acc.push(sse([{ type: "message_delta", usage: { output_tokens: 5 } }]));
    expect(() => acc.result()).not.toThrow();
  });
});
