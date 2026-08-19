// Default auto-layout (23 §2, revised): computed server-side when a company
// has no saved layout. Deterministic — zones are seeded by org-unit UUID
// order, so the same org data always yields the same floor plan.
//
// ODA BİRİMİ = TAKIM (revizyon). İlk sürümde oda birimi departmandı ve
// takımlar o odanın içinde yalnızca masa kümesiydi; ekranda tek bir dev
// "ENGINEERING" salonu görünüyor, Backend/Frontend/DevOps/QA ayrımı hiç
// okunmuyordu. Artık her takım kendi salonunu alır; departman ise salonları
// bir arada tutan ve ortak vurgu rengini veren KUŞAK olur. Takıma bağlı
// olmayan departman üyeleri o departmanın "Genel" salonuna oturur.
//
// Oda boyu personel sayısından gelir (kişi başı bir masa +%25 yedek), sabit
// değil: sabit yükseklik 2 kişilik bir takıma 22 hücrelik boş salon veriyordu.
import type { OfficeLayout, OfficeZone, OfficeDesk } from "@acos/contracts";

export interface OrgUnitInput {
  id: string;
  name: string;
  kind: string;
  parentId: string | null;
}

export interface AgentInput {
  id: string;
  name: string;
  status: string;
  orgUnitId: string;
}

const CELL_SIZE = 32;
const ROOM_TOP = 1;
/**
 * Oda arası boşluk = 0 (2026-08-18, Founder kararı): odalar duvar paylaşır —
 * her odanın kendi 0.8 hücrelik duvarı rect'inin İÇİNDE çizildiği için bitişik
 * iki oda arasında kalın tek bir duvar okunur; koridor yalnız sıralar arasında
 * (ROW_GAP) ve kapıların açıldığı bantta kalır. "Aralardaki boşluklar" gitti.
 */
const ROOM_GAP = 0;
const ROW_GAP = 2;
/**
 * Masa aralığı (hücre).
 *
 * 2 idi ve masa çizimi tam 2 hücre geniş olduğu için masalar birbirine
 * yapışıyordu; yakınlaştırınca ajan isimleri de üst üste biniyordu. 3, masa
 * başına bir hücre nefes payı bırakıyor.
 */
const DESK_STEP = 3;
/** Salonun üstünde tabela için ayrılan, masasız şerit. */
const LABEL_BAND = 3;
/** Salonun altında kapı/geçiş için ayrılan boşluk. */
const DOOR_BAND = 2;
/** Departman vurgu renkleri — packages/ui departmentColors ile aynı sıra. */
const DEPARTMENT_ACCENTS = [
  "#4c9aff",
  "#a879ff",
  "#3fd0a0",
  "#ffcb47",
  "#ff8a5c",
  "#ff6b8a",
];

/** Walks a unit up to its department (or itself when already top-level). */
function departmentOf(unitId: string, unitsById: Map<string, OrgUnitInput>): OrgUnitInput | null {
  let current = unitsById.get(unitId) ?? null;
  for (let hops = 0; current && hops < 20; hops++) {
    if (current.kind === "department" || current.parentId === null) return current;
    current = unitsById.get(current.parentId) ?? null;
  }
  return current;
}

/** Bir salonun personelinden türeyen ölçüsü. */
function roomSize(headcount: number): { deskCount: number; perRow: number; w: number; h: number } {
  const deskCount = Math.max(headcount + Math.max(1, Math.ceil(headcount * 0.25)), 2);
  const perRow = Math.max(2, Math.min(5, Math.ceil(Math.sqrt(deskCount))));
  const rows = Math.ceil(deskCount / perRow);
  return {
    deskCount,
    perRow,
    w: perRow * DESK_STEP + 3,
    h: LABEL_BAND + rows * DESK_STEP + DOOR_BAND,
  };
}

export function computeAutoLayout(units: OrgUnitInput[], agents: AgentInput[]): OfficeLayout {
  const unitsById = new Map(units.map((u) => [u.id, u]));
  const active = agents.filter((a) => a.status === "active" || a.status === "draft");

  // Salon kovası = ajanın KENDİ birimi (takım). Departmana doğrudan bağlı
  // üyeler departman kovasında toplanır ve "Genel" salonunu oluşturur.
  const byUnit = new Map<string, AgentInput[]>();
  for (const agent of active) {
    const key = unitsById.has(agent.orgUnitId) ? agent.orgUnitId : "unassigned";
    const bucket = byUnit.get(key) ?? [];
    bucket.push(agent);
    byUnit.set(key, bucket);
  }

  // Departman → o departmanın salonları. Sıralama tamamen uuid tabanlı:
  // aynı org verisi her zaman aynı planı üretir (23 §2 determinizm şartı).
  const byDepartment = new Map<string, string[]>();
  for (const unitId of [...byUnit.keys()].sort()) {
    const department = unitId === "unassigned" ? null : departmentOf(unitId, unitsById);
    const key = department?.id ?? "unassigned";
    const bucket = byDepartment.get(key) ?? [];
    bucket.push(unitId);
    byDepartment.set(key, bucket);
  }

  // 1. geçiş: salon ölçüleri (paketlemeden önce hepsi bilinmeli)
  interface RoomPlan {
    unitId: string;
    unit: OrgUnitInput | null;
    members: AgentInput[];
    size: ReturnType<typeof roomSize>;
    accent: string;
    label: string;
  }
  const roomPlans: RoomPlan[] = [];
  [...byDepartment.keys()].sort().forEach((departmentId, departmentIndex) => {
    const accent = DEPARTMENT_ACCENTS[departmentIndex % DEPARTMENT_ACCENTS.length]!;
    const department = unitsById.get(departmentId);
    for (const unitId of byDepartment.get(departmentId)!) {
      const members = byUnit.get(unitId)!.slice().sort((a, b) => a.id.localeCompare(b.id));
      const unit = unitId === "unassigned" ? null : unitsById.get(unitId) ?? null;
      const isDepartmentBucket = unit?.kind === "department" || unit == null;
      const label = isDepartmentBucket
        ? `${department?.name ?? unit?.name ?? "Genel"} Genel`
        : (unit?.name ?? "Genel");
      roomPlans.push({ unitId, unit, members, size: roomSize(members.length), accent, label });
    }
  });

  // 2026-08-18 (Founder kararı, "aralardaki boşluklar"): salonlar YÜKSEKLİĞE
  // göre sıralanıp raf-paketlenir — bir satırdaki odalar benzer boyda olur ve
  // kalabalık odanın yanında dev gri boşluk kalmaz. Satır genişliği sabit
  // değil, toplam alandan YATAY hedef oranla türer (paneller genellikle geniş). Sıralama deterministik
  // (boy → en → unitId); departman renk kümelenmesi bilinçli feda edildi.
  roomPlans.sort(
    (a, b) => b.size.h - a.size.h || b.size.w - a.size.w || a.unitId.localeCompare(b.unitId),
  );
  const totalArea = roomPlans.reduce((sum, r) => sum + r.size.w * r.size.h, 0);
  const widest = Math.max(...roomPlans.map((r) => r.size.w), 12);
  const wrapWidth = Math.max(widest + 2, Math.ceil(Math.sqrt(totalArea * 2.6)));

  const zones: OfficeZone[] = [];
  let cursorX = 1;
  let rowTop = ROOM_TOP;
  let rowHeight = 0;

  for (const plan of roomPlans) {
    const { unitId, unit, members, size } = plan;
    if (cursorX + size.w > wrapWidth && cursorX > 1) {
      rowTop += rowHeight + ROW_GAP;
      cursorX = 1;
      rowHeight = 0;
    }

    const desks: OfficeDesk[] = [];
    for (let i = 0; i < size.deskCount; i++) {
      const row = Math.floor(i / size.perRow);
      const col = i % size.perRow;
      desks.push({
        id: `d_${unitId.slice(-6)}_${i}`,
        cell: {
          x: cursorX + 2 + col * DESK_STEP,
          y: rowTop + LABEL_BAND + row * DESK_STEP,
        },
        agentId: members[i]?.id ?? null, // home desks persist in layout (23 §2)
      });
    }

    zones.push({
      id: `z_${unitId.slice(-6)}`,
      kind: unit?.kind === "executive" ? "executive" : "team",
      ...(unit && { orgUnitId: unit.id }),
      rect: { x: cursorX, y: rowTop, w: size.w, h: size.h },
      label: plan.label,
      color: plan.accent,
      desks,
    });
    cursorX += size.w + ROOM_GAP;
    rowHeight = Math.max(rowHeight, size.h);
  }

  // Toplantı odası son satırın artığına sığıyorsa oraya girer (alt boşluğu
  // küçültür); sığmıyorsa kendi satırına iner.
  const meetingRect =
    cursorX + 12 <= wrapWidth
      ? { x: cursorX, y: rowTop, w: 12, h: 8 }
      : { x: 1, y: rowTop + rowHeight + ROW_GAP + 1, w: 12, h: 8 };
  zones.push({
    id: "z_meet_central",
    kind: "meeting",
    rect: meetingRect,
    label: "Toplantı",
    spots: 6,
  });

  // Izgara plana göre büyür: sabit 80×50 dar org'da boş, geniş org'da yetersizdi.
  const maxX = Math.max(...zones.map((z) => z.rect.x + z.rect.w));
  const maxY = Math.max(...zones.map((z) => z.rect.y + z.rect.h));
  return {
    version: 1,
    grid: { cellSize: CELL_SIZE, cols: maxX + 4, rows: maxY + 4 },
    zones,
    walls: [],
  };
}

/**
 * İlk boş masa — önce ajanın KENDİ takım salonunda, sonra aynı departmanın
 * diğer salonlarında, sonra herhangi bir yerde (23 §2).
 *
 * Üç kademe gerekiyor çünkü salon artık takım: yalnız departmana bakan eski
 * sıralama, ajanı kendi takımının salonu yerine kardeş takımın salonuna
 * oturtabiliyordu.
 */
export function assignHomeDesk(
  layout: OfficeLayout,
  agentId: string,
  agentUnitId: string | null,
  unitsById: Map<string, OrgUnitInput>,
): OfficeDesk | null {
  const department = agentUnitId ? departmentOf(agentUnitId, unitsById) : null;
  const rank = (zone: { orgUnitId?: string | undefined }): number => {
    if (agentUnitId && zone.orgUnitId === agentUnitId) return 0;
    if (department && zone.orgUnitId) {
      const zoneDepartment = departmentOf(zone.orgUnitId, unitsById);
      if (zoneDepartment?.id === department.id) return 1;
    }
    return 2;
  };
  const zoneOrder = [...layout.zones].sort(
    (a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id),
  );
  for (const zone of zoneOrder) {
    for (const desk of zone.desks ?? []) {
      if (desk.agentId === agentId) return desk; // already assigned
      if (desk.agentId == null) {
        desk.agentId = agentId;
        return desk;
      }
    }
  }
  return null;
}

export function freeDesk(layout: OfficeLayout, agentId: string): void {
  for (const zone of layout.zones) {
    for (const desk of zone.desks ?? []) {
      if (desk.agentId === agentId) desk.agentId = null;
    }
  }
}

export function deskOf(layout: OfficeLayout, agentId: string): OfficeDesk | null {
  for (const zone of layout.zones) {
    for (const desk of zone.desks ?? []) {
      if (desk.agentId === agentId) return desk;
    }
  }
  return null;
}

/** Straight L-shaped grid path (x first, then y) — deterministic, ≤200 cells. */
export function gridPath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const path: Array<{ x: number; y: number }> = [];
  const stepX = to.x > from.x ? 1 : -1;
  for (let x = from.x; x !== to.x; x += stepX) path.push({ x: x + stepX, y: from.y });
  const stepY = to.y > from.y ? 1 : -1;
  for (let y = from.y; y !== to.y; y += stepY) path.push({ x: to.x, y: y + stepY });
  if (path.length === 0) path.push({ ...to });
  return path.slice(0, 200);
}
