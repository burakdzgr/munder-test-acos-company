// FAZ 2B / 2B-2 — projektör talimatlarını SABİT KATA yansıtan katman.
//
// Sorun: talimatlar (office.avatar.moved / interaction.started) SUNUCUNUN
// kendi otomatik yerleşimine göre hücre taşıyor. Kat artık elle çizilmiş
// sabit bir harita olduğu için o hücreler bizde duvarın içine düşer.
//
// Çözüm: talimat motora GİRMEDEN önce koordinatları bu kata çeviriyoruz.
// Hareketin SEBEBİ, ZAMANI ve KİMİ ilgilendirdiği hâlâ tamamen talimattan
// geliyor — kimse talimatsız kıpırdamıyor (23 §4.1 korunur). Değişen yalnız
// GÜZERGÂH: sunucunun ızgarasındaki yol, bizim katımızda yürünebilir bir
// yola yeniden yansıtılıyor.
//
// Saf mantık: Pixi yok, zamanlayıcı yok, DOM yok.
import type { OfficeInstruction, PresenceState } from "@acos/contracts";
import { seatAgents, type SeatCandidate, type SeatedFloor } from "./seatPool.js";
import { nearestWalkable, routeOnFloor, zoneAnchor, type Cell, type OfficeMap } from "./tiledMap.js";

export interface RosterEntry {
  title?: string | null;
  executive?: boolean;
}

const sameCell = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y;

export class FloorProjector {
  /** ajan → SUNUCU ızgarasındaki son bilinen hücre (hedef çözümü için) */
  private serverCell = new Map<string, Cell>();
  private roster = new Map<string, RosterEntry>();
  private order: string[] = [];
  floor: SeatedFloor = { seats: new Map(), extraDesks: [], usedHeight: 0 };

  constructor(private readonly map: OfficeMap) {
    this.floor.usedHeight = map.height;
  }

  /** Unvan/tepe-yönetici bilgisi (koltuk eşlemesi için). */
  setRoster(roster: Map<string, RosterEntry>): boolean {
    const before = JSON.stringify([...this.roster.entries()].sort());
    const after = JSON.stringify([...roster.entries()].sort());
    if (before === after) return false;
    this.roster = new Map(roster);
    this.reseat();
    return true;
  }

  private reseat(): void {
    const candidates: SeatCandidate[] = this.order.map((agentId) => {
      const entry = this.roster.get(agentId);
      return {
        agentId,
        title: entry?.title ?? null,
        executive: entry?.executive ?? false,
      };
    });
    this.floor = seatAgents(this.map, candidates);
  }

  seatCell(agentId: string): Cell | null {
    return this.floor.seats.get(agentId)?.cell ?? null;
  }

  /**
   * Anlık görüntü: herkesin SUNUCU hücresi kaydedilir, sonra kadro bu kata
   * oturtulur ve görüntü bizim koordinatlarımızla yeniden yazılır.
   */
  projectSnapshot(state: PresenceState): PresenceState {
    this.order = state.agents.map((agent) => agent.agentId);
    for (const agent of state.agents) this.serverCell.set(agent.agentId, agent.cell);
    this.reseat();
    return {
      ...state,
      agents: state.agents.map((agent) => ({
        ...agent,
        cell: this.seatCell(agent.agentId) ?? agent.cell,
      })),
      interactions: state.interactions.map((interaction) => ({
        ...interaction,
        atCell: this.interactionCell(interaction.kind, interaction.atCell, interaction.agentIds),
      })),
    };
  }

  /** Sunucu hücresini bu kata çevir: önce koltuk sahibi, sonra oran, sonra en yakın. */
  private translate(cell: Cell, mover?: string): Cell {
    for (const [agentId, known] of this.serverCell) {
      if (agentId !== mover && sameCell(known, cell)) {
        const seat = this.seatCell(agentId);
        if (seat) return seat;
      }
    }
    // koltuk sahibi yok: ızgaralar arası oransal iz düşüm + en yakın yürünebilir
    const scaled = {
      x: Math.min(this.map.width - 1, Math.max(0, Math.round(cell.x))),
      y: Math.min(this.map.height - 1, Math.max(0, Math.round(cell.y))),
    };
    return nearestWalkable(this.map, scaled) ?? scaled;
  }

  private interactionCell(kind: string, atCell: Cell, agentIds: string[]): Cell {
    if (kind === "meeting") {
      const anchor = zoneAnchor(this.map, "boardroom");
      if (anchor) return anchor;
    }
    // ikili etkileşimler: karşı tarafın masasının önünde olsun
    const host = agentIds[0];
    const seat = host ? this.seatCell(host) : null;
    return seat ?? this.translate(atCell);
  }

  /**
   * Talimatı bu kata yansıtır. `null` = talimat bu katta anlamsız (yansıtılamadı)
   * — motora hiç verilmez, uydurma hareket üretilmez.
   */
  project(instruction: OfficeInstruction): OfficeInstruction | null {
    if (instruction.type === "office.avatar.moved") {
      const agentId = instruction.agentId;
      const serverTo = instruction.toCell;
      const from = this.seatCell(agentId) ?? this.translate(instruction.fromCell, agentId);
      const to =
        instruction.reason === "return_home" || instruction.reason === "desk_assign"
          ? (this.seatCell(agentId) ?? this.translate(serverTo, agentId))
          : this.translate(serverTo, agentId);
      // sunucu hücresini not et: sonraki hedef çözümleri buna bakıyor
      this.serverCell.set(agentId, serverTo);
      const path = routeOnFloor(this.map, from, to);
      if (path.length === 0) return null;
      return { ...instruction, fromCell: from, toCell: to, path };
    }
    if (instruction.type === "office.interaction.started") {
      return {
        ...instruction,
        atCell: this.interactionCell(instruction.kind, instruction.atCell, instruction.agentIds),
      };
    }
    return instruction;
  }
}
