// Headless office scene engine (23 §6–7): pure state machine — no Pixi, no
// timers, no DOM. The Pixi bridge calls tick(dt); tests drive it headlessly
// (32 §11.1: renderer is tested through the projector-instruction interface).
// ALL motion originates from projector instructions — there is no API here to
// move an avatar without one (the office lint rule bans animation calls
// elsewhere in this module).
import {
  OfficeInstructionSchema,
  type Cell,
  type OfficeInstruction,
  type OfficeLayout,
  type PresenceBadge,
  type PresenceState,
} from "@acos/contracts";

export const WALK_CELLS_PER_SEC = 6; // 23 §6 [WRITER-DECISION]
export const MAX_PENDING_WALKS = 3; // time-compression threshold
export const MAX_PREDICTED_PLAYBACK_SEC = 10;
export const DEBUG_RING_SIZE = 200;

type WalkCommand = {
  kind: "walk";
  path: Cell[];
  fromCell: Cell;
  toCell: Cell;
  causeEventId: string;
};
type BadgeCommand = { kind: "badge"; badge: PresenceBadge; causeEventId: string };
type AnimCommand = WalkCommand | BadgeCommand;

export interface SceneAvatar {
  agentId: string;
  name: string;
  /** interpolated position in cell units (floats mid-walk). */
  pos: { x: number; y: number };
  badge: PresenceBadge;
  deskId: string | null;
  queue: AnimCommand[];
  walking: { command: WalkCommand; travelled: number; length: number } | null;
  /** walks skipped by time compression since the last played one ("+N"). */
  collapsedCount: number;
}

export interface SceneInteraction {
  id: string;
  kind: string;
  agentIds: string[];
  atCell: Cell;
  causeEventId: string;
}

function pathLength(from: Cell, path: Cell[]): number {
  let length = 0;
  let previous = from;
  for (const cell of path) {
    length += Math.abs(cell.x - previous.x) + Math.abs(cell.y - previous.y);
    previous = cell;
  }
  return Math.max(length, 1);
}

function pointAlong(from: Cell, path: Cell[], travelled: number): { x: number; y: number } {
  let remaining = travelled;
  let previous: { x: number; y: number } = from;
  for (const cell of path) {
    const segment = Math.abs(cell.x - previous.x) + Math.abs(cell.y - previous.y);
    if (segment >= remaining) {
      const t = segment === 0 ? 1 : remaining / segment;
      return { x: previous.x + (cell.x - previous.x) * t, y: previous.y + (cell.y - previous.y) * t };
    }
    remaining -= segment;
    previous = cell;
  }
  return previous;
}

export class OfficeSceneEngine {
  layout: OfficeLayout | null = null;
  layoutVersion = 0;
  snapshotEpoch = 0;
  readonly avatars = new Map<string, SceneAvatar>();
  readonly interactions = new Map<string, SceneInteraction>();
  readonly debugRing: OfficeInstruction[] = [];
  lastAppliedEventId: string | null = null;
  /** bumped on every visible change — the render bridge diffs against it. */
  version = 0;

  // ---------- snapshot-then-delta (22 §5.3) ----------

  applySnapshot(state: PresenceState, layout?: OfficeLayout | null): void {
    // 2026-08-18 (Founder: "arada bir tekrar render oluyor"): WS her yeniden
    // bağlanışta snapshot yollar; sahneyi sıfırlamak herkesi ışınlıyor ve
    // ofis "baştan kuruluyor" gibi görünüyordu. Aynı epoch + aynı layout ise
    // YUMUŞAK birleştirme: rozet/masa/ad güncellenir, POZİSYON ve süren
    // yürüyüş korunur. Sert sıfırlama yalnız epoch/layout değişiminde —
    // 23 §6'nın "no replayed choreography" niyeti korunur (hiçbir şey
    // yeniden OYNATILMAZ; yalnız mevcut durum yerinde bırakılır).
    const hard =
      this.avatars.size === 0 ||
      state.snapshotEpoch !== this.snapshotEpoch ||
      state.layoutVersion !== this.layoutVersion;
    if (layout) this.layout = layout;
    this.layoutVersion = state.layoutVersion;
    this.snapshotEpoch = state.snapshotEpoch;

    if (hard) {
      // snapshot replaces queues outright — no replayed choreography (23 §6)
      this.avatars.clear();
      for (const agent of state.agents) {
        this.avatars.set(agent.agentId, {
          agentId: agent.agentId,
          name: agent.name,
          pos: { x: agent.cell.x, y: agent.cell.y },
          badge: agent.badge,
          deskId: agent.deskId,
          queue: [],
          walking: null,
          collapsedCount: 0,
        });
      }
    } else {
      const seen = new Set<string>();
      for (const agent of state.agents) {
        seen.add(agent.agentId);
        const existing = this.avatars.get(agent.agentId);
        if (existing) {
          existing.name = agent.name;
          existing.badge = agent.badge;
          existing.deskId = agent.deskId;
          // pos/queue/walking KORUNUR — yürüyen adam yürümeye devam eder
        } else {
          this.avatars.set(agent.agentId, {
            agentId: agent.agentId,
            name: agent.name,
            pos: { x: agent.cell.x, y: agent.cell.y },
            badge: agent.badge,
            deskId: agent.deskId,
            queue: [],
            walking: null,
            collapsedCount: 0,
          });
        }
      }
      for (const id of [...this.avatars.keys()]) {
        if (!seen.has(id)) this.avatars.delete(id);
      }
    }

    this.interactions.clear();
    for (const interaction of state.interactions) {
      this.interactions.set(interaction.id, { ...interaction });
    }
    this.version += 1;
  }

  /** REST-fetched floor plan (36 §7 — U04). Layout is presentation data —
   *  motion still originates exclusively from projector instructions. */
  setLayout(layout: OfficeLayout): void {
    this.layout = layout;
    this.layoutVersion += 1;
    this.version += 1;
  }

  // ---------- instruction intake (validated upstream by officeStore) ----------

  apply(raw: unknown): void {
    const instruction = OfficeInstructionSchema.parse(raw); // causeEventId enforced
    this.debugRing.push(instruction);
    if (this.debugRing.length > DEBUG_RING_SIZE) this.debugRing.shift();

    switch (instruction.type) {
      case "office.avatar.moved": {
        const avatar = this.ensureAvatar(instruction.agentId, instruction.fromCell);
        avatar.queue.push({
          kind: "walk",
          path: instruction.path,
          fromCell: instruction.fromCell,
          toCell: instruction.toCell,
          causeEventId: instruction.causeEventId,
        });
        this.compressIfNeeded(avatar);
        break;
      }
      case "office.status.changed": {
        const avatar = this.ensureAvatar(instruction.agentId, { x: 0, y: 0 });
        avatar.queue.push({
          kind: "badge",
          badge: instruction.badge,
          causeEventId: instruction.causeEventId,
        });
        break;
      }
      case "office.interaction.started": {
        this.interactions.set(instruction.interactionId, {
          id: instruction.interactionId,
          kind: instruction.kind,
          agentIds: instruction.agentIds,
          atCell: instruction.atCell,
          causeEventId: instruction.causeEventId,
        });
        this.lastAppliedEventId = instruction.causeEventId;
        break;
      }
      case "office.interaction.ended": {
        this.interactions.delete(instruction.interactionId);
        this.lastAppliedEventId = instruction.causeEventId;
        break;
      }
    }
    this.version += 1;
  }

  /** Agent left the company (offboard status ⇒ despawn handled by snapshot;
   *  live despawn keyed off an OFFLINE badge with no desk is a T26 nicety). */
  removeAvatar(agentId: string): void {
    this.avatars.delete(agentId);
    this.version += 1;
  }

  // ---------- ticker (bounded work per frame, 23 §9) ----------

  tick(dtSeconds: number): void {
    if (dtSeconds <= 0) return;
    let changed = false;
    for (const avatar of this.avatars.values()) {
      if (!avatar.walking) this.dequeue(avatar);
      if (avatar.walking) {
        const walk = avatar.walking;
        walk.travelled += dtSeconds * WALK_CELLS_PER_SEC;
        if (walk.travelled >= walk.length) {
          avatar.pos = { ...walk.command.toCell };
          avatar.walking = null;
          this.dequeue(avatar); // chain the next command in the same frame
        } else {
          avatar.pos = pointAlong(walk.command.fromCell, walk.command.path, walk.travelled);
        }
        changed = true;
      }
    }
    if (changed) this.version += 1;
  }

  private dequeue(avatar: SceneAvatar): void {
    for (;;) {
      const command = avatar.queue.shift();
      if (!command) return;
      this.lastAppliedEventId = command.causeEventId;
      if (command.kind === "badge") {
        avatar.badge = command.badge; // instant (23 §6)
        continue;
      }
      avatar.walking = {
        command,
        travelled: 0,
        length: pathLength(command.fromCell, command.path),
      };
      // avatar might have drifted (compression); walks replay from their own start
      avatar.pos = { x: command.fromCell.x, y: command.fromCell.y };
      return;
    }
  }

  /** 23 §6 time compression: >3 pending walks or >10 s predicted playback →
   *  collapse to the latest walk; intermediates are skipped with a counter. */
  private compressIfNeeded(avatar: SceneAvatar): void {
    const walks = avatar.queue.filter((c): c is WalkCommand => c.kind === "walk");
    const predictedSec =
      walks.reduce((sum, w) => sum + pathLength(w.fromCell, w.path), 0) / WALK_CELLS_PER_SEC;
    if (walks.length <= MAX_PENDING_WALKS && predictedSec <= MAX_PREDICTED_PLAYBACK_SEC) return;

    const lastWalk = walks[walks.length - 1]!;
    const skipped = walks.length - 1;
    // teleport-fade to the penultimate state: badges still apply, walks collapse
    avatar.queue = avatar.queue.filter((c) => c.kind !== "walk" || c === lastWalk);
    if (avatar.walking) {
      avatar.walking = null;
    }
    avatar.pos = { x: lastWalk.fromCell.x, y: lastWalk.fromCell.y };
    avatar.collapsedCount += skipped;
    this.version += 1;
  }

  private ensureAvatar(agentId: string, at: Cell): SceneAvatar {
    let avatar = this.avatars.get(agentId);
    if (!avatar) {
      avatar = {
        agentId,
        name: "Agent",
        pos: { x: at.x, y: at.y },
        badge: "IDLE",
        deskId: null,
        queue: [],
        walking: null,
        collapsedCount: 0,
      };
      this.avatars.set(agentId, avatar);
    }
    return avatar;
  }

  /** true while any avatar has queued/active motion (idle-floor decision). */
  get busy(): boolean {
    for (const avatar of this.avatars.values()) {
      if (avatar.walking || avatar.queue.length > 0) return true;
    }
    return false;
  }
}
