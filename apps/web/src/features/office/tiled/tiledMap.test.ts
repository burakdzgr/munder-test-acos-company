// FAZ 2B / 2B-2 — harita, koltuk dağıtımı ve rota: saf fonksiyon testleri.
import { describe, expect, it } from "vitest";
import { officeMap, isWalkable, routeOnFloor, zoneAnchor } from "./tiledMap.js";
import { seatAgents } from "./seatPool.js";
import { tileArt } from "./tileset.js";

describe("office map (Tiled)", () => {
  const map = officeMap();

  it("Munder düzenindeki isimli koltukları ve bölgeleri taşır", () => {
    expect(map.seats.has("desk-ceo")).toBe(true);
    expect(map.seats.has("desk-team-lead")).toBe(true);
    expect([...map.seats.keys()].filter((s) => s.startsWith("pc-")).length).toBeGreaterThanOrEqual(6);
    expect(map.zones.has("boardroom")).toBe(true);
    expect(map.zones.has("cafeteria")).toBe(true);
  });

  it("her koltuk YÜRÜNEBİLİR bir hücrede", () => {
    for (const [, cell] of map.seats) expect(isWalkable(map, cell.x, cell.y)).toBe(true);
  });

  it("dış duvar kapalı, iç alan açık", () => {
    expect(isWalkable(map, 0, 0)).toBe(false);
    expect(isWalkable(map, map.width - 1, 5)).toBe(false);
    expect(isWalkable(map, 11, 10)).toBe(true); // koridor
  });

  it("haritadaki HER gid'in sanat karşılığı var", () => {
    const art = tileArt();
    for (const key of new Set(map.draw.map((d) => d.key))) expect(art[key]).toBeTruthy();
  });

  it("her koltuktan CEO koltuğuna yürünebilir bir rota var", () => {
    const ceo = map.seats.get("desk-ceo");
    expect(ceo).toBeTruthy();
    for (const [name, cell] of map.seats) {
      if (name === "desk-ceo") continue;
      const path = routeOnFloor(map, cell, ceo!);
      expect(path.length).toBeGreaterThan(0);
      for (const step of path) expect(isWalkable(map, step.x, step.y)).toBe(true);
    }
  });

  it("bölge çapası yürünebilir hücreye düşer", () => {
    for (const zone of ["boardroom", "cafeteria"]) {
      const anchor = zoneAnchor(map, zone);
      expect(anchor).toBeTruthy();
      expect(isWalkable(map, anchor!.x, anchor!.y)).toBe(true);
    }
  });
});

describe("koltuk dağıtımı", () => {
  const map = officeMap();
  const agent = (id: string, title?: string, executive = false) => ({
    agentId: id,
    title: title ?? null,
    executive,
  });

  it("tepe yönetici CEO koltuğuna oturur", () => {
    const floor = seatAgents(map, [agent("a1", "Kıdemli Mühendis"), agent("a2", "CEO", true)]);
    expect(floor.seats.get("a2")?.seat).toBe("desk-ceo");
    expect(floor.seats.get("a1")?.seat).not.toBe("desk-ceo");
  });

  it("unvan ipucu doğru masayı seçer", () => {
    const floor = seatAgents(map, [
      agent("b1", "Backend Engineer"),
      agent("b2", "Ürün Yöneticisi"),
      agent("b3", "Veri Mühendisi"),
    ]);
    expect(floor.seats.get("b1")?.seat).toBe("desk-backend-engineer");
    expect(floor.seats.get("b2")?.seat).toBe("desk-product-manager");
    expect(floor.seats.get("b3")?.seat).toBe("desk-data-engineer");
  });

  it("KOLTUK TAVANI YOK — kat büyür, herkes oturur", () => {
    const many = Array.from({ length: 40 }, (_, i) => agent(`x${i}`));
    const floor = seatAgents(map, many);
    expect(floor.seats.size).toBe(40); // kimse yersiz kalmadı
    expect(floor.extraDesks.length).toBe(40 - map.seatOrder.length);
    expect(floor.usedHeight).toBeGreaterThan(map.height);
    const cells = new Set([...floor.seats.values()].map((s) => `${s.cell.x},${s.cell.y}`));
    expect(cells.size).toBe(40); // hiçbir iki ajan aynı hücrede değil
  });

  it("aynı kadro aynı yerleşimi verir (kararlı)", () => {
    const roster = [agent("s1", "CEO", true), agent("s2", "Frontend"), agent("s3")];
    const first = seatAgents(map, roster);
    const second = seatAgents(map, roster);
    for (const [id, seat] of first.seats) expect(second.seats.get(id)?.seat).toBe(seat.seat);
  });
});
