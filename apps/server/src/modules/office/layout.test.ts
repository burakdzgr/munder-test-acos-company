// Oto-yerleşim (23 §2, revize): oda birimi TAKIM. Bu testlerin varlık sebebi
// somut: ilk sürümde oda birimi departmandı ve ekranda tek bir dev
// "ENGINEERING" salonu görünüyordu — Backend/Frontend/DevOps ayrımı hiç
// okunmuyordu. Burada kanıtlanan şey görüntü değil YAPI: her takım kendi
// salonunu alıyor mu, ajan kendi takımının masasına mı oturuyor, plan
// deterministik mi.
import { describe, expect, it } from "vitest";
import { assignHomeDesk, computeAutoLayout, deskOf, type AgentInput, type OrgUnitInput } from "./layout.js";

const units: OrgUnitInput[] = [
  { id: "00000000-0000-0000-0000-0000000000e1", name: "Engineering", kind: "department", parentId: null },
  {
    id: "00000000-0000-0000-0000-0000000000b1",
    name: "Backend",
    kind: "team",
    parentId: "00000000-0000-0000-0000-0000000000e1",
  },
  {
    id: "00000000-0000-0000-0000-0000000000f1",
    name: "Frontend",
    kind: "team",
    parentId: "00000000-0000-0000-0000-0000000000e1",
  },
];

const agent = (id: string, orgUnitId: string): AgentInput => ({
  id,
  name: `Agent ${id.slice(-2)}`,
  status: "active",
  orgUnitId,
});

const agents: AgentInput[] = [
  agent("00000000-0000-0000-0000-00000000a001", "00000000-0000-0000-0000-0000000000b1"),
  agent("00000000-0000-0000-0000-00000000a002", "00000000-0000-0000-0000-0000000000b1"),
  agent("00000000-0000-0000-0000-00000000a003", "00000000-0000-0000-0000-0000000000f1"),
  // takıma değil, doğrudan departmana bağlı üye
  agent("00000000-0000-0000-0000-00000000a004", "00000000-0000-0000-0000-0000000000e1"),
];

describe("computeAutoLayout", () => {
  it("her takıma ayrı salon açar, departmana bağlı üyeleri Genel salonuna koyar", () => {
    const layout = computeAutoLayout(units, agents);
    const labels = layout.zones.filter((z) => z.kind === "team").map((z) => z.label);
    expect(labels).toContain("Backend");
    expect(labels).toContain("Frontend");
    expect(labels).toContain("Engineering Genel");
    // departmanın kendisi ayrıca bir salon olarak çizilmez
    expect(layout.zones.some((z) => z.kind === "department")).toBe(false);
  });

  it("aynı departmanın salonları aynı vurgu rengini paylaşır", () => {
    const layout = computeAutoLayout(units, agents);
    const accents = new Set(
      layout.zones.filter((z) => z.kind === "team").map((z) => z.color),
    );
    expect(accents.size).toBe(1); // tek departman → tek renk
  });

  it("salonlar çakışmaz", () => {
    const layout = computeAutoLayout(units, agents);
    const rects = layout.zones.map((z) => z.rect);
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!;
        const b = rects[j]!;
        const overlap =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
    }
  });

  it("deterministik: aynı org verisi aynı planı üretir", () => {
    expect(computeAutoLayout(units, agents)).toEqual(computeAutoLayout(units, agents));
  });

  it("ajansız şirkette çökmez (yeni şirket kaydı yolu)", () => {
    const layout = computeAutoLayout([], []);
    expect(layout.zones).toHaveLength(1); // yalnız toplantı alanı
    expect(layout.grid.cols).toBeGreaterThan(0);
  });
});

describe("assignHomeDesk", () => {
  it("ajanı KENDİ takımının salonuna oturtur", () => {
    const layout = computeAutoLayout(units, agents);
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const backendZone = layout.zones.find((z) => z.label === "Backend")!;

    const desk = assignHomeDesk(
      layout,
      "00000000-0000-0000-0000-00000000a001",
      "00000000-0000-0000-0000-0000000000b1",
      unitsById,
    );
    expect(desk).not.toBeNull();
    expect(backendZone.desks!.some((d) => d.id === desk!.id)).toBe(true);
  });

  it("kendi salonu doluysa kardeş takıma, oraya da sığmazsa herhangi bir yere", () => {
    // Frontend salonunun bütün masalarını doldur
    const layout = computeAutoLayout(units, agents);
    const unitsById = new Map(units.map((u) => [u.id, u]));
    const frontend = layout.zones.find((z) => z.label === "Frontend")!;
    frontend.desks!.forEach((d, i) => (d.agentId = `filled-${i}`));

    const desk = assignHomeDesk(
      layout,
      "00000000-0000-0000-0000-00000000a009",
      "00000000-0000-0000-0000-0000000000f1",
      unitsById,
    );
    expect(desk).not.toBeNull();
    expect(frontend.desks!.some((d) => d.id === desk!.id)).toBe(false);
    expect(deskOf(layout, "00000000-0000-0000-0000-00000000a009")).toEqual(desk);
  });
});
