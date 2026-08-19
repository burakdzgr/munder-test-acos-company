// Terminal frame plumbing (22 §4, §5.2; _DECISIONS §16; T37). A PTY exec
// streams frames to NATS ephemeral subject `term.<sessionId>`, keeps a 64 KB
// per-session ring for late subscribers (the WS gateway serves it on
// subscribe), and appends every frame to a rolling log `/data/terminals/
// <sessionId>.log` (7-day retention, GC'd elsewhere). Pure buffering +
// serialization here; the transport (NATS) and disk are injected so the
// module is unit-testable without either.
import type { SandboxTerminalFrame } from "@acos/contracts";

export const RING_BYTES = 64 * 1024; // 22 §5.2 per-session ring

export interface TerminalTransport {
  /** Publish one frame to NATS `term.<sessionId>` (ephemeral, loss-tolerant). */
  publish(sessionId: string, frame: SandboxTerminalFrame): void;
}

export interface TerminalLogSink {
  /** Append a serialized frame line to the rolling session log. */
  append(sessionId: string, line: string): void;
}

interface RingEntry {
  frame: SandboxTerminalFrame;
  bytes: number;
}

/**
 * One terminal session: monotonic per-session seq, a byte-bounded ring
 * (drop-oldest), NATS publish, and rolling-log append. The gateway reads
 * `ringFrames()` when a client subscribes, then follows the live NATS flow.
 */
export class TerminalSession {
  private seq = 0;
  private ring: RingEntry[] = [];
  private ringBytes = 0;

  constructor(
    readonly sessionId: string,
    private readonly transport: TerminalTransport,
    private readonly log: TerminalLogSink,
    private readonly nowMs: () => number,
  ) {}

  /** Emit a chunk as a frame: assigns seq+ts, rings it, publishes, logs. */
  emit(stream: "stdout" | "stderr", chunk: Buffer | string): SandboxTerminalFrame {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    this.seq += 1;
    const frame: SandboxTerminalFrame = {
      seq: this.seq,
      ts: this.nowMs(),
      stream,
      data: buf.toString("base64"),
    };
    this.pushRing(frame, buf.byteLength);
    this.transport.publish(this.sessionId, frame);
    this.log.append(this.sessionId, JSON.stringify(frame));
    return frame;
  }

  private pushRing(frame: SandboxTerminalFrame, dataBytes: number): void {
    // account by decoded payload bytes (what the ring budget is about), not
    // the base64 envelope; drop-oldest until we fit (22 §5.2)
    this.ring.push({ frame, bytes: dataBytes });
    this.ringBytes += dataBytes;
    while (this.ringBytes > RING_BYTES && this.ring.length > 1) {
      const evicted = this.ring.shift()!;
      this.ringBytes -= evicted.bytes;
    }
  }

  /** Ring content for a late subscriber (oldest→newest). */
  ringFrames(): SandboxTerminalFrame[] {
    return this.ring.map((e) => e.frame);
  }

  get currentSeq(): number {
    return this.seq;
  }
}
