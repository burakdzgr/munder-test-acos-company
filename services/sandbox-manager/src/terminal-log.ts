// Rolling terminal logs (22 §5.2, _DECISIONS §16; T41): JSONL frame files
// under DATA_DIR/terminals. A resume older than the in-memory ring is served
// from the file TAIL (256 KB cap); full scrollback is a REST download; files
// older than the retention window (7 days default) are reaped by the GC.
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { TerminalFrameSchema, type SandboxTerminalFrame } from "@acos/contracts";

export const LOG_TAIL_BYTES = 256 * 1024; // 22 §5.2 [WRITER-DECISION]
export const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // _DECISIONS §16

const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;

function logPath(dir: string, sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error(`bad session id: ${sessionId}`);
  return join(dir, `${sessionId}.log`);
}

/** Last ≤256 KB of the session log parsed back into frames (oldest→newest). */
export async function readLogTail(
  dir: string,
  sessionId: string,
  maxBytes = LOG_TAIL_BYTES,
): Promise<SandboxTerminalFrame[]> {
  const path = logPath(dir, sessionId); // throws on non-uuid ids (traversal guard)
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(path, "r");
  } catch {
    return []; // no log yet
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // a mid-file start lands inside a line — drop the partial first line
    const lines = text.split("\n").filter(Boolean);
    if (start > 0) lines.shift();
    const frames: SandboxTerminalFrame[] = [];
    for (const line of lines) {
      try {
        frames.push(TerminalFrameSchema.parse(JSON.parse(line)));
      } catch {
        /* torn/foreign line — skip */
      }
    }
    return frames;
  } finally {
    await handle.close();
  }
}

/** Full decoded scrollback for the REST download (plain text). */
export async function readLogText(dir: string, sessionId: string): Promise<string | null> {
  const path = logPath(dir, sessionId); // throws on non-uuid ids (traversal guard)
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
  const chunks: string[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    try {
      const frame = TerminalFrameSchema.parse(JSON.parse(line));
      chunks.push(Buffer.from(frame.data, "base64").toString("utf8"));
    } catch {
      /* skip torn line */
    }
  }
  return chunks.join("");
}

/** Retention sweep: unlink session logs older than the window. */
export async function sweepOldLogs(
  dir: string,
  maxAgeMs = LOG_RETENTION_MS,
  nowMs = Date.now(),
): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of entries) {
    if (!name.endsWith(".log")) continue;
    const path = join(dir, name);
    try {
      const stat = await fs.stat(path);
      if (nowMs - stat.mtimeMs > maxAgeMs) {
        await fs.unlink(path);
        removed.push(name);
      }
    } catch {
      /* raced deletion — fine */
    }
  }
  return removed;
}
