// B4 — model çıktısının ayrıştırılması.
//
// Yorumlayıcı geçiş bir LLM'den JSON istiyor; modeller bunu markdown çitiyle,
// önünde açıklamayla ya da hiç göndermeden verebiliyor. Ayrıştırma başarısız
// olduğunda rapor deterministik metne düşmeli — intake ASLA bloklanmamalı
// (P6, analizörlerle aynı sözleşme).
import { describe, expect, it } from "vitest";
import { parseSynthesis } from "./activities.js";

describe("intake sentezi ayrıştırma (B4)", () => {
  it("düz JSON'u okur", () => {
    const parsed = parseSynthesis('{"dataLayer":"Postgres","apiSurface":"12 uç"}');
    expect(parsed).toEqual({ dataLayer: "Postgres", apiSurface: "12 uç" });
  });

  it("markdown çiti ve önündeki açıklamayı aşar", () => {
    const parsed = parseSynthesis(
      'İşte rapor:\n```json\n{"executiveSummary":"tek parça uygulama"}\n```\nUmarım yardımcı olur.',
    );
    expect(parsed?.executiveSummary).toBe("tek parça uygulama");
  });

  it("bilinmeyen alanları ve boş dizeleri atar", () => {
    const parsed = parseSynthesis(
      '{"dataLayer":"var","sahteAlan":"gitmeli","apiSurface":"","qualityMetrics":"   "}',
    );
    expect(parsed).toEqual({ dataLayer: "var" });
  });

  it("tek bir bölüm raporu ele geçiremesin diye uzunluğu sınırlar", () => {
    const parsed = parseSynthesis(JSON.stringify({ technicalDebt: "x".repeat(10_000) }));
    expect(parsed!.technicalDebt!.length).toBe(4000);
  });

  it("ayrıştırılamayan çıktı null döner — rapor deterministik metne düşer", () => {
    expect(parseSynthesis("model bugün JSON vermek istemedi")).toBeNull();
    expect(parseSynthesis("{bozuk json")).toBeNull();
    expect(parseSynthesis("")).toBeNull();
    // geçerli JSON ama tek bir kullanılabilir alan yok
    expect(parseSynthesis('{"baskaSey":1}')).toBeNull();
  });
});
