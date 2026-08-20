// Usage metering from the Anthropic Messages API response body. The broker
// tees the bytes it streams back to the CLI through this parser, so the
// session-level llm_calls accounting (ADR-022 "cost/observability") is derived
// from what the upstream actually billed, not from what the CLI claims.
// Streaming: usage arrives split across `message_start` (input side) and the
// final `message_delta` (output side). Non-streaming: a single JSON body.
import type { UsageCounts } from "./sessions.js";

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

function merge(base: RawUsage | null, next: RawUsage | undefined): RawUsage | null {
  if (!next) return base;
  return { ...(base ?? {}), ...stripUndef(next) };
}

function stripUndef(u: RawUsage): RawUsage {
  const out: RawUsage = {};
  if (u.input_tokens !== undefined) out.input_tokens = u.input_tokens;
  if (u.output_tokens !== undefined) out.output_tokens = u.output_tokens;
  if (u.cache_creation_input_tokens !== undefined) out.cache_creation_input_tokens = u.cache_creation_input_tokens;
  if (u.cache_read_input_tokens !== undefined) out.cache_read_input_tokens = u.cache_read_input_tokens;
  return out;
}

export function toCounts(raw: RawUsage | null): UsageCounts | null {
  if (!raw) return null;
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    cacheCreationInputTokens: raw.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: raw.cache_read_input_tokens ?? 0,
  };
}

/** Bounded so a hostile/huge body cannot grow broker memory unboundedly. */
export const MAX_PARSE_BYTES = 4 * 1024 * 1024;

/**
 * Incremental parser over the response body. Feed chunks as they are proxied;
 * call `result()` once the upstream ends. Works for both SSE and plain JSON.
 */
export class UsageAccumulator {
  private buffer = "";
  private bytes = 0;
  private usage: RawUsage | null = null;
  private model: string | null = null;
  private sawSse = false;

  constructor(private readonly contentType: string | undefined) {}

  push(chunk: Buffer | string): void {
    this.bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (this.bytes > MAX_PARSE_BYTES) return; // keep proxying; stop metering
    this.buffer += chunk.toString();
    if (this.isSse()) this.drainSseLines(false);
  }

  result(): { usage: UsageCounts | null; model: string | null } {
    if (this.isSse()) {
      this.drainSseLines(true);
    } else if (this.buffer.trim().length > 0) {
      try {
        const body = JSON.parse(this.buffer) as { usage?: RawUsage; model?: string };
        this.usage = merge(this.usage, body.usage);
        if (typeof body.model === "string") this.model = body.model;
      } catch {
        /* non-JSON (error page) — nothing to meter */
      }
    }
    return { usage: toCounts(this.usage), model: this.model };
  }

  private isSse(): boolean {
    return this.sawSse || (this.contentType ?? "").includes("text/event-stream");
  }

  private drainSseLines(flush: boolean): void {
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      this.consumeSseLine(line);
    }
    if (flush && this.buffer.length > 0) {
      this.consumeSseLine(this.buffer);
      this.buffer = "";
    }
  }

  private consumeSseLine(line: string): void {
    if (!line.startsWith("data:")) return;
    this.sawSse = true;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let ev: { type?: string; message?: { usage?: RawUsage; model?: string }; usage?: RawUsage };
    try {
      ev = JSON.parse(payload) as typeof ev;
    } catch {
      return;
    }
    if (ev.type === "message_start" && ev.message) {
      this.usage = merge(this.usage, ev.message.usage);
      if (typeof ev.message.model === "string") this.model = ev.message.model;
    } else if (ev.type === "message_delta" && ev.usage) {
      this.usage = merge(this.usage, ev.usage);
    }
  }
}
