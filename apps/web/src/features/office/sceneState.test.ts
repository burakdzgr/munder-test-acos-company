// T26 acceptance (32 §11.1): the renderer is tested through its
// projector-instruction interface — recorded instruction streams into a
// headless ticker, asserting scene state (positions, interactions, badges).
// Plus the client-side invariant: officeStore rejects instructions without a
// causeEventId (dev build throws).
import { describe, expect, it } from "vitest";
import type { PresenceState } from "@acos/contracts";
import { OfficeSceneEngine, WALK_CELLS_PER_SEC } from "./sceneState.js";
import { useOfficeStore } from "../../stores/office.js";

const A = "018f0000-0000-7000-8000-0000000000a1";
const B = "018f0000-0000-7000-8000-0000000000b1";
const EVT = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, "0")}`;

let choreo = 0;
function instr(partial: Record<string, unknown>): Record<string, unknown> {
  choreo += 1;
  return {
    choreoSeq: choreo,
    causeSeq: choreo,
    emittedAt: "2026-08-11T12:00:00.000Z",
    ...partial,
  };
}

function snapshot(): PresenceState {
  return {
    layoutVersion: 1,
    snapshotEpoch: 1,
    agents: [
      { agentId: A, name: "Alice", cell: { x: 4, y: 4 }, badge: "IDLE", deskId: "d1", sessionId: null },
      { agentId: B, name: "Bob", cell: { x: 10, y: 4 }, badge: "IDLE", deskId: "d2", sessionId: null },
    ],
    interactions: [],
  };
}

const walk = (agentId: string, from: { x: number; y: number }, to: { x: number; y: number }, cause: string) =>
  instr({
    type: "office.avatar.moved",
    agentId,
    fromCell: from,
    toCell: to,
    path: [to], // single-segment path; length = manhattan distance
    reason: "dm",
    causeEventId: cause,
  });

describe("headless instruction replay (T26)", () => {
  it("replays a walk + interaction stream to the exact final scene state", () => {
    const engine = new OfficeSceneEngine();
    engine.applySnapshot(snapshot());

    engine.apply(walk(A, { x: 4, y: 4 }, { x: 10, y: 4 }, EVT(1)));
    engine.apply(
      instr({
        type: "office.interaction.started",
        interactionId: "i_1",
        kind: "dm",
        agentIds: [A, B],
        atCell: { x: 10, y: 4 },
        causeEventId: EVT(1),
      }),
    );
    engine.apply(
      instr({ type: "office.status.changed", agentId: A, badge: "COMMUNICATING", causeEventId: EVT(1) }),
    );

    // 6 cells at 6 cells/s ⇒ exactly 1 s of ticking to arrive
    engine.tick(0.5);
    const mid = engine.avatars.get(A)!.pos;
    expect(mid.x).toBeGreaterThan(4);
    expect(mid.x).toBeLessThan(10);
    engine.tick(0.6);
    expect(engine.avatars.get(A)!.pos).toEqual({ x: 10, y: 4 });
    // badge command queued behind the walk applies once the walk lands
    expect(engine.avatars.get(A)!.badge).toBe("COMMUNICATING");
    expect(engine.interactions.get("i_1")).toMatchObject({ kind: "dm", agentIds: [A, B] });
    expect(engine.lastAppliedEventId).toBe(EVT(1));

    engine.apply(
      instr({ type: "office.interaction.ended", interactionId: "i_1", endedBy: "dwell_timeout", causeEventId: EVT(2) }),
    );
    expect(engine.interactions.size).toBe(0);
    expect(engine.lastAppliedEventId).toBe(EVT(2));
  });

  it("walk speed is exactly 6 cells/s along the path", () => {
    const engine = new OfficeSceneEngine();
    engine.applySnapshot(snapshot());
    engine.apply(walk(A, { x: 4, y: 4 }, { x: 4, y: 10 }, EVT(3)));
    engine.tick(0.001); // dequeue + start
    engine.tick(1 / WALK_CELLS_PER_SEC); // one cell worth
    expect(engine.avatars.get(A)!.pos.y).toBeCloseTo(5, 1);
  });

  it("time compression collapses >3 pending walks into the latest one", () => {
    const engine = new OfficeSceneEngine();
    engine.applySnapshot(snapshot());
    engine.apply(walk(A, { x: 4, y: 4 }, { x: 6, y: 4 }, EVT(10)));
    engine.apply(walk(A, { x: 6, y: 4 }, { x: 8, y: 4 }, EVT(11)));
    engine.apply(walk(A, { x: 8, y: 4 }, { x: 10, y: 4 }, EVT(12)));
    engine.apply(walk(A, { x: 10, y: 4 }, { x: 12, y: 4 }, EVT(13))); // 4th → collapse
    const avatar = engine.avatars.get(A)!;
    expect(avatar.collapsedCount).toBe(3);
    expect(avatar.queue.filter((c) => c.kind === "walk")).toHaveLength(1);
    engine.tick(0.001);
    engine.tick(10); // plenty
    expect(avatar.pos).toEqual({ x: 12, y: 4 }); // only the latest walk played
    // collapsed instructions stay inspectable in the debug ring
    const ringIds = engine.debugRing.map((i) => i.causeEventId);
    expect(ringIds).toEqual(expect.arrayContaining([EVT(10), EVT(11), EVT(12), EVT(13)]));
  });

  // 2026-08-18 kayıtlı sapma (Founder: "arada bir tekrar render oluyor"):
  // aynı epoch'lu snapshot (WS reconnect) sahneyi SIFIRLAMAZ — süren yürüyüş
  // ve pozisyon korunur, rozet/masa/ad güncellenir. Sert sıfırlama yalnız
  // snapshotEpoch değişince (23 §6 "no replayed choreography" niyeti korunur:
  // hiçbir şey yeniden oynatılmaz).
  it("same-epoch snapshot soft-merges — the ongoing walk survives a reconnect", () => {
    const engine = new OfficeSceneEngine();
    engine.applySnapshot(snapshot());
    engine.apply(walk(A, { x: 4, y: 4 }, { x: 10, y: 4 }, EVT(20)));
    engine.tick(0.2); // mid-walk
    engine.applySnapshot(snapshot()); // reconnect catch-up, SAME epoch
    const avatar = engine.avatars.get(A)!;
    expect(avatar.walking).not.toBeNull(); // yürüyüş sürer
    engine.tick(10);
    expect(avatar.pos).toEqual({ x: 10, y: 4 }); // hedefine varır
  });

  it("epoch bump resets outright — no replayed choreography after a rebuild", () => {
    const engine = new OfficeSceneEngine();
    engine.applySnapshot(snapshot());
    engine.apply(walk(A, { x: 4, y: 4 }, { x: 10, y: 4 }, EVT(20)));
    engine.tick(0.2); // mid-walk
    engine.applySnapshot({ ...snapshot(), snapshotEpoch: snapshot().snapshotEpoch + 1 });
    const avatar = engine.avatars.get(A)!;
    expect(avatar.pos).toEqual({ x: 4, y: 4 });
    expect(avatar.queue).toHaveLength(0);
    expect(avatar.walking).toBeNull();
  });

  it("spawns unknown agents at the instruction's fromCell (live hire)", () => {
    const engine = new OfficeSceneEngine();
    engine.applySnapshot({ ...snapshot(), agents: [] });
    const NEW = "018f0000-0000-7000-8000-0000000000e1";
    engine.apply(walk(NEW, { x: 0, y: 0 }, { x: 6, y: 6 }, EVT(30)));
    engine.tick(0.001);
    engine.tick(5);
    expect(engine.avatars.get(NEW)!.pos).toEqual({ x: 6, y: 6 });
  });

  it("rejects instructions that fail the contract schema", () => {
    const engine = new OfficeSceneEngine();
    engine.applySnapshot(snapshot());
    expect(() =>
      engine.apply({ type: "office.avatar.moved", agentId: A, causeSeq: 1 }),
    ).toThrow();
  });
});

describe("officeStore causeEventId invariant (dev build throws)", () => {
  it("throws on an instruction without causeEventId and applies valid ones", () => {
    const store = useOfficeStore.getState();
    store.reset();
    expect(() =>
      useOfficeStore.getState().enqueue(
        instr({
          type: "office.status.changed",
          agentId: A,
          badge: "WORKING",
          causeEventId: undefined,
        }),
      ),
    ).toThrow(/causeEventId/);

    useOfficeStore.getState().applySnapshot(snapshot());
    useOfficeStore.getState().enqueue(
      instr({ type: "office.status.changed", agentId: A, badge: "WORKING", causeEventId: EVT(40) }),
    );
    const engine = useOfficeStore.getState().engine;
    engine.tick(0.001);
    expect(engine.avatars.get(A)!.badge).toBe("WORKING");
    expect(engine.lastAppliedEventId).toBe(EVT(40));
  });
});
