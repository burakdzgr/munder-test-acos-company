// T41 unit surface: rolling-log tail parse (torn first line dropped), full
// scrollback decode, and the 7-day retention sweep.
import { mkdtempSync, writeFileSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readLogTail, readLogText, sweepOldLogs, LOG_RETENTION_MS } from "./terminal-log.js";

const frame = (seq: number, text: string) =>
  JSON.stringify({ seq, ts: seq * 1000, stream: "stdout", data: Buffer.from(text).toString("base64") });

describe("terminal rolling logs (22 §5.2, _DECISIONS §16)", () => {
  it("readLogTail parses JSONL frames and drops the torn first line on a mid-file start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acos-termlog-"));
    const sessionId = randomUUID();
    const lines = Array.from({ length: 50 }, (_, i) => frame(i + 1, `line-${i + 1}\n`));
    writeFileSync(join(dir, `${sessionId}.log`), lines.join("\n") + "\n");

    const all = await readLogTail(dir, sessionId);
    expect(all).toHaveLength(50);
    expect(all[0]!.seq).toBe(1);

    // tail smaller than the file ⇒ partial first line is discarded, order kept
    const tail = await readLogTail(dir, sessionId, 500);
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(50);
    const seqs = tail.map((f) => f.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(seqs.at(-1)).toBe(50);
  });

  it("readLogText decodes the full scrollback; missing session → null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acos-termlog-"));
    const sessionId = randomUUID();
    writeFileSync(
      join(dir, `${sessionId}.log`),
      [frame(1, "npm install\n"), frame(2, "added 12 packages\n")].join("\n") + "\n",
    );
    expect(await readLogText(dir, sessionId)).toBe("npm install\nadded 12 packages\n");
    expect(await readLogText(dir, randomUUID())).toBeNull();
  });

  it("sweepOldLogs unlinks logs older than the 7-day window and keeps fresh ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acos-termlog-"));
    const oldId = randomUUID();
    const freshId = randomUUID();
    writeFileSync(join(dir, `${oldId}.log`), frame(1, "old\n"));
    writeFileSync(join(dir, `${freshId}.log`), frame(1, "fresh\n"));
    const old = new Date(Date.now() - LOG_RETENTION_MS - 60_000);
    utimesSync(join(dir, `${oldId}.log`), old, old);

    const removed = await sweepOldLogs(dir);
    expect(removed).toEqual([`${oldId}.log`]);
    expect(existsSync(join(dir, `${oldId}.log`))).toBe(false);
    expect(existsSync(join(dir, `${freshId}.log`))).toBe(true);
  });

  it("rejects session ids that are not uuid-shaped (path traversal guard)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acos-termlog-"));
    await expect(readLogTail(dir, "../../etc/passwd")).rejects.toThrow(/bad session id/);
  });
});
