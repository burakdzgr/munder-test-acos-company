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
export const STEP_SOFT_WARN = 40;
export const STEP_HARD_CAP = 50;

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

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VOLATILE_KEY = /(_at|At|timestamp|Timestamp)$/;

/** Lowercase strings, drop timestamps and uuid values (08 §9d normalization). */
export function normalizeActionArgs(value: unknown): unknown {
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    return UUID_LIKE.test(lowered) ? "<uuid>" : lowered;
  }
  if (Array.isArray(value)) return value.map(normalizeActionArgs);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (VOLATILE_KEY.test(key)) continue;
      out[key] = normalizeActionArgs((value as Record<string, unknown>)[key]);
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
