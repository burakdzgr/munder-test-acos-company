// RealtimeClient (22 §9, T24): auto-connect, heartbeat, backoff with full
// jitter, auto-resume from a CursorStore, seq dedupe (handlers never see
// duplicates or regressions), client-side gap healing via re-resume,
// multiplexing (N UI subscribers → one server subscription, refcounted).
// WebSocket implementation and backoff are injectable for scripted tests.
import { parseTopic } from "./realtime.js";

export interface CursorStore {
  get(topic: string): number | null;
  set(topic: string, seq: number): void;
}

/** Minimal structural WebSocket (browser WebSocket and `ws` both conform). */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export type RealtimeStatus = "connecting" | "open" | "replaying" | "backoff" | "closed_auth" | "closed";

export interface FrameMeta {
  topic: string;
  /** seq of the last event in the batch (0 for control-only deliveries). */
  seq: number;
  kind: "events" | "snapshot" | "terminal" | "gap";
}

export type FrameHandler = (events: unknown[], meta: FrameMeta) => void;

export interface RealtimeClientOptions {
  url: string;
  cursorStore?: CursorStore;
  /** Injectable for tests; defaults to globalThis.WebSocket. */
  webSocketImpl?: new (url: string) => WebSocketLike;
  /** attempt (1-based) → delay ms. Default: full jitter, cap 30 s (22 §7). */
  backoffDelayMs?: (attempt: number) => number;
  pingIntervalMs?: number;
  now?: () => number;
}

const OPEN = 1;

const defaultBackoff = (attempt: number): number =>
  Math.floor(Math.random() * Math.min(30_000, 1_000 * 2 ** (attempt - 1)));

interface TopicState {
  handlers: Set<FrameHandler>;
  /** last seq the handlers saw; null = no cursor yet ("from now"). */
  lastSeq: number | null;
  /** replay in flight (between resume issue and replay_done). */
  replaying: boolean;
  lastCursorWriteAt: number;
}

export class RealtimeClient {
  private socket: WebSocketLike | null = null;
  private readonly topics = new Map<string, TopicState>();
  private status: RealtimeStatus = "closed";
  private readonly statusListeners = new Set<(s: RealtimeStatus) => void>();
  private attempt = 0;
  private closedByUser = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: RealtimeClientOptions) {}

  // ---------- public API ----------

  subscribe(topic: string, handler: FrameHandler): () => void {
    let state = this.topics.get(topic);
    if (!state) {
      state = {
        handlers: new Set(),
        lastSeq: this.options.cursorStore?.get(topic) ?? null,
        replaying: false,
        lastCursorWriteAt: 0,
      };
      this.topics.set(topic, state);
      if (this.socket?.readyState === OPEN) this.sendSubscribe(topic, state);
    }
    state.handlers.add(handler);
    if (!this.socket && !this.closedByUser) this.connect();
    return () => {
      const current = this.topics.get(topic);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        this.topics.delete(topic);
        if (this.socket?.readyState === OPEN) {
          this.socket.send(JSON.stringify({ op: "unsubscribe", topics: [topic] }));
        }
      }
    };
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  onStatus(listener: (s: RealtimeStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    this.socket?.close(1000);
    this.socket = null;
    this.setStatus("closed");
  }

  // ---------- connection ----------

  connect(): void {
    if (this.socket || this.closedByUser) return;
    const Impl =
      this.options.webSocketImpl ??
      ((globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket as new (
        url: string,
      ) => WebSocketLike);
    this.setStatus("connecting");
    const socket = new Impl(this.options.url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
      for (const [topic, state] of this.topics) this.sendSubscribe(topic, state);
    };
    socket.onmessage = (ev) => this.onFrame(String(ev.data));
    socket.onerror = () => {
      /* close follows; backoff handles it */
    };
    socket.onclose = (ev) => {
      this.socket = null;
      this.clearTimers();
      if (this.closedByUser) return this.setStatus("closed");
      if (ev.code === 4401) return this.setStatus("closed_auth"); // non-retryable
      this.setStatus("backoff");
      this.attempt += 1;
      const delay = (this.options.backoffDelayMs ?? defaultBackoff)(this.attempt);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  private sendSubscribe(topic: string, state: TopicState): void {
    const parsed = parseTopic(topic);
    state.replaying = false;
    if (parsed?.kind === "events" && state.lastSeq !== null) {
      state.replaying = true;
      this.socket!.send(JSON.stringify({ op: "resume", topic, after_seq: state.lastSeq }));
    } else {
      this.socket!.send(JSON.stringify({ op: "subscribe", topics: [topic] }));
    }
  }

  // ---------- frames ----------

  private onFrame(raw: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const op = frame.op as string | undefined;

    if (op === "hello") {
      const heartbeatSec = typeof frame.heartbeatSec === "number" ? frame.heartbeatSec : 20;
      this.startPing(this.options.pingIntervalMs ?? heartbeatSec * 1000);
      return;
    }
    if (op === "sub_ok") {
      const state = this.topics.get(frame.topic as string);
      if (state && frame.mode === "replay") {
        state.replaying = true;
        this.setStatus("replaying");
      }
      return;
    }
    if (op === "replay_done") {
      const state = this.topics.get(frame.topic as string);
      if (state) state.replaying = false;
      if (![...this.topics.values()].some((s) => s.replaying)) this.setStatus("open");
      return;
    }
    if (op === "snapshot") {
      const topic = frame.topic as string;
      const state = this.topics.get(topic);
      if (!state) return;
      const seq = typeof frame.seq === "number" ? frame.seq : 0;
      state.lastSeq = seq;
      this.dispatch(state, [frame.state], { topic, seq, kind: "snapshot" });
      return;
    }
    if (op === "gap") {
      const topic = frame.topic as string;
      const state = this.topics.get(topic);
      if (!state) return;
      this.dispatch(state, [], {
        topic,
        seq: typeof frame.to_seq === "number" ? frame.to_seq : 0,
        kind: "gap",
      });
      return;
    }
    if (op !== undefined) return; // pong / error / unknown control

    // data frame: {topic, seq, events} or {topic, seq, frames}
    const topic = frame.topic as string | undefined;
    if (!topic) return;
    const state = this.topics.get(topic);
    if (!state) return;

    if (Array.isArray(frame.frames)) {
      const frames = frame.frames as Array<{ seq: number }>;
      const fresh = frames.filter((f) => state.lastSeq === null || f.seq > state.lastSeq);
      if (fresh.length === 0) return;
      state.lastSeq = fresh[fresh.length - 1]!.seq;
      // cursor persists so a reconnect resumes after_seq (ring replay, T41);
      // terminal gaps are ACKNOWLEDGED (lossy contract) — never re-resume
      this.persistCursor(topic, state);
      this.dispatch(state, fresh, { topic, seq: state.lastSeq, kind: "terminal" });
      return;
    }
    if (!Array.isArray(frame.events)) return;

    const parsed = parseTopic(topic);
    if (parsed?.kind === "events") {
      // domain envelopes carry their per-company seq; anything else is noise
      const batch = (frame.events as Array<{ seq: number }>).filter(
        (e) => typeof e?.seq === "number",
      );
      // duplicates / regressions are suppressed — handlers never see them
      const fresh = batch.filter((e) => state.lastSeq === null || e.seq > state.lastSeq);
      if (fresh.length === 0) return;
      // client-side gap: a hole between the cursor and this frame means a
      // missed delivery — heal by re-resuming from the cursor, drop the frame
      if (state.lastSeq !== null && fresh[0]!.seq > state.lastSeq + 1 && !state.replaying) {
        state.replaying = true;
        this.socket?.send(
          JSON.stringify({ op: "resume", topic, after_seq: state.lastSeq }),
        );
        return;
      }
      state.lastSeq = fresh[fresh.length - 1]!.seq;
      this.persistCursor(topic, state);
      this.dispatch(state, fresh, { topic, seq: state.lastSeq, kind: "events" });
      return;
    }
    // presence deltas (office.* instructions): latest-wins, delivered as-is —
    // they carry choreoSeq, not the events-table seq, so no seq filtering here
    const seq = typeof frame.seq === "number" ? frame.seq : 0;
    state.lastSeq = seq;
    this.dispatch(state, frame.events as unknown[], { topic, seq, kind: "events" });
  }

  private dispatch(state: TopicState, events: unknown[], meta: FrameMeta): void {
    for (const handler of state.handlers) handler(events, meta);
  }

  private persistCursor(topic: string, state: TopicState): void {
    if (!this.options.cursorStore || state.lastSeq === null) return;
    const now = (this.options.now ?? Date.now)();
    if (now - state.lastCursorWriteAt < 1_000) return; // throttled (22 §7)
    state.lastCursorWriteAt = now;
    this.options.cursorStore.set(topic, state.lastSeq);
  }

  // ---------- heartbeat ----------

  private startPing(intervalMs: number): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState === OPEN) {
        this.socket.send(JSON.stringify({ op: "ping", t: (this.options.now ?? Date.now)() }));
      }
    }, intervalMs);
    (this.pingTimer as { unref?: () => void }).unref?.();
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
