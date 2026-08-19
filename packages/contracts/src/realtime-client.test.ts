// T24 acceptance: scripted frame-sequence suite — gap, duplicate,
// out-of-order, reconnect — against a fake WebSocket. Handlers must never see
// duplicates or seq regressions; gaps heal via re-resume; reconnect resumes
// from the persisted cursor.
import { describe, expect, it, vi } from "vitest";
import { RealtimeClient, type CursorStore, type WebSocketLike } from "./realtime-client.js";

const TOPIC = "events:018f0000-0000-7000-8000-000000000001";

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  // ---- test drivers ----
  open(): void {
    this.readyState = 1;
    this.onopen?.();
    this.frame({ op: "hello", connectionId: "c_1", heartbeatSec: 20, maxTopics: 32, version: 1 });
  }

  frame(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  dropFromServer(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

function envelope(seq: number) {
  return { seq, id: `evt-${seq}`, type: "company.settings.updated", payload: {} };
}

function dataFrame(seqs: number[]) {
  return { topic: TOPIC, seq: seqs[seqs.length - 1] ?? 0, events: seqs.map(envelope) };
}

function memoryCursorStore(): CursorStore & { data: Map<string, number> } {
  const data = new Map<string, number>();
  return {
    data,
    get: (topic) => data.get(topic) ?? null,
    set: (topic, seq) => data.set(topic, seq),
  };
}

function makeClient(cursorStore = memoryCursorStore()) {
  FakeSocket.instances = [];
  const received: number[] = [];
  const client = new RealtimeClient({
    url: "ws://test/ws",
    cursorStore,
    webSocketImpl: FakeSocket,
    backoffDelayMs: () => 0, // immediate reconnect in tests
    pingIntervalMs: 60_000,
  });
  client.subscribe(TOPIC, (events) => {
    for (const e of events as Array<{ seq: number }>) received.push(e.seq);
  });
  const socket = FakeSocket.instances[0]!;
  return { client, socket, received, cursorStore };
}

describe("RealtimeClient scripted frame sequences (T24)", () => {
  it("subscribes fresh topics with no cursor and delivers ascending batches", () => {
    const { socket, received } = makeClient();
    socket.open();
    expect(socket.sent).toContainEqual({ op: "subscribe", topics: [TOPIC] });
    socket.frame(dataFrame([1, 2]));
    socket.frame(dataFrame([3]));
    expect(received).toEqual([1, 2, 3]);
  });

  it("suppresses duplicates — a re-delivered frame is never seen twice", () => {
    const { socket, received } = makeClient();
    socket.open();
    socket.frame(dataFrame([1, 2]));
    socket.frame(dataFrame([1, 2])); // exact duplicate
    socket.frame(dataFrame([2, 3])); // overlap
    expect(received).toEqual([1, 2, 3]);
  });

  it("suppresses out-of-order regressions", () => {
    const { socket, received } = makeClient();
    socket.open();
    socket.frame(dataFrame([4]));
    socket.frame(dataFrame([2])); // stale, arrives late
    socket.frame(dataFrame([5]));
    expect(received).toEqual([4, 5]);
  });

  it("heals a gap by re-resuming from the cursor and dropping the gapped frame", () => {
    const { socket, received } = makeClient();
    socket.open();
    socket.frame(dataFrame([1, 2]));
    socket.frame(dataFrame([5, 6])); // hole: 3,4 missing
    expect(received).toEqual([1, 2]); // gapped frame NOT delivered
    expect(socket.sent).toContainEqual({ op: "resume", topic: TOPIC, after_seq: 2 });
    // server replays the hole, then live continues — no dupes, no gaps
    socket.frame({ op: "sub_ok", topic: TOPIC, current_seq: 6, mode: "replay" });
    socket.frame(dataFrame([3, 4, 5, 6]));
    socket.frame({ op: "replay_done", topic: TOPIC, up_to_seq: 6 });
    socket.frame(dataFrame([7]));
    expect(received).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("reconnects after a drop and resumes from the persisted cursor", async () => {
    vi.useFakeTimers();
    try {
      const { client, socket, received, cursorStore } = makeClient();
      socket.open();
      socket.frame(dataFrame([1, 2, 3]));
      expect(cursorStore.data.get(TOPIC)).toBe(3);

      socket.dropFromServer();
      expect(client.getStatus()).toBe("backoff");
      await vi.advanceTimersByTimeAsync(1); // backoffDelayMs → 0

      const socket2 = FakeSocket.instances[1]!;
      socket2.open();
      // resume with the persisted cursor, NOT a fresh subscribe
      expect(socket2.sent).toContainEqual({ op: "resume", topic: TOPIC, after_seq: 3 });
      socket2.frame({ op: "sub_ok", topic: TOPIC, current_seq: 5, mode: "replay" });
      expect(client.getStatus()).toBe("replaying");
      socket2.frame(dataFrame([4, 5]));
      socket2.frame({ op: "replay_done", topic: TOPIC, up_to_seq: 5 });
      expect(client.getStatus()).toBe("open");
      socket2.frame(dataFrame([5, 6])); // overlap across the splice
      expect(received).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying on 4401 (auth) and reports closed_auth", async () => {
    vi.useFakeTimers();
    try {
      const { client, socket } = makeClient();
      socket.open();
      socket.dropFromServer(4401);
      expect(client.getStatus()).toBe("closed_auth");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeSocket.instances).toHaveLength(1); // no reconnect attempt
    } finally {
      vi.useRealTimers();
    }
  });

  it("multiplexes N subscribers onto one server subscription, refcounted", () => {
    const { client, socket, received } = makeClient();
    socket.open();
    const second: number[] = [];
    const unsubscribe = client.subscribe(TOPIC, (events) => {
      for (const e of events as Array<{ seq: number }>) second.push(e.seq);
    });
    expect(socket.sent.filter((f) => f.op === "subscribe")).toHaveLength(1);
    socket.frame(dataFrame([1]));
    expect(received).toEqual([1]);
    expect(second).toEqual([1]);
    unsubscribe();
    socket.frame(dataFrame([2]));
    expect(received).toEqual([1, 2]);
    expect(second).toEqual([1]); // detached handler sees nothing further
  });

  it("delivers presence deltas that carry choreoSeq instead of seq (office.*)", () => {
    const presenceTopic = "presence:018f0000-0000-7000-8000-000000000001";
    FakeSocket.instances = [];
    const client = new RealtimeClient({
      url: "ws://test/ws",
      webSocketImpl: FakeSocket,
      backoffDelayMs: () => 0,
    });
    const received: unknown[] = [];
    client.subscribe(presenceTopic, (events) => received.push(...events));
    const socket = FakeSocket.instances[0]!;
    socket.open();
    const instruction = {
      type: "office.status.changed",
      choreoSeq: 7,
      causeEventId: "evt-1",
      causeSeq: 3,
      agentId: "a1",
      badge: "WORKING",
    };
    socket.frame({ topic: presenceTopic, seq: 1, events: [instruction] });
    expect(received).toEqual([instruction]); // NOT filtered by the events-seq guard
  });

  it("delivers presence snapshots with snapshot meta", () => {
    const presenceTopic = "presence:018f0000-0000-7000-8000-000000000001";
    FakeSocket.instances = [];
    const client = new RealtimeClient({
      url: "ws://test/ws",
      webSocketImpl: FakeSocket,
      backoffDelayMs: () => 0,
    });
    const snapshots: unknown[] = [];
    client.subscribe(presenceTopic, (events, meta) => {
      if (meta.kind === "snapshot") snapshots.push(events[0]);
    });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    expect(socket.sent).toContainEqual({ op: "subscribe", topics: [presenceTopic] });
    socket.frame({
      op: "snapshot",
      topic: presenceTopic,
      seq: 0,
      state: { layoutVersion: 0, agents: [], interactions: [] },
    });
    expect(snapshots).toEqual([{ layoutVersion: 0, agents: [], interactions: [] }]);
  });
});
