// /ws gateway (T23; wire contract 21 §4, internals 22 §2–8,12).
// One module inside apps/server: upgrade auth (session cookie or ?pat=),
// connection registry, subscribe/resume/unsubscribe, per-topic seq tracking
// with duplicate suppression, replay from the events table (pages of 500,
// live events parked during replay), heartbeat + revocation sweeps, limits.
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { WebSocket } from "ws";
import { uuidv7 } from "@acos/domain";
import { parseTopic, WS_CLOSE_CODES, type ParsedTopic } from "@acos/contracts";
import type { CompanyContext, GuardedDb } from "@acos/db";
import { companyContext } from "@acos/db";
import { events } from "@acos/db/schema";
import type { NatsConnection, Subscription } from "nats";
import { toEnvelope, type EventEnvelopeDto } from "../events/read.js";

// Defaults per 21 §4 / 22 [WRITER-DECISION] constants (config surface later).
export const HEARTBEAT_SEC = 20;
export const MAX_TOPICS_PER_CONNECTION = 32;
export const MAX_CONNECTIONS_PER_SESSION = 8;
export const REPLAY_PAGE_SIZE = 500;
export const REPLAY_CAP_EVENTS = 5_000;
export const EVENTS_BUFFER_LIMIT_BYTES = 1_048_576; // 1 MB → close 4409 (21 §4.6)
const SWEEP_INTERVAL_MS = 10_000;
const AUTH_RECHECK_MS = 60_000;

interface TopicSub {
  parsed: ParsedTopic;
  mode: "live" | "replay";
  lastSentSeq: number;
  parked: EventEnvelopeDto[];
  authorizedAt: number;
}

interface Connection {
  id: string;
  socket: WebSocket;
  userId: string;
  /** Raw session token for the revocation sweep; null for PAT connections. */
  sessionToken: string | null;
  subs: Map<string, TopicSub>;
  lastSeenAt: number;
  lastAuthCheckAt: number;
}

export interface GatewayAuth {
  /** Re-validate a session token (sweep). Returns null when revoked. */
  verifySession(token: string): Promise<{ id: string } | null>;
  /** Company membership (21 §2.3) — null means "not yours", topic refused. */
  membership(userId: string, companyId: string): Promise<string | null>;
}

/** Presence topic state provider — the office projector (T25). */
export interface PresenceSource {
  snapshot(companyId: string): Promise<{
    layoutVersion: number;
    snapshotEpoch: number;
    agents: unknown[];
    interactions: unknown[];
  }>;
  handleEvent(envelope: EventEnvelopeDto): Promise<unknown[]>;
}

/** Terminal replay source (22 §5.2, T41) — sandbox-manager's per-session
 *  ring (or log tail after restarts), fetched over its internal API. */
export interface TerminalRingSource {
  ring(sessionId: string): Promise<{
    frames: { seq: number; ts: number; stream: string; data: string }[];
    currentSeq: number;
    source: string;
  }>;
}

export class RealtimeGateway {
  private readonly connections = new Map<string, Connection>();
  private nats: NatsConnection | null = null;
  private natsSub: Subscription | null = null;
  private termSub: Subscription | null = null;
  private runtimeSub: Subscription | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private presenceSeq = new Map<string, number>();
  private runtimeSeq = new Map<string, number>();

  constructor(
    private readonly db: GuardedDb,
    private readonly auth: GatewayAuth,
    private readonly presenceSource: PresenceSource | null = null,
    private readonly terminalSource: (() => TerminalRingSource | null) | null = null,
  ) {}

  // ---------- lifecycle ----------

  start(): void {
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  /** Live fanout source — attached from main.ts once NATS is up (boot order). */
  attachNats(nats: NatsConnection): void {
    this.nats = nats;
    // terminal PTY frames (22 §5.2): sandbox-manager → term.<sessionId> → WS
    this.termSub = nats.subscribe("term.>");
    void (async () => {
      for await (const message of this.termSub!) {
        try {
          const sessionId = message.subject.slice("term.".length);
          const frame = JSON.parse(new TextDecoder().decode(message.data)) as {
            seq: number;
          };
          this.fanoutTerminalFrame(sessionId, frame);
        } catch {
          /* malformed frame — ignore (lossy stream) */
        }
      }
    })();
    // runtime lifecycle frames (LIVE-CONSOLE TASK 2): agent-worker →
    // rt.<companyId> → runtime:<companyId> WS topic. term.* gibi ephemeral
    // core NATS — kayıplı, replay'siz; truth agent_steps/approvals'ta kalır.
    this.runtimeSub = nats.subscribe("rt.>");
    void (async () => {
      for await (const message of this.runtimeSub!) {
        try {
          const companyId = message.subject.slice("rt.".length);
          if (!companyId) continue;
          const event = JSON.parse(new TextDecoder().decode(message.data)) as unknown;
          this.fanoutRuntimeEvent(companyId, event);
        } catch {
          /* malformed frame — ignore (lossy stream) */
        }
      }
    })();
    this.natsSub = nats.subscribe("co.>");
    void (async () => {
      for await (const message of this.natsSub!) {
        try {
          const payload = JSON.parse(new TextDecoder().decode(message.data)) as EventEnvelopeDto;
          // co.<companyId>.office.* = projector instructions → presence topic
          const parts = message.subject.split(".");
          if (parts[2] === "office") {
            if (parts[1]) this.onPresenceDelta(parts[1], payload);
            continue;
          }
          this.onLiveEvent(payload);
          // domain events feed the projector; its instructions come back on
          // co.<companyId>.office.* (23 §3 flow)
          if (this.presenceSource) {
            // O3: a swallowed failure here stops the office view updating
            // while everything else looks healthy — the Founder sees agents
            // frozen at their desks and has nothing to go on. This gateway
            // has no logger of its own, so it goes to stderr; the /ws fanout
            // above must keep running either way.
            void this.presenceSource.handleEvent(payload).catch((err: unknown) => {
              console.warn("office presence projection failed", {
                type: payload.type,
                err: err instanceof Error ? err.message : String(err),
              });
            });
          }
        } catch {
          // non-envelope payloads on co.> are ignored
        }
      }
    })();
  }

  /** office.* instruction / agent presence delta → presence:<companyId> subs. */
  private onPresenceDelta(companyId: string, instruction: unknown): void {
    const topic = `presence:${companyId}`;
    const seq = (this.presenceSeq.get(companyId) ?? 0) + 1;
    this.presenceSeq.set(companyId, seq);
    for (const connection of this.connections.values()) {
      const sub = connection.subs.get(topic);
      if (!sub) continue;
      sub.lastSentSeq = seq;
      this.send(connection, { topic, seq, events: [instruction] });
    }
  }

  /** runtime lifecycle olayı → runtime:<companyId> aboneleri (presence gibi
   *  canlı-only; seq bu süreçte atanır, kayıplı sözleşme). */
  private fanoutRuntimeEvent(companyId: string, event: unknown): void {
    const topic = `runtime:${companyId}`;
    const seq = (this.runtimeSeq.get(companyId) ?? 0) + 1;
    this.runtimeSeq.set(companyId, seq);
    for (const connection of this.connections.values()) {
      const sub = connection.subs.get(topic);
      if (!sub) continue;
      sub.lastSentSeq = seq;
      this.send(connection, { topic, seq, events: [event] });
    }
  }

  /** Sunucu tarafı üreticiler (approval verdict yolu) için tek kapı: olay
   *  NATS'a basılır, fanout rt.> aboneliğinden döner — çok-instance'ta da
   *  tek dağıtım yolu. NATS yoksa sessiz no-op (canlılık > kesinlik). */
  publishRuntime(companyId: string, event: Record<string, unknown>): void {
    try {
      this.nats?.publish(`rt.${companyId}`, JSON.stringify(event));
    } catch {
      /* ephemeral kanal — yayınlanamayan olay kaybolur, akış sürer */
    }
  }

  /** One live frame → every subscriber of terminal:<sessionId> (seq-deduped).
   *  Terminal data rides the `frames` key (22 §4) — distinct from `events`. */
  private fanoutTerminalFrame(sessionId: string, frame: { seq: number }): void {
    const topic = `terminal:${sessionId}`;
    for (const connection of this.connections.values()) {
      const sub = connection.subs.get(topic);
      if (!sub || frame.seq <= sub.lastSentSeq) continue;
      sub.lastSentSeq = frame.seq;
      this.send(connection, { topic, seq: frame.seq, frames: [frame] });
    }
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.natsSub?.unsubscribe();
    this.termSub?.unsubscribe();
    this.runtimeSub?.unsubscribe();
    for (const connection of this.connections.values()) {
      connection.socket.close(WS_CLOSE_CODES.normal, "server shutdown");
    }
    this.connections.clear();
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  // ---------- connection handling ----------

  handleConnection(
    socket: WebSocket,
    principal: { userId: string; sessionToken: string | null },
  ): void {
    const sameSession = [...this.connections.values()].filter(
      (c) => c.sessionToken !== null && c.sessionToken === principal.sessionToken,
    );
    if (principal.sessionToken !== null && sameSession.length >= MAX_CONNECTIONS_PER_SESSION) {
      socket.close(WS_CLOSE_CODES.connectionLimit, "too many connections for this session");
      return;
    }

    const connection: Connection = {
      id: `c_${uuidv7()}`,
      socket,
      userId: principal.userId,
      sessionToken: principal.sessionToken,
      subs: new Map(),
      lastSeenAt: Date.now(),
      lastAuthCheckAt: Date.now(),
    };
    this.connections.set(connection.id, connection);

    socket.on("message", (raw: Buffer | string) => {
      connection.lastSeenAt = Date.now();
      void this.onMessage(connection, raw.toString());
    });
    socket.on("close", () => this.connections.delete(connection.id));
    socket.on("error", () => this.connections.delete(connection.id));

    this.send(connection, {
      op: "hello",
      connectionId: connection.id,
      heartbeatSec: HEARTBEAT_SEC,
      maxTopics: MAX_TOPICS_PER_CONNECTION,
      version: 1,
    });
  }

  private async onMessage(connection: Connection, raw: string): Promise<void> {
    let op: unknown;
    try {
      op = JSON.parse(raw);
    } catch {
      return this.sendError(connection, "bad_op", undefined, "frames must be JSON");
    }
    const parsed = op as { op?: string; topics?: string[]; topic?: string; after_seq?: number; t?: number };
    switch (parsed.op) {
      case "ping":
        return this.send(connection, { op: "pong", ...(parsed.t !== undefined && { t: parsed.t }) });
      case "subscribe": {
        if (!Array.isArray(parsed.topics) || parsed.topics.length === 0) {
          return this.sendError(connection, "bad_op", undefined, "subscribe needs topics[]");
        }
        for (const topic of parsed.topics) await this.subscribe(connection, topic, null);
        return;
      }
      case "resume": {
        if (typeof parsed.topic !== "string" || typeof parsed.after_seq !== "number") {
          return this.sendError(connection, "bad_op", undefined, "resume needs topic + after_seq");
        }
        return this.subscribe(connection, parsed.topic, parsed.after_seq);
      }
      case "unsubscribe": {
        for (const topic of parsed.topics ?? []) connection.subs.delete(topic);
        return;
      }
      default:
        return this.sendError(connection, "bad_op", parsed.topic, `unknown op ${String(parsed.op)}`);
    }
  }

  // ---------- subscribe / resume ----------

  private async subscribe(
    connection: Connection,
    topic: string,
    afterSeq: number | null,
  ): Promise<void> {
    const parsed = parseTopic(topic);
    if (!parsed) return this.sendError(connection, "bad_op", topic, "malformed topic");
    if (connection.subs.size >= MAX_TOPICS_PER_CONNECTION && !connection.subs.has(topic)) {
      return this.sendError(connection, "limit_exceeded", topic);
    }

    const authorized = await this.authorizeTopic(connection.userId, parsed);
    if (!authorized) return this.sendError(connection, "forbidden_topic", topic);

    if (parsed.kind === "events") return this.subscribeEvents(connection, topic, parsed, afterSeq);
    if (parsed.kind === "presence") return this.subscribePresence(connection, topic, parsed);
    if (parsed.kind === "runtime") return this.subscribeRuntime(connection, topic, parsed);
    return this.subscribeTerminal(connection, topic, parsed, afterSeq);
  }

  private async subscribeEvents(
    connection: Connection,
    topic: string,
    parsed: ParsedTopic,
    afterSeq: number | null,
  ): Promise<void> {
    const ctx = companyContext(parsed.id);
    const head = await this.headSeq(ctx);

    if (afterSeq !== null && head - afterSeq > REPLAY_CAP_EVENTS) {
      return this.sendError(
        connection,
        "replay_too_large",
        topic,
        `resume gap ${head - afterSeq} exceeds ${REPLAY_CAP_EVENTS}; bootstrap via GET /events`,
      );
    }

    const replaying = afterSeq !== null && afterSeq < head;
    const sub: TopicSub = {
      parsed,
      mode: replaying ? "replay" : "live",
      lastSentSeq: replaying ? afterSeq : head,
      parked: [],
      authorizedAt: Date.now(),
    };
    connection.subs.set(topic, sub);
    this.send(connection, {
      op: "sub_ok",
      topic,
      current_seq: head,
      mode: sub.mode,
    });
    if (replaying) await this.replayEvents(connection, topic, sub, ctx);
  }

  /** 22 §6.1: DB pages → parked-live flush → replay_done → live. */
  private async replayEvents(
    connection: Connection,
    topic: string,
    sub: TopicSub,
    ctx: CompanyContext,
  ): Promise<void> {
    for (;;) {
      if (connection.socket.readyState !== connection.socket.OPEN) return;
      if (connection.subs.get(topic) !== sub) return; // unsubscribed mid-replay
      const rows = await this.db
        .select()
        .from(events)
        .where(and(eq(events.companyId, ctx.companyId), gt(events.seq, sub.lastSentSeq)))
        .orderBy(asc(events.seq))
        .limit(REPLAY_PAGE_SIZE);
      if (rows.length === 0) break;
      const batch = rows.map(toEnvelope);
      sub.lastSentSeq = batch[batch.length - 1]!.seq;
      this.send(connection, { topic, seq: sub.lastSentSeq, events: batch });
      if (rows.length < REPLAY_PAGE_SIZE) break;
    }
    // splice: flush live events parked during the DB read (dedupe by seq)
    const parked = sub.parked.filter((e) => e.seq > sub.lastSentSeq).sort((a, b) => a.seq - b.seq);
    sub.parked = [];
    if (parked.length > 0) {
      sub.lastSentSeq = parked[parked.length - 1]!.seq;
      this.send(connection, { topic, seq: sub.lastSentSeq, events: parked });
    }
    sub.mode = "live";
    this.send(connection, { op: "replay_done", topic, up_to_seq: sub.lastSentSeq });
  }

  private async subscribePresence(
    connection: Connection,
    topic: string,
    parsed: ParsedTopic,
  ): Promise<void> {
    // Snapshot-then-delta (22 §5.3) — state comes from the office projector.
    const seq = this.presenceSeq.get(parsed.id) ?? 0;
    connection.subs.set(topic, {
      parsed,
      mode: "live",
      lastSentSeq: seq,
      parked: [],
      authorizedAt: Date.now(),
    });
    this.send(connection, { op: "sub_ok", topic, current_seq: seq, mode: "live" });
    const state = this.presenceSource
      ? await this.presenceSource
          .snapshot(parsed.id)
          .catch(() => ({ layoutVersion: 0, snapshotEpoch: 0, agents: [], interactions: [] }))
      : { layoutVersion: 0, snapshotEpoch: 0, agents: [], interactions: [] };
    this.send(connection, { op: "snapshot", topic, seq, state });
  }

  /** runtime:<companyId> — canlı-only lifecycle akışı (LIVE-CONSOLE TASK 2).
   *  Replay/snapshot yok: geçmiş agent_steps'ten okunur, bu kanal yalnız
   *  "şu an"ı taşır. */
  private subscribeRuntime(connection: Connection, topic: string, parsed: ParsedTopic): void {
    const seq = this.runtimeSeq.get(parsed.id) ?? 0;
    connection.subs.set(topic, {
      parsed,
      mode: "live",
      lastSentSeq: seq,
      parked: [],
      authorizedAt: Date.now(),
    });
    this.send(connection, { op: "sub_ok", topic, current_seq: seq, mode: "live" });
  }

  /** 22 §5.2: ring (or log-tail) replay first, then the live NATS flow;
   *  anything older than the replay window is an ACKNOWLEDGED gap. */
  private async subscribeTerminal(
    connection: Connection,
    topic: string,
    parsed: ParsedTopic,
    afterSeq: number | null,
  ): Promise<void> {
    const source = this.terminalSource?.() ?? null;
    const ring = source
      ? await source
          .ring(parsed.id)
          .catch(() => ({ frames: [], currentSeq: 0, source: "none" }))
      : { frames: [], currentSeq: 0, source: "none" };

    const floor = afterSeq ?? 0;
    const replayable = ring.frames.filter((f) => f.seq > floor);
    const sub: TopicSub = {
      parsed,
      mode: "live",
      lastSentSeq:
        replayable.length > 0 ? replayable[replayable.length - 1]!.seq : Math.max(floor, ring.currentSeq),
      parked: [],
      authorizedAt: Date.now(),
    };
    connection.subs.set(topic, sub);
    this.send(connection, { op: "sub_ok", topic, current_seq: ring.currentSeq, mode: "live" });

    // frames older than the ring/log window are gone — tell the client so it
    // renders a truncation marker instead of re-resuming (lossy by contract)
    const oldestAvailable = replayable[0]?.seq;
    if (oldestAvailable !== undefined && oldestAvailable > floor + 1) {
      this.send(connection, { op: "gap", topic, from_seq: floor + 1, to_seq: oldestAvailable - 1 });
    }
    if (replayable.length > 0) {
      this.send(connection, { topic, seq: sub.lastSentSeq, frames: replayable });
    }
  }

  // ---------- authorization (22 §8) ----------

  private async authorizeTopic(userId: string, parsed: ParsedTopic): Promise<boolean> {
    if (parsed.kind === "events" || parsed.kind === "presence" || parsed.kind === "runtime") {
      return (await this.auth.membership(userId, parsed.id)) !== null;
    }
    // terminal:<sessionId> → session → workspace → project → company, and the
    // member must be founder/admin (most privileged stream). No terminal
    // sessions exist before T37 — resolution failing closed is correct.
    const result = await this.db.execute(sql`
      SELECT p.company_id AS company_id
      FROM terminal_sessions t
      JOIN workspaces w ON w.id = t.workspace_id AND w.company_id = t.company_id
      JOIN projects p  ON p.id = w.project_id  AND p.company_id = w.company_id
      WHERE t.id = ${parsed.id} AND t.company_id = p.company_id
    `);
    const companyId = (result.rows[0] as { company_id?: string } | undefined)?.company_id;
    if (!companyId) return false;
    const role = await this.auth.membership(userId, companyId);
    return role === "founder" || role === "admin";
  }

  // ---------- live fanout ----------

  private onLiveEvent(envelope: EventEnvelopeDto): void {
    if (!envelope || typeof envelope.seq !== "number" || !envelope.companyId) return;
    const topic = `events:${envelope.companyId}`;
    for (const connection of this.connections.values()) {
      const sub = connection.subs.get(topic);
      if (!sub) continue;
      if (sub.mode === "replay") {
        sub.parked.push(envelope);
        if (sub.parked.length > REPLAY_CAP_EVENTS) sub.parked.shift(); // bounded park
        continue;
      }
      void this.deliverLive(connection, topic, sub, envelope);
    }
  }

  private async deliverLive(
    connection: Connection,
    topic: string,
    sub: TopicSub,
    envelope: EventEnvelopeDto,
  ): Promise<void> {
    if (envelope.seq <= sub.lastSentSeq) return; // duplicate — suppressed
    if (envelope.seq > sub.lastSentSeq + 1) {
      // server-side gap (missed NATS delivery / subscribe race) → catch-up
      // read from the table before resuming flow (22 §5.1)
      sub.mode = "replay";
      sub.parked = [envelope];
      await this.replayEvents(connection, topic, sub, companyContext(sub.parsed.id));
      return;
    }
    if (connection.socket.bufferedAmount > EVENTS_BUFFER_LIMIT_BYTES) {
      // events are NEVER dropped: slow consumer is closed, client resumes
      // from its cursor (21 §4.6)
      connection.socket.close(WS_CLOSE_CODES.slowConsumer, "slow consumer");
      return;
    }
    sub.lastSentSeq = envelope.seq;
    this.send(connection, { topic, seq: envelope.seq, events: [envelope] });
  }

  // ---------- sweeps (heartbeat + revocation, 22 §2/§8) ----------

  private async sweep(): Promise<void> {
    const now = Date.now();
    for (const connection of this.connections.values()) {
      if (now - connection.lastSeenAt > HEARTBEAT_SEC * 2 * 1000) {
        connection.socket.close(WS_CLOSE_CODES.heartbeatTimeout, "heartbeat timeout");
        this.connections.delete(connection.id);
        continue;
      }
      if (now - connection.lastAuthCheckAt >= AUTH_RECHECK_MS) {
        connection.lastAuthCheckAt = now;
        if (connection.sessionToken !== null) {
          const user = await this.auth.verifySession(connection.sessionToken).catch(() => null);
          if (!user) {
            connection.socket.close(WS_CLOSE_CODES.unauthenticated, "session revoked");
            this.connections.delete(connection.id);
            continue;
          }
        }
        for (const [topic, sub] of connection.subs) {
          const stillAuthorized = await this.authorizeTopic(connection.userId, sub.parsed).catch(
            () => false,
          );
          if (!stillAuthorized) {
            connection.subs.delete(topic);
            this.sendError(connection, "forbidden_topic", topic, "authorization revoked");
          }
        }
      }
    }
  }

  // ---------- helpers ----------

  private async headSeq(ctx: CompanyContext): Promise<number> {
    const result = await this.db.execute(
      sql`SELECT coalesce(max(seq), 0)::bigint AS head FROM events WHERE company_id = ${ctx.companyId}`,
    );
    return Number((result.rows[0] as { head: string | number }).head);
  }

  private send(connection: Connection, frame: unknown): void {
    if (connection.socket.readyState !== connection.socket.OPEN) return;
    connection.socket.send(JSON.stringify(frame));
  }

  private sendError(
    connection: Connection,
    code: "forbidden_topic" | "limit_exceeded" | "replay_too_large" | "bad_op",
    topic?: string,
    message?: string,
  ): void {
    this.send(connection, {
      op: "error",
      code,
      ...(topic !== undefined && { topic }),
      ...(message !== undefined && { message }),
    });
  }
}
