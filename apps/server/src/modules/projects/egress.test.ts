// D4 — üretilen squid include'unun güvenliği (27 §12, S8).
//
// Bu dosyadaki metin doğrudan proxy konfigürasyonuna giriyor. Asıl tehlike
// eksik bir alan adı değil, KONFİGÜRASYON ENJEKSİYONU: içinde satır sonu olan
// bir "alan adı" allowlist'i tamamen açan yeni direktifler yazabilirdi.
// Proje ayarlarını Founder giriyor ama ajanlar da proje kaydını
// düzenleyebiliyor — yani girdi güvenilmez sayılmalı.
import { describe, expect, it } from "vitest";
import { parseEgressDomains, renderEgressInclude } from "./egress.js";

describe("egress allowlist üretimi (27 §12)", () => {
  it("geçerli alan adlarını kabul eder, biçimlerini korur", () => {
    expect(
      parseEgressDomains({
        egressDomains: ["api.stripe.com", ".githubusercontent.com", "DOCS.Example.CO.UK"],
      }),
    ).toEqual(["api.stripe.com", ".githubusercontent.com", "docs.example.co.uk"]);
  });

  it("konfigürasyon enjeksiyonunu keser", () => {
    const hostile = parseEgressDomains({
      egressDomains: [
        "evil.com\nhttp_access allow all", // yeni direktif
        "evil.com http_access allow all", // boşlukla ikinci token
        "evil.com\r\nacl x src 0.0.0.0/0",
        "*.evil.com", // squid joker'i — dstdomain'de nokta biçimi kullanılır
        "http://evil.com", // şema
        "evil.com:3128", // port
        "192.168.1.1", // IP
        "../../etc/passwd",
        "",
        "   ",
      ],
    });
    expect(hostile).toEqual([]);
  });

  it("üretilen dosyada yalnız ACL satırları ve yorumlar bulunur", () => {
    const rendered = renderEgressInclude([
      { slug: "webshop", domains: ["api.stripe.com"] },
      { slug: "in<>ternal", domains: ["metrics.internal.example.com"] },
    ]);
    for (const line of rendered.split("\n").filter(Boolean)) {
      expect(line.startsWith("#") || line.startsWith("acl allowed_dst dstdomain ")).toBe(true);
    }
    // proje slug'ı yorumda ve temizlenmiş
    expect(rendered).toContain("# internal");
    expect(rendered).not.toContain("in<>ternal");
    expect(rendered).toContain("acl allowed_dst dstdomain api.stripe.com");
  });

  it("aynı alan adını iki proje isterse bir kez yazar", () => {
    const rendered = renderEgressInclude([
      { slug: "a", domains: ["api.stripe.com", "docs.example.com"] },
      { slug: "b", domains: ["api.stripe.com"] },
    ]);
    const occurrences = rendered.split("api.stripe.com").length - 1;
    expect(occurrences).toBe(1);
  });

  it("hiç alan adı yoksa geçerli ama boş bir include üretir", () => {
    const rendered = renderEgressInclude([]);
    expect(rendered).toContain("hiçbir proje ek alan adı tanımlamadı");
    expect(rendered).not.toContain("acl allowed_dst");
    expect(rendered.endsWith("\n")).toBe(true);
  });

  it("ayar yoksa/bozuksa boş liste döner", () => {
    expect(parseEgressDomains(null)).toEqual([]);
    expect(parseEgressDomains({})).toEqual([]);
    expect(parseEgressDomains({ egressDomains: "api.stripe.com" })).toEqual([]);
    expect(parseEgressDomains({ egressDomains: [42, null] })).toEqual([]);
  });
});
