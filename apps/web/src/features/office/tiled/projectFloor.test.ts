// FAZ 2B / 2B-4 — proje katı + tema: saf davranış testleri.
import { describe, expect, it } from "vitest";
import { FloorProjector } from "./project.js";
import { officeMap } from "./tiledMap.js";
import { DEFAULT_THEME, OFFICE_THEMES, themeForProject } from "./theme.js";

const uuid = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const snapshot = (count: number) => ({
  layoutVersion: 1,
  snapshotEpoch: 1,
  agents: Array.from({ length: count }, (_, i) => ({
    agentId: uuid(i),
    name: `Ajan ${i}`,
    cell: { x: 2 + i, y: 2 },
    badge: "IDLE" as const,
    deskId: null,
    sessionId: null,
  })),
  interactions: [],
});

describe("proje katı", () => {
  it("filtre yokken herkes katta", () => {
    const p = new FloorProjector(officeMap());
    p.projectSnapshot(snapshot(6));
    expect(p.filtered).toBe(false);
    for (let i = 0; i < 6; i += 1) expect(p.onFloor(uuid(i))).toBe(true);
  });

  it("proje filtresi: yalnız o ekip oturur, kalanı katta HİÇ yok", () => {
    const p = new FloorProjector(officeMap());
    p.projectSnapshot(snapshot(6));
    p.setFloorFilter(new Set([uuid(1), uuid(3)]));
    expect(p.filtered).toBe(true);
    expect(p.floor.seats.size).toBe(2);
    expect(p.onFloor(uuid(1))).toBe(true);
    expect(p.onFloor(uuid(0))).toBe(false);
    expect(p.seatCell(uuid(0))).toBeNull();
  });

  it("katta olmayan ajanın hareket talimatı DÜŞÜRÜLÜR (uydurma yürüyüş yok)", () => {
    const p = new FloorProjector(officeMap());
    p.projectSnapshot(snapshot(4));
    p.setFloorFilter(new Set([uuid(0)]));
    const moved = {
      type: "office.avatar.moved" as const,
      agentId: uuid(2),
      fromCell: { x: 3, y: 3 },
      toCell: { x: 8, y: 4 },
      path: [{ x: 8, y: 4 }],
      reason: "dm" as const,
      choreoSeq: 1,
      causeEventId: "eeeeeeee-eeee-4eee-8eee-eeeeeeee0001",
      causeSeq: 1,
      emittedAt: new Date(0).toISOString(),
    };
    expect(p.project(moved)).toBeNull();
    expect(p.project({ ...moved, agentId: uuid(0) })).not.toBeNull();
  });

  it("filtre kaldırılınca kat eski hâline döner", () => {
    const p = new FloorProjector(officeMap());
    p.projectSnapshot(snapshot(5));
    p.setFloorFilter(new Set([uuid(1)]));
    expect(p.floor.seats.size).toBe(1);
    p.setFloorFilter(null);
    expect(p.floor.seats.size).toBe(5);
  });

  it("aynı filtre yeniden verilince yeniden oturtma YOK (gereksiz boyama olmasın)", () => {
    const p = new FloorProjector(officeMap());
    p.projectSnapshot(snapshot(3));
    expect(p.setFloorFilter(new Set([uuid(0)]))).toBe(true);
    expect(p.setFloorFilter(new Set([uuid(0)]))).toBe(false);
  });

  it("kat filtreliyken de BÜYÜR: 20 kişilik proje ekibi tamamen oturur", () => {
    const p = new FloorProjector(officeMap());
    p.projectSnapshot(snapshot(30));
    p.setFloorFilter(new Set(Array.from({ length: 20 }, (_, i) => uuid(i))));
    expect(p.floor.seats.size).toBe(20);
    expect(p.floor.usedHeight).toBeGreaterThan(officeMap().height);
  });
});

describe("proje teması", () => {
  it("proje yoksa varsayılan kat", () => {
    expect(themeForProject(null).id).toBe(DEFAULT_THEME.id);
  });

  it("aynı proje HER ZAMAN aynı temayı alır (kimlik kalıcılığı)", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    expect(themeForProject(id).id).toBe(themeForProject(id).id);
  });

  it("farklı projeler tema havuzuna dağılır", () => {
    const ids = Array.from({ length: 24 }, (_, i) => `proje-${i}`);
    const used = new Set(ids.map((id) => themeForProject(id).id));
    expect(used.size).toBeGreaterThan(1);
    expect(used.size).toBeLessThanOrEqual(OFFICE_THEMES.length);
  });

  it("her tema AYNI kompozisyonu kullanır (düzen değişmez)", () => {
    for (const theme of OFFICE_THEMES) expect(theme.mapId).toBe("office");
  });
});
