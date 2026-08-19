import { describe, expect, it } from "vitest";
import { RING_BYTES, TerminalSession, type TerminalLogSink, type TerminalTransport } from "./terminal.js";
import type { SandboxTerminalFrame } from "@acos/contracts";

function harness() {
  const published: Array<{ sessionId: string; frame: SandboxTerminalFrame }> = [];
  const logged: string[] = [];
  const transport: TerminalTransport = {
    publish: (sessionId, frame) => published.push({ sessionId, frame }),
  };
  const log: TerminalLogSink = { append: (_id, line) => logged.push(line) };
  let clock = 1_000;
  const session = new TerminalSession("sess-1", transport, log, () => (clock += 1));
  return { session, published, logged };
}

describe("TerminalSession framing (22 §4/5.2)", () => {
  it("assigns monotonic seq + ts, base64-encodes, publishes and logs each frame", () => {
    const { session, published, logged } = harness();
    const f1 = session.emit("stdout", "hello");
    const f2 = session.emit("stderr", Buffer.from("oops"));
    expect(f1).toMatchObject({ seq: 1, stream: "stdout", data: Buffer.from("hello").toString("base64") });
    expect(f2).toMatchObject({ seq: 2, stream: "stderr", data: Buffer.from("oops").toString("base64") });
    expect(f2.ts).toBeGreaterThan(f1.ts);
    expect(published.map((p) => p.frame.seq)).toEqual([1, 2]);
    expect(logged).toHaveLength(2);
    expect(JSON.parse(logged[0]!)).toMatchObject({ seq: 1 });
  });

  it("ring drops oldest past 64 KB but keeps publishing every frame", () => {
    const { session, published } = harness();
    const chunk = "x".repeat(8 * 1024); // 8 KB per frame
    for (let i = 0; i < 12; i++) session.emit("stdout", chunk); // 96 KB total
    // publish is loss-tolerant only at the transport — every frame went out
    expect(published).toHaveLength(12);
    const ring = session.ringFrames();
    const ringBytes = ring.reduce((n, f) => n + Buffer.from(f.data, "base64").byteLength, 0);
    expect(ringBytes).toBeLessThanOrEqual(RING_BYTES);
    // oldest frames evicted — the ring holds only the tail, in order
    expect(ring[0]!.seq).toBeGreaterThan(1);
    expect(ring.at(-1)!.seq).toBe(12);
    expect(session.currentSeq).toBe(12);
  });
});
