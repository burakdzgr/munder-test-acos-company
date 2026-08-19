import { describe, expect, it } from "vitest";
import { parseImport, parsePositions, parseTeams, parseUnits, slugify } from "./orgImport.js";

describe("slugify", () => {
  it("Türkçe karakterleri çevirir ve API desenine uydurur", () => {
    expect(slugify("İçerik Ekibi")).toBe("icerik-ekibi");
    expect(slugify("Görsel & Tasarım")).toBe("gorsel-tasarim");
    expect(slugify("Backend")).toBe("backend");
  });
});

describe("parseUnits", () => {
  it("satır formatını ayrıştırır: Türkçe tür adları + ebeveyn referansı", () => {
    const { units, problems } = parseUnits(
      "ad,tür,üst\nEngineering, departman\nBackend, takım, Engineering\nİstanbul Ofisi, ofis\n",
    );
    expect(problems).toEqual([]);
    expect(units).toEqual([
      { name: "Engineering", slug: "engineering", kind: "department", parent: null },
      { name: "Backend", slug: "backend", kind: "team", parent: "Engineering" },
      { name: "İstanbul Ofisi", slug: "istanbul-ofisi", kind: "office", parent: null },
    ]);
  });

  it("geçersiz türü işaretler, JSON dizisini kabul eder", () => {
    expect(parseUnits("X, süper-birim").problems[0]).toContain("süper-birim");
    const { units, problems } = parseUnits('[{"name":"Growth","kind":"team","parent":"Marketing"}]');
    expect(problems).toEqual([]);
    expect(units[0]).toMatchObject({ slug: "growth", kind: "team", parent: "Marketing" });
  });
});

describe("parseTeams", () => {
  it("satır başına ad + opsiyonel üst birim ayrıştırır, başlık satırını atlar", () => {
    const { teams, problems } = parseTeams("ad,üst\nBackend, Engineering\nİçerik Ekibi\n");
    expect(problems).toEqual([]);
    expect(teams).toEqual([
      { name: "Backend", parent: "Engineering" },
      { name: "İçerik Ekibi", parent: null },
    ]);
  });

  it("boş içerik problem döner", () => {
    expect(parseTeams("").problems).toHaveLength(1);
  });
});

describe("parsePositions", () => {
  it("JSON dizisini ayrıştırır ve geçersiz rolü işaretler", () => {
    const { positions, problems } = parsePositions(
      '[{"title":"Backend Engineer","defaultRole":"member"},{"title":"X","defaultRole":"boss"}]',
    );
    expect(positions).toEqual([{ title: "Backend Engineer", defaultRole: "member" }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("boss");
  });

  it('{"positions": …} sarmalını da kabul eder', () => {
    const { positions, problems } = parsePositions('{"positions":[{"title":"QA/Reviewer","defaultRole":"reviewer"}]}');
    expect(problems).toEqual([]);
    expect(positions[0]).toEqual({ title: "QA/Reviewer", defaultRole: "reviewer" });
  });

  it("satır formatını ayrıştırır: rol boşsa member, başlık satırı atlanır", () => {
    const { positions, problems } = parsePositions("title,defaultRole\nDevOps Lead, lead\nData Engineer\n");
    expect(problems).toEqual([]);
    expect(positions).toEqual([
      { title: "DevOps Lead", defaultRole: "lead" },
      { title: "Data Engineer", defaultRole: "member" },
    ]);
  });

  it("boş içerik ve bozuk JSON'a problem döner", () => {
    expect(parsePositions("").problems).toHaveLength(1);
    expect(parsePositions("[oops").problems[0]).toContain("JSON");
  });
});

describe("parseImport", () => {
  it("tam şemayı ayrıştırır (birim slug'ı addan türetilir)", () => {
    const { plan, problems } = parseImport(
      JSON.stringify({
        units: [{ name: "Yeni Birim", kind: "team", parent: "engineering" }],
        positions: [{ title: "CEO", defaultRole: "executive" }],
        agents: [{ name: "A", position: "CEO", unit: "yeni-birim", seniority: "expert" }],
      }),
    );
    expect(problems).toEqual([]);
    expect(plan.units[0]).toMatchObject({ slug: "yeni-birim", kind: "team", parent: "engineering" });
    expect(plan.agents[0]).toMatchObject({ manager: null, activate: true, autonomyLevel: 2 });
  });

  it("CSV ajan satırlarını ayrıştırır (tırnaklı persona + noktalı virgüllü expertise)", () => {
    const csv =
      'name,position,unit,manager,seniority,autonomyLevel,persona,expertise\n' +
      '"Kerem Yıldız",Backend Engineer,backend,"Aylin Vural",senior,3,"Sakin, titiz",ts;pg\n';
    const { plan, problems } = parseImport(csv);
    expect(problems).toEqual([]);
    expect(plan.agents[0]).toMatchObject({
      name: "Kerem Yıldız",
      manager: "Aylin Vural",
      autonomyLevel: 3,
      persona: "Sakin, titiz",
      expertise: ["ts", "pg"],
    });
  });

  it("geçersiz seniority ajanı düşürür ve problem raporlar", () => {
    const { plan, problems } = parseImport(
      JSON.stringify({ agents: [{ name: "B", position: "CEO", unit: "x", seniority: "guru" }] }),
    );
    expect(plan.agents).toHaveLength(0);
    expect(problems[0]).toContain("guru");
  });
});
