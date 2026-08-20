// FAZ 2B / 2B-2 — koltuk dağıtımı + KATIN OTOMATİK BÜYÜMESİ. Saf veri.
//
// Munder'ın SeatPool'u sabit listeyi sırayla dağıtır ve DOLUNCA null döner —
// yani fazla ajan yersiz kalır. İnsan kararı bunun tersi: kat BÜYÜSÜN, kimse
// ayakta kalmasın. Bu yüzden havuz tükendiğinde haritanın altına yeni masa
// adaları üretiyoruz (deterministik yerleşim, aynı ajan hep aynı koltuk).
//
// Rol eşlemesi: haritadaki isimli koltuklar (desk-ceo, desk-team-lead,
// desk-backend-engineer…) önce UNVANA göre dağıtılır; eşleşmeyen ajanlar
// kalan koltukları harita sırasına göre alır. Böylece CEO hep CEO odasında
// oturur — Munder'ın kompozisyonunun anlamı da bu.
import type { Cell, OfficeMap } from "./tiledMap.js";

export interface SeatAssignment {
  agentId: string;
  seat: string;
  cell: Cell;
  /** haritada olmayan, büyüme sırasında üretilmiş koltuk */
  grown: boolean;
}

export interface SeatedFloor {
  seats: Map<string, SeatAssignment>;
  /** büyüme sırasında eklenen masalar (köprü bunları da çizer) */
  extraDesks: Array<{ seat: string; deskCell: Cell; standCell: Cell }>;
  /** büyüme sonrası kullanılan satır sayısı (kamera bunu sığdırır) */
  usedHeight: number;
}

export interface SeatCandidate {
  agentId: string;
  /** pozisyon unvanı ya da rolü — koltuk eşlemesi için ipucu */
  title?: string | null;
  /** şirketin tepe yöneticisi mi (CEO koltuğu) */
  executive?: boolean;
}

/** Unvandan koltuk anahtarına kaba eşleme (Türkçe + İngilizce ipuçları). */
const TITLE_HINTS: Array<{ test: RegExp; seat: string }> = [
  { test: /(ceo|genel müdür|kurucu)/i, seat: "desk-ceo" },
  { test: /(team lead|takım lideri|tech lead|lider)/i, seat: "desk-team-lead" },
  { test: /(product|ürün)/i, seat: "desk-product-manager" },
  { test: /(backend|sunucu|api)/i, seat: "desk-backend-engineer" },
  { test: /(frontend|arayüz|ön uç)/i, seat: "desk-frontend-engineer" },
  { test: /(data|veri)/i, seat: "desk-data-engineer" },
  { test: /(project|proje yönet)/i, seat: "desk-project-manager" },
];

/** Büyüme adaları: haritanın altına 4'lü sıralar hâlinde masa ekler. */
const GROW_COLS = [4, 8, 12, 16, 20, 24, 28];
const GROW_ROW_STRIDE = 3;

export function seatAgents(map: OfficeMap, agents: SeatCandidate[]): SeatedFloor {
  const seats = new Map<string, SeatAssignment>();
  const taken = new Set<string>();
  const extraDesks: SeatedFloor["extraDesks"] = [];

  const claim = (agent: SeatCandidate, seat: string): void => {
    const cell = map.seats.get(seat);
    if (!cell) return;
    taken.add(seat);
    seats.set(agent.agentId, { agentId: agent.agentId, seat, cell, grown: false });
  };

  // 1) unvana göre eşleşenler (CEO önce — tepe yönetici bayrağı unvanı ezer)
  const pending: SeatCandidate[] = [];
  for (const agent of agents) {
    const wanted = agent.executive
      ? "desk-ceo"
      : (TITLE_HINTS.find((hint) => hint.test.test(agent.title ?? ""))?.seat ?? null);
    if (wanted && map.seats.has(wanted) && !taken.has(wanted)) claim(agent, wanted);
    else pending.push(agent);
  }

  // 2) kalanlar harita sırasına göre
  const free = map.seatOrder.filter((seat) => !taken.has(seat));
  let index = 0;
  const overflow: SeatCandidate[] = [];
  for (const agent of pending) {
    const seat = free[index];
    if (seat === undefined) {
      overflow.push(agent);
      continue;
    }
    index += 1;
    claim(agent, seat);
  }

  // 3) KAT BÜYÜR: kalan herkese yeni masa üret (koltuk tavanı YOK)
  let usedHeight = map.height;
  overflow.forEach((agent, i) => {
    const col = GROW_COLS[i % GROW_COLS.length] ?? 4;
    const row = map.height + Math.floor(i / GROW_COLS.length) * GROW_ROW_STRIDE + 1;
    const seat = `grown-${i + 1}`;
    const deskCell = { x: col, y: row };
    const standCell = { x: col, y: row + 1 };
    extraDesks.push({ seat, deskCell, standCell });
    seats.set(agent.agentId, {
      agentId: agent.agentId,
      seat,
      cell: standCell,
      grown: true,
    });
    usedHeight = Math.max(usedHeight, row + 3);
  });

  return { seats, extraDesks, usedHeight };
}

/** Bir hücre hangi ajanın koltuğu? (talimat hedefini kata çevirmek için) */
export function agentAtCell(floor: SeatedFloor, cell: Cell): string | null {
  for (const assignment of floor.seats.values()) {
    if (assignment.cell.x === cell.x && assignment.cell.y === cell.y) return assignment.agentId;
  }
  return null;
}
