// The six runaway guards as pure functions (_DECISIONS.md §8, 08 §9).
// The workflow evaluates these after every persisted step; enforcement is
// code, not prompt text.

// ---------- (a) budget ----------
export function budgetExhausted(remainingCents: number, estNextStepCents: number): boolean {
  return remainingCents <= 0 || remainingCents <= estNextStepCents;
}

// ---------- (b) deadline ----------
export function deadlinePassed(now: Date, deadline: Date | null): boolean {
  return deadline !== null && now.getTime() > deadline.getTime();
}

// ---------- (c) step cap ----------
// Live tuning (2026-08-14, "raised for live LLM"): a real turn needs more than
// the 40/50 first cut. These are NOT the `continueAsNew` boundary — _DECISIONS
// fixes THAT at 50 steps (CONTINUE_EVERY_STEPS) and it is unchanged; the hard
// cap is deliberately left unnumbered by the spec. The values used to live as
// private constants inside agentTaskWorkflow, so the shared policy and its
// tests still advertised 40/50 while production ran 60/120. One home now.
export const STEP_SOFT_WARN = 60;
export const STEP_HARD_CAP = 120;

export type StepCapState = "ok" | "warn" | "hard";

/** Counts cumulative steps across continueAsNew via carried state (08 §9c). */
export function stepCapState(stepNo: number): StepCapState {
  if (stepNo >= STEP_HARD_CAP) return "hard";
  if (stepNo >= STEP_SOFT_WARN) return "warn";
  return "ok";
}

// ---------- (d) loop detector ----------
export const LOOP_WINDOW = 6;
export const LOOP_THRESHOLD = 3;

// Volatility that must NOT hide a loop: a fresh uuid or a wall-clock stamp
// makes two identical actions look different. Both are matched ANYWHERE in a
// string (not just as the whole value) — an agent re-running
// `curl /tasks/<fresh-uuid>` is repeating one action, not doing new work.
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO_TS_ANYWHERE = /\d{4}-\d{2}-\d{2}t[\d:.]+z?/gi;
const VOLATILE_KEY = /(_at|At|timestamp|Timestamp)$/;
// The same file addressed as `./src/a.ts`, `/work/src/a.ts` or `src/a.ts`.
const PATH_PREFIX = /(\.\/|\/work\/)/g;
// Long free text: two messages that agree for 100 chars are the same move.
// Bounds an evasion where a loop hides behind a late, cosmetic edit.
const CONTENT_KEY = /^(body|note|summary|content|message)$/i;
const CONTENT_PREFIX = 100;

/**
 * Lowercase strings, drop timestamps and uuid values (08 §9d normalization).
 *
 * Deliberately does NOT collapse digits wholesale. `src/file-1.ts` and
 * `src/file-2.ts` are DIFFERENT actions — writing a numbered series of files
 * is ordinary productive work, and a normalizer that folds every digit to a
 * placeholder reports it as a loop and stops the agent. Numbers that really
 * are incidental (line offsets, byte counts) ride along in fields whose whole
 * value is a number, and repeating those IS the loop we want to catch.
 */
export function normalizeActionArgs(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .toLowerCase()
      .replace(UUID_ANYWHERE, "<uuid>")
      .replace(ISO_TS_ANYWHERE, "<ts>")
      .replace(PATH_PREFIX, "");
  }
  if (Array.isArray(value)) return value.map(normalizeActionArgs);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE_KEY.test(key)) continue;
      const normalized = normalizeActionArgs((value as Record<string, unknown>)[key]);
      out[key] =
        CONTENT_KEY.test(key) && typeof normalized === "string" && normalized.length > CONTENT_PREFIX
          ? `${normalized.slice(0, CONTENT_PREFIX)}<...>`
          : normalized;
    }
    return out;
  }
  return value;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** FNV-1a 32-bit over actionType + normalized args — dependency-free. */
export function actionHash(actionType: string, args: unknown): string {
  const input = `${actionType}:${stableStringify(normalizeActionArgs(args))}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** ≥3 equal hashes within the last 6 steps → forced request_help (08 §9d). */
export function loopDetected(
  recentHashes: readonly string[],
  window: number = LOOP_WINDOW,
  threshold: number = LOOP_THRESHOLD,
): boolean {
  const windowed = recentHashes.slice(-window);
  const counts = new Map<string, number>();
  for (const hash of windowed) {
    const count = (counts.get(hash) ?? 0) + 1;
    if (count >= threshold) return true;
    counts.set(hash, count);
  }
  return false;
}

// ---------- (e) message ping-pong ----------
export const PING_PONG_THRESHOLD = 8;

export interface PingPongCounter {
  readonly channelId: string;
  /** Unordered pair key "a|b". */
  readonly pairKey: string;
  readonly lastSenderId: string;
  readonly count: number;
}

export function pairKey(agentA: string, agentB: string): string {
  return [agentA, agentB].sort().join("|");
}

/**
 * Advances the per-(channel, pair) alternation counter (08 §9e). Reset on
 * task-state change is the caller's job (counter simply starts over).
 */
export function nextPingPongCounter(
  previous: PingPongCounter | null,
  message: { channelId: string; senderId: string; recipientId: string },
): PingPongCounter {
  const key = pairKey(message.senderId, message.recipientId);
  if (
    previous !== null &&
    previous.channelId === message.channelId &&
    previous.pairKey === key &&
    previous.lastSenderId !== message.senderId
  ) {
    return { ...previous, lastSenderId: message.senderId, count: previous.count + 1 };
  }
  return { channelId: message.channelId, pairKey: key, lastSenderId: message.senderId, count: 1 };
}

/** > 8 alternating messages without a task-state change → manager notification. */
export function pingPongTripped(counter: PingPongCounter): boolean {
  return counter.count > PING_PONG_THRESHOLD;
}

// ---------- (f) delegation depth ----------
// canDelegate lives in policies/delegation.ts; re-exported by the index.
