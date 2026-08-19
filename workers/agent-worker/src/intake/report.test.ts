// B4 (14 §3.1 stage 3, 14 §3.2) — intake raporunun yorumlayıcı katmanı.
//
// Analizörler "bu depoda NE var" sorusunu yanıtlıyor; 14 §3.2'nin beş bölümü
// "bu NE ANLAMA geliyor" diye soruyor ve bunlar sabit `_analysis unavailable_`
// olarak gönderiliyordu. Founder bir proje içeri aldığında on beş başlık
// altında JSON dökümü alıyor, okumasını almıyordu.
//
// İki şey test ediliyor: (1) model okuması geldiğinde raporda gerçekten yerini
// alıyor, (2) gelmediğinde bugünkü deterministik çıktı aynen korunuyor —
// çünkü ulaşılamayan bir model intake'i BLOKLAMAMALI (P6).
import { describe, expect, it } from "vitest";
import { INTAKE_REPORT_SECTIONS, buildIntakeReport, type ReportInput } from "./report.js";

const BASE: ReportInput = {
  projectName: "Webshop",
  objective: "Sepet terk oranını düşür",
  constraints: "3 ay",
  sourceRef: "https://example.com/webshop.git",
  ingest: {
    defaultBranch: "main",
    headCommit: "abcdef0123456789",
    branches: ["main"],
    sizeKb: 2048,
  },
  analyzers: [
    { analyzer: "languages", title: "Languages", ok: true, findings: { fileCountsByExtension: { ".ts": 42 } }, error: null },
    { analyzer: "tests", title: "Tests", ok: false, findings: null, error: "timeout" },
  ],
};

/** Bir bölümün gövdesini başlığına göre çeker. */
function sectionBody(markdown: string, heading: string): string {
  const index = INTAKE_REPORT_SECTIONS.indexOf(heading as (typeof INTAKE_REPORT_SECTIONS)[number]);
  const start = markdown.indexOf(`## ${index + 1}. ${heading}`);
  expect(start, `bölüm bulunamadı: ${heading}`).toBeGreaterThan(-1);
  const next = markdown.indexOf(`\n## `, start + 1);
  return markdown.slice(start, next === -1 ? undefined : next);
}

describe("intake raporu — yorumlayıcı geçiş (14 §3.1 stage 3)", () => {
  it("model okuması yoksa bugünkü deterministik rapor aynen üretilir (P6)", () => {
    const markdown = buildIntakeReport(BASE);
    // 16 kanonik başlık, sırasıyla — tüketiciler bunlara bağlı
    INTAKE_REPORT_SECTIONS.forEach((heading, i) => {
      expect(markdown).toContain(`## ${i + 1}. ${heading}`);
    });
    expect(sectionBody(markdown, "Data layer")).toContain("_analysis unavailable_");
    expect(sectionBody(markdown, "Executive summary")).toContain("Sepet terk oranını düşür");
    // analizör çıktısı hâlâ raporda
    expect(sectionBody(markdown, "Technology stack")).toContain(".ts");
    // degrade analizör kendi bölümünü düşürüyor, raporu değil
    expect(sectionBody(markdown, "Test & CI status")).toContain("timeout");
  });

  it("model okuması geldiğinde boş bölümlerin yerini alır", () => {
    const markdown = buildIntakeReport({
      ...BASE,
      synthesis: {
        executiveSummary: "Depo tek parça bir Next.js uygulaması; ödeme akışı en riskli yer.",
        dataLayer: "Postgres + Prisma; sipariş tablosu normalize değil.",
        apiSurface: "12 REST ucu, sürümleme yok.",
        technicalDebt: "1) ödeme testleri yok 2) bağımlılıklar 2 yıl eski",
        qualityMetrics: "Test kapsamı yok denecek kadar az.",
        productSignals: "Sepet terk analitiği zaten toplanıyor.",
        recommendedPlan: "1. Ödeme akışına test yaz\n2. Sepet olaylarını ölç",
        openQuestions: "- Ödeme sağlayıcısı değişecek mi?",
      },
    });
    expect(sectionBody(markdown, "Data layer")).toContain("Prisma");
    expect(sectionBody(markdown, "Data layer")).not.toContain("_analysis unavailable_");
    expect(sectionBody(markdown, "API surface")).toContain("12 REST ucu");
    expect(sectionBody(markdown, "Technical debt register")).toContain("ödeme testleri yok");
    expect(sectionBody(markdown, "Quality metrics")).toContain("Test kapsamı");
    expect(sectionBody(markdown, "Product/market signals")).toContain("Sepet terk analitiği");
    expect(sectionBody(markdown, "Recommended plan")).toContain("Ödeme akışına test yaz");
    expect(sectionBody(markdown, "Open questions for the organization")).toContain(
      "Ödeme sağlayıcısı",
    );
    // yönetici özeti modelin okumasını ÖNE alıyor ama sayıları da koruyor
    const summary = sectionBody(markdown, "Executive summary");
    expect(summary).toContain("ödeme akışı en riskli yer");
    expect(summary).toContain("Sepet terk oranını düşür");
  });

  it("boş/whitespace bir sentez alanı deterministik metne düşer", () => {
    const markdown = buildIntakeReport({
      ...BASE,
      synthesis: { dataLayer: "   ", apiSurface: "gerçek okuma" },
    });
    expect(sectionBody(markdown, "Data layer")).toContain("_analysis unavailable_");
    expect(sectionBody(markdown, "API surface")).toContain("gerçek okuma");
  });

  // Kabul kriteri: "repo'suz bir proje fikri anlamlı bir intake raporu üretiyor"
  it("repo'suz proje fikri de rapor alır — depo bölümleri dürüstçe konuşur", () => {
    const markdown = buildIntakeReport({
      ...BASE,
      sourceRef: null,
      greenfield: true,
      analyzers: [],
      synthesis: {
        executiveSummary: "Sıfırdan bir sepet kurtarma servisi.",
        recommendedPlan: "1. En küçük sürümü tanımla\n2. Olay şemasını çıkar",
      },
    });
    // depo bölümleri "analiz yok" demiyor, "henüz depo yok" diyor
    const profile = sectionBody(markdown, "Repository profile");
    expect(profile).toContain("no repository yet");
    expect(profile).not.toContain("_analysis unavailable_");
    // …ama yorumlayıcı bölümler gerçek içerik taşıyor
    expect(sectionBody(markdown, "Executive summary")).toContain("sepet kurtarma servisi");
    expect(sectionBody(markdown, "Recommended plan")).toContain("En küçük sürümü tanımla");
    // ve modelsiz greenfield'da bile sorular anlamlı: depo sorusu sorulmuyor
    const bare = buildIntakeReport({ ...BASE, sourceRef: null, greenfield: true, analyzers: [] });
    const questions = sectionBody(bare, "Open questions for the organization");
    expect(questions).toContain("smallest first release");
    expect(questions).not.toContain("codebase does the objective touch");
  });
});
