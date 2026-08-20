// T25 acceptance (23 §14): golden-file style tests — given event stream X the
// projector emits exactly instruction stream Y (deterministic §4.2); the hard
// invariant "no instruction without causeEventId" throws; timer-driven
// endings (dwell/speech) carry the originating event id; per-company
// choreoSeq is strictly monotonic.
import { describe, expect, it } from "vitest";
import { OfficeInstructionSchema, type OfficeInstruction } from "@acos/contracts";
import {
  DM_DWELL_MS,
  OfficeProjector,
  SPEECH_MS,
  sealInstruction,
  type OfficeCompanyData,
  type ProjectorEnvelope,
} from "./projector.js";

const COMPANY = "018f0000-0000-7000-8000-00000000c0c0";
const DEPT = "018f0000-0000-7000-8000-00000000d001";
const ALICE = "018f0000-0000-7000-8000-0000000000a1";
const BOB = "018f0000-0000-7000-8000-0000000000b1";
const CARO = "018f0000-0000-7000-8000-0000000000c1";
const NEW_AGENT = "018f0000-0000-7000-8000-0000000000e1";

const FIXED_NOW = new Date("2026-08-11T12:00:00.000Z");

function companyData(): OfficeCompanyData {
  return {
    units: [{ id: DEPT, name: "Engineering", kind: "department", parentId: null }],
    agents: [
      { id: ALICE, name: "Alice", status: "active", orgUnitId: DEPT },
      { id: BOB, name: "Bob", status: "active", orgUnitId: DEPT },
      { id: CARO, name: "Caro", status: "active", orgUnitId: DEPT },
    ],
    reportsTo: { [ALICE]: BOB },
    savedLayout: null,
  };
}

interface Harness {
  projector: OfficeProjector;
  published: Array<{ companyId: string; instruction: OfficeInstruction }>;
  timers: Array<{ delayMs: number; fn: () => void; cancelled: boolean }>;
  fire: (index: number) => void;
}

function makeHarness(data: OfficeCompanyData = companyData()): Harness {
  const published: Harness["published"] = [];
  const timers: Harness["timers"] = [];
  const projector = new OfficeProjector({
    loadCompanyData: async () => data,
    publish: (companyId, instruction) => published.push({ companyId, instruction }),
    now: () => FIXED_NOW,
    schedule: (delayMs, fn) => {
      const entry = { delayMs, fn, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  });
  return {
    projector,
    published,
    timers,
    fire: (index) => {
      const timer = timers[index]!;
      if (!timer.cancelled) timer.fn();
    },
  };
}

let seqCounter = 0;
function envelope(
  type: string,
  payload: unknown,
  agentId: string | null = null,
): ProjectorEnvelope {
  seqCounter += 1;
  return {
    id: `018f0000-0000-7000-8000-${String(seqCounter).padStart(12, "0")}`,
    companyId: COMPANY,
    seq: seqCounter,
    type,
    occurredAt: FIXED_NOW.toISOString(),
    actor: { kind: "agent", id: agentId },
    subject: { taskId: null, projectId: null, agentId },
    payload,
  };
}

describe("org yapısı değişince layout yeniden kurulur (2026-08-14 kök neden)", () => {
  it("boş org'la donan plan, org.unit.created sonrası odaları kazanır ve avatarlar masaya yürür", async () => {
    // boş şirketle boot (Founder senaryosu: önce ofis açıldı, org sonra kuruldu)
    const data: OfficeCompanyData = { units: [], agents: [], reportsTo: {}, savedLayout: null };
    const h = makeHarness(data);
    await h.projector.snapshot(COMPANY); // state boş org'la donar

    // ajan işe alındı (henüz oda yok — girişte kalır)
    await h.projector.handleEvent(
      envelope("agent.hired", { agentId: ALICE, name: "Alice", orgUnitId: DEPT }),
    );

    // org kuruldu → loader artık birimi + ajanı görüyor
    data.units.push({ id: DEPT, name: "Engineering", kind: "department", parentId: null });
    data.agents.push({ id: ALICE, name: "Alice", status: "active", orgUnitId: DEPT });
    const unitEvent = envelope("org.unit.created", { orgUnitId: DEPT, kind: "department" });
    const emitted = await h.projector.handleEvent(unitEvent);

    const layout = await h.projector.layoutFor(COMPANY);
    expect(layout.zones.some((z) => z.orgUnitId === DEPT)).toBe(true);

    const move = emitted.find((i) => i.type === "office.avatar.moved");
    expect(move).toBeDefined();
    expect(move!.causeEventId).toBe(unitEvent.id); // N2: nedensel zincir korunur

    const snapshot = await h.projector.snapshot(COMPANY);
    expect(snapshot.agents.find((a) => a.agentId === ALICE)?.deskId).not.toBeNull();
  });
});

describe("hard invariant: no instruction without causeEventId", () => {
  it("sealInstruction throws when causeEventId is missing", () => {
    expect(() =>
      sealInstruction(
        { choreoSeq: 0 },
        {
          type: "office.status.changed",
          agentId: ALICE,
          badge: "IDLE",
          causeSeq: 1,
        } as never, // no causeEventId — must throw before publish
        FIXED_NOW,
      ),
    ).toThrow();
    expect(() =>
      sealInstruction(
        { choreoSeq: 0 },
        {
          type: "office.status.changed",
          agentId: ALICE,
          badge: "IDLE",
          causeEventId: null,
          causeSeq: 1,
        } as never,
        FIXED_NOW,
      ),
    ).toThrow();
  });

  it("every instruction from a mixed stream validates against the contract", async () => {
    const h = makeHarness();
    const stream = [
      envelope("agent.hired", { agentId: NEW_AGENT, name: "Newbie" }, NEW_AGENT),
      envelope("agent.message.sent", { messageId: ALICE, channelId: ALICE, kind: "dm", mentions: [BOB], senderAgentId: ALICE }, ALICE),
      envelope("agent.task.started", { agentId: CARO }, CARO),
      envelope("agent.escalated", { reason: "stuck" }, ALICE),
      envelope("agent.paused", { reason: "manual" }, CARO),
      envelope("agent.offboarded", { reason: "done" }, NEW_AGENT),
    ];
    for (const event of stream) await h.projector.handleEvent(event);
    h.timers.forEach((_, i) => h.fire(i)); // all dwell/speech endings
    expect(h.published.length).toBeGreaterThan(8);
    for (const { instruction } of h.published) {
      expect(() => OfficeInstructionSchema.parse(instruction)).not.toThrow();
      expect(instruction.causeEventId).toBeTruthy();
    }
    // choreoSeq strictly monotonic per company (23 §4.2)
    const seqs = h.published.map((p) => p.instruction.choreoSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe("golden choreography (23 §4.1 mapping rows)", () => {
  it("agent.hired → desk-assign walk from the entrance + IDLE badge", async () => {
    const h = makeHarness();
    const hired = envelope("agent.hired", { agentId: NEW_AGENT, name: "Newbie" }, NEW_AGENT);
    const emitted = await h.projector.handleEvent(hired);
    expect(emitted.map((i) => i.type)).toEqual([
      "office.avatar.moved",
      "office.status.changed",
    ]);
    const move = emitted[0] as Extract<OfficeInstruction, { type: "office.avatar.moved" }>;
    expect(move.reason).toBe("desk_assign");
    expect(move.fromCell).toEqual({ x: 0, y: 0 });
    expect(move.causeEventId).toBe(hired.id);
    expect(move.path.length).toBeGreaterThan(0);
    const badge = emitted[1] as Extract<OfficeInstruction, { type: "office.status.changed" }>;
    expect(badge).toMatchObject({ agentId: NEW_AGENT, badge: "IDLE", causeEventId: hired.id });
    // spawned at a real desk: snapshot shows the desk cell, not the entrance
    const snapshot = await h.projector.snapshot(COMPANY);
    const newbie = snapshot.agents.find((a) => a.agentId === NEW_AGENT)!;
    expect(newbie.deskId).not.toBeNull();
    expect(newbie.cell).toEqual(move.toCell);
  });

  it("dm: walk to recipient desk → interaction → dwell timeout ends + return home", async () => {
    const h = makeHarness();
    const dm = envelope(
      "agent.message.sent",
      { messageId: ALICE, channelId: ALICE, kind: "dm", mentions: [BOB], senderAgentId: ALICE },
      ALICE,
    );
    const emitted = await h.projector.handleEvent(dm);
    expect(emitted.map((i) => i.type)).toEqual([
      "office.avatar.moved",
      "office.interaction.started",
      "office.status.changed",
    ]);
    const move = emitted[0] as Extract<OfficeInstruction, { type: "office.avatar.moved" }>;
    const snapshotBefore = await h.projector.snapshot(COMPANY);
    const bobCell = snapshotBefore.agents.find((a) => a.agentId === BOB)!.cell;
    expect(move).toMatchObject({ agentId: ALICE, reason: "dm", toCell: bobCell });
    const started = emitted[1] as Extract<OfficeInstruction, { type: "office.interaction.started" }>;
    expect(started).toMatchObject({ kind: "dm", agentIds: [ALICE, BOB], causeEventId: dm.id });

    // dwell timer (12 s) fires → ended(dwell_timeout) + return walk, SAME cause id
    expect(h.timers[0]!.delayMs).toBe(DM_DWELL_MS);
    h.fire(0);
    const tail = h.published.slice(3).map((p) => p.instruction);
    expect(tail.map((i) => i.type)).toEqual(["office.interaction.ended", "office.avatar.moved"]);
    expect(tail[0]).toMatchObject({ endedBy: "dwell_timeout", causeEventId: dm.id });
    expect(tail[1]).toMatchObject({ agentId: ALICE, reason: "return_home", causeEventId: dm.id });
  });

  it("sender's next non-message activity ends the dwell early with the original cause", async () => {
    const h = makeHarness();
    const dm = envelope(
      "agent.message.sent",
      { messageId: ALICE, channelId: ALICE, kind: "dm", mentions: [BOB], senderAgentId: ALICE },
      ALICE,
    );
    await h.projector.handleEvent(dm);
    const next = envelope("agent.task.started", { agentId: ALICE }, ALICE);
    await h.projector.handleEvent(next);
    const types = h.published.map((p) => p.instruction.type);
    expect(types).toEqual([
      "office.avatar.moved", // walk to Bob
      "office.interaction.started",
      "office.status.changed", // COMMUNICATING
      "office.interaction.ended", // ended by the next activity event
      "office.avatar.moved", // return home
      "office.status.changed", // WORKING (from agent.task.started)
    ]);
    // the early end is CAUSED by the new activity event — that id is the cause
    const ended = h.published[3]!.instruction;
    expect(ended).toMatchObject({ endedBy: "event", causeEventId: next.id });
    // the dwell timer was cancelled — firing it later emits nothing
    const count = h.published.length;
    h.fire(0);
    expect(h.published.length).toBe(count);
  });

  it("channel message → 4 s speech indicator at the sender's desk, no walk", async () => {
    const h = makeHarness();
    const message = envelope(
      "agent.message.sent",
      { messageId: ALICE, channelId: ALICE, kind: "message", mentions: [], senderAgentId: ALICE },
      ALICE,
    );
    const emitted = await h.projector.handleEvent(message);
    expect(emitted.map((i) => i.type)).toEqual([
      "office.interaction.started",
      "office.status.changed",
    ]);
    expect(emitted[0]).toMatchObject({ kind: "speech", agentIds: [ALICE] });
    expect(h.timers[0]!.delayMs).toBe(SPEECH_MS);
    h.fire(0);
    const last = h.published[h.published.length - 1]!.instruction;
    expect(last).toMatchObject({
      type: "office.interaction.ended",
      endedBy: "speech_timeout",
      causeEventId: message.id,
    });
  });

  it("agent.escalated walks to the reports_to manager with a red-bubble interaction", async () => {
    const h = makeHarness();
    const escalated = envelope("agent.escalated", { reason: "blocked" }, ALICE);
    const emitted = await h.projector.handleEvent(escalated);
    expect(emitted.map((i) => i.type)).toEqual([
      "office.avatar.moved",
      "office.interaction.started",
      "office.status.changed",
    ]);
    expect(emitted[0]).toMatchObject({ agentId: ALICE, reason: "escalation" });
    expect(emitted[1]).toMatchObject({ kind: "escalation", agentIds: [ALICE, BOB] });
    expect(emitted[2]).toMatchObject({ agentId: ALICE, badge: "ESCALATING" });
  });

  it("founder-level escalation (no manager) = badge only, no walk", async () => {
    const h = makeHarness();
    const escalated = envelope("agent.escalated", { toFounder: true }, CARO);
    const emitted = await h.projector.handleEvent(escalated);
    expect(emitted.map((i) => i.type)).toEqual(["office.status.changed"]);
    expect(emitted[0]).toMatchObject({ agentId: CARO, badge: "ESCALATING" });
  });

  it("task start / status change / session activity map to truthful badges", async () => {
    const h = makeHarness();
    const started = await h.projector.handleEvent(
      envelope("agent.task.started", { agentId: CARO }, CARO),
    );
    expect(started[0]).toMatchObject({ type: "office.status.changed", badge: "WORKING" });

    const inProgress = await h.projector.handleEvent(
      envelope("task.status.changed", { from: "ASSIGNED", to: "IN_PROGRESS", byActor: { kind: "agent", id: ALICE } }),
    );
    expect(inProgress[0]).toMatchObject({ agentId: ALICE, badge: "WORKING" });

    const thinking = await h.projector.handleEvent(
      envelope("agent.status.changed", { from: "WORKING", to: "thinking" }, ALICE),
    );
    expect(thinking[0]).toMatchObject({ agentId: ALICE, badge: "THINKING" });

    // duplicate badge is coalesced — no instruction
    const again = await h.projector.handleEvent(
      envelope("agent.status.changed", { from: "THINKING", to: "THINKING" }, ALICE),
    );
    expect(again).toHaveLength(0);
  });

  it("offboarding ends interactions, sets OFFLINE, frees the desk", async () => {
    const h = makeHarness();
    await h.projector.handleEvent(
      envelope(
        "agent.message.sent",
        { messageId: ALICE, channelId: ALICE, kind: "dm", mentions: [ALICE], senderAgentId: BOB },
        BOB,
      ),
    );
    const offboarded = envelope("agent.offboarded", { reason: "done" }, BOB);
    await h.projector.handleEvent(offboarded);
    const types = h.published.map((p) => p.instruction.type);
    expect(types).toContain("office.interaction.ended");
    const snapshot = await h.projector.snapshot(COMPANY);
    expect(snapshot.agents.find((a) => a.agentId === BOB)).toBeUndefined();
    expect(snapshot.interactions).toHaveLength(0);
  });

  it("deterministic: the same stream twice yields byte-identical instructions", async () => {
    const run = async () => {
      seqCounter = 100;
      const h = makeHarness();
      await h.projector.handleEvent(
        envelope("agent.hired", { agentId: NEW_AGENT, name: "Newbie" }, NEW_AGENT),
      );
      await h.projector.handleEvent(
        envelope(
          "agent.message.sent",
          { messageId: ALICE, channelId: ALICE, kind: "dm", mentions: [BOB], senderAgentId: ALICE },
          ALICE,
        ),
      );
      h.fire(0);
      return JSON.stringify(h.published);
    };
    expect(await run()).toEqual(await run());
  });

  it("stale backlog (>30 s) keeps badges truthful but skips walks (23 §13)", async () => {
    const h = makeHarness();
    const old = envelope(
      "agent.message.sent",
      { messageId: ALICE, channelId: ALICE, kind: "dm", mentions: [BOB], senderAgentId: ALICE },
      ALICE,
    );
    old.occurredAt = new Date(FIXED_NOW.getTime() - 60_000).toISOString();
    const emitted = await h.projector.handleEvent(old);
    expect(emitted).toHaveLength(0); // no stale walking

    const oldStatus = envelope("agent.status.changed", { from: "IDLE", to: "WORKING" }, CARO);
    oldStatus.occurredAt = new Date(FIXED_NOW.getTime() - 60_000).toISOString();
    const badges = await h.projector.handleEvent(oldStatus);
    expect(badges[0]).toMatchObject({ type: "office.status.changed", badge: "WORKING" });
  });

  it("presence snapshot seeds every active agent at a home desk (23 §13 restart)", async () => {
    const h = makeHarness();
    const snapshot = await h.projector.snapshot(COMPANY);
    expect(snapshot.agents).toHaveLength(3);
    for (const agent of snapshot.agents) {
      expect(agent.deskId).not.toBeNull();
      expect(agent.badge).toBe("IDLE");
    }
    // desks are distinct
    expect(new Set(snapshot.agents.map((a) => a.deskId)).size).toBe(3);
    expect(snapshot.layoutVersion).toBe(1);
    expect(snapshot.snapshotEpoch).toBe(1);
  });
});

describe("oturum adımı koreografisi (2026-08-18 — agent.step.recorded)", () => {
  it("düşünme/araç/iletişim adımları rozetlere yansır", async () => {
    const h = makeHarness();
    const think = await h.projector.handleEvent(
      envelope("agent.step.recorded", { sessionId: ALICE, stepNo: 1, actionType: "record_decision" }, ALICE),
    );
    expect(think[0]).toMatchObject({ type: "office.status.changed", agentId: ALICE, badge: "THINKING" });

    const tool = await h.projector.handleEvent(
      envelope("agent.step.recorded", { sessionId: ALICE, stepNo: 2, actionType: "use_tool" }, ALICE),
    );
    expect(tool[0]).toMatchObject({ agentId: ALICE, badge: "WORKING" });

    // aynı rozet tekrar gelirse talimat çıkmaz (coalesce)
    const again = await h.projector.handleEvent(
      envelope("agent.step.recorded", { sessionId: ALICE, stepNo: 3, actionType: "use_tool" }, ALICE),
    );
    expect(again).toHaveLength(0);
  });

  it("complete_task → yöneticiye rapor yürüyüşü + dwell sonrası eve dönüş", async () => {
    const h = makeHarness(); // reportsTo: ALICE → BOB
    const done = await h.projector.handleEvent(
      envelope("agent.step.recorded", { sessionId: ALICE, stepNo: 9, actionType: "complete_task" }, ALICE),
    );
    const walk = done.find((i) => i.type === "office.avatar.moved");
    expect(walk).toMatchObject({ agentId: ALICE, reason: "dm" });
    expect(done.some((i) => i.type === "office.interaction.started")).toBe(true);

    // dwell zamanlayıcısı ateşlenince yürüyen masasına döner (return_home)
    h.fire(h.timers.length - 1);
    const returned = h.published
      .map((p) => p.instruction)
      .find((i) => i.type === "office.avatar.moved" && i.reason === "return_home");
    expect(returned).toMatchObject({ agentId: ALICE });
  });

  it("yöneticisi olmayan ajanın complete_task'ı yürüyüş üretmez", async () => {
    const h = makeHarness(); // CARO'nun yöneticisi yok
    const done = await h.projector.handleEvent(
      envelope("agent.step.recorded", { sessionId: CARO, stepNo: 4, actionType: "complete_task" }, CARO),
    );
    expect(done.every((i) => i.type !== "office.avatar.moved")).toBe(true);
  });
});

describe("delegasyon koreografisi (2026-08-18 — agent.task.assigned)", () => {
  it("yönetici atadığı ajanın masasına yürür ve dwell sonrası döner", async () => {
    const h = makeHarness();
    const out = await h.projector.handleEvent(
      envelope("agent.task.assigned", { taskId: ALICE, agentId: ALICE, byAgentId: BOB }, ALICE),
    );
    const walk = out.find((i) => i.type === "office.avatar.moved");
    expect(walk).toMatchObject({ agentId: BOB, reason: "dm" });
    h.fire(h.timers.length - 1);
    const home = h.published
      .map((p) => p.instruction)
      .find((i) => i.type === "office.avatar.moved" && i.reason === "return_home");
    expect(home).toMatchObject({ agentId: BOB });
  });

  it("kendine atama yürüyüş üretmez", async () => {
    const h = makeHarness();
    const out = await h.projector.handleEvent(
      envelope("agent.task.assigned", { taskId: ALICE, agentId: BOB, byAgentId: BOB }, BOB),
    );
    expect(out.every((i) => i.type !== "office.avatar.moved")).toBe(true);
  });
});

// CANLI KOSUM GORUNURLUGU (2026-08-21): Founder 4 ajanli bir kosumu
// izlerken "bekleyen" ve "frenlenen" anlar ofiste HIC gorunmuyordu —
// park eden ajan ekranda yazmaya devam ediyordu. Rozet artik son adimi
// takip eder; park WAITING, guard freni BLOCKED, uyanma tekrar WORKING.
describe("bekleme/uyanma/fren rozetleri (2026-08-21 — canli kosum izlenebilirligi)", () => {
  it("wait_for parki WAITING cizer, sonraki adim ajani WORKING'e dondurur (uyanma gorunur)", async () => {
    const h = makeHarness();
    const park = await h.projector.handleEvent(
      envelope("agent.step.recorded", { sessionId: ALICE, stepNo: 5, actionType: "wait_for" }, ALICE),
    );
    expect(park[0]).toMatchObject({ type: "office.status.changed", agentId: ALICE, badge: "WAITING" });

    // uyanma: sistem aktoruyle gelen WAITING→IN_PROGRESS gecisi sahibi
    // cozemiyor; gorunurlugu saglayan sey ajanin ATTIGI ADIM.
    const wake = await h.projector.handleEvent(
      envelope("agent.step.recorded", { sessionId: ALICE, stepNo: 6, actionType: "use_tool" }, ALICE),
    );
    expect(wake[0]).toMatchObject({ agentId: ALICE, badge: "WORKING" });
  });

  it("request_help konusma rozetidir (blokajin ilk adresi yoneticidir)", async () => {
    const h = makeHarness();
    const help = await h.projector.handleEvent(
      envelope("agent.step.recorded", { sessionId: ALICE, stepNo: 3, actionType: "request_help" }, ALICE),
    );
    expect(help[0]).toMatchObject({ agentId: ALICE, badge: "COMMUNICATING" });
  });

  it("adi konmamis bir adim da hayat belirtisidir: rozet WORKING'e duser", async () => {
    const h = makeHarness();
    const step = await h.projector.handleEvent(
      envelope("agent.step.recorded", { sessionId: ALICE, stepNo: 1, actionType: "create_task" }, ALICE),
    );
    expect(step[0]).toMatchObject({ agentId: ALICE, badge: "WORKING" });
  });

  it("guard freni (loop/butce/adim tavani) BLOCKED cizer; deadline cizmez (o eskalasyon yolu)", async () => {
    const h = makeHarness();
    const tripped = await h.projector.handleEvent(
      envelope("agent.guard.triggered", { guard: "loop", context: {} }, ALICE),
    );
    expect(tripped[0]).toMatchObject({ agentId: ALICE, badge: "BLOCKED" });

    const deadline = await h.projector.handleEvent(
      envelope("agent.guard.triggered", { guard: "deadline", context: {} }, BOB),
    );
    expect(deadline.every((i) => i.type !== "office.status.changed")).toBe(true);
  });
});
