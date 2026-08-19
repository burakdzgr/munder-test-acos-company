// D4 — proje-bazlı egress allowlist'i (27 §12, S8, INV-8).
//
// squid.conf'un kendi yorumu bunu baştan öngörüyordu: "per-workspace
// additions come from project settings via a generated include". Üretici
// yazılmamıştı, dolayısıyla ajanlar yalnız gömülü paket registry'lerine
// çıkabiliyordu — bir projenin kendi API'sine (Stripe, bir iç servis, bir
// dokümantasyon host'u) erişmesi imkânsızdı.
//
// Güvenlik notu (bu dosyanın asıl işi): buradaki metin doğrudan squid
// konfigürasyonuna giriyor. Doğrulanmamış bir alan adı — içinde satır sonu
// olan bir dize — allowlist'i genişleten YENİ DİREKTİFLER enjekte edebilirdi
// (`evil.com\nhttp_access allow all`). Bu yüzden her alan adı katı bir
// desenden geçiyor ve geçmeyen sessizce atılıyor: fail-closed.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { projects } from "@acos/db/schema";
import type { Db } from "@acos/db";

/**
 * Bir host etiketi: harf/rakam/tire, nokta ile ayrılmış, en az bir nokta.
 * Baştaki tek nokta squid'in "bu alan ve alt alanları" biçimi (`.npmjs.org`).
 * IP, port, şema, yol, boşluk, satır sonu: hiçbiri kabul edilmiyor.
 */
const DOMAIN_PATTERN = /^\.?(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Bir projenin ayarlarından geçerli alan adlarını süzer. */
export function parseEgressDomains(settings: unknown): string[] {
  const raw = (settings as { egressDomains?: unknown } | null)?.egressDomains;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const domain = value.trim().toLowerCase();
    if (DOMAIN_PATTERN.test(domain)) out.push(domain);
  }
  return out;
}

/**
 * squid include'unun gövdesi. Alan adı yoksa da bir dosya üretiyoruz: include
 * yolunun her zaman var olması, squid'in eksik dosyada başlamamasından iyidir.
 *
 * [WRITER-DECISION] Kapsam şirket geneli, workspace başına değil: squid
 * kaynağı IP ile eşleştiriyor ve workspace konteynerlerinin IP'leri dinamik.
 * Yani "A projesi için açılan alan, B projesinin workspace'inden de
 * erişilebilir". Aynı kurulumdaki tüm workspace'ler zaten aynı şirkete ait ve
 * hedef allowlist'i (varsayılan-red) korunuyor; workspace başına ACL bir
 * IP↔proje eşleme mekanizması ister, bu da ayrı bir karar.
 */
export function renderEgressInclude(
  entries: ReadonlyArray<{ slug: string; domains: string[] }>,
): string {
  const lines = [
    "# ACOS — projelerden üretilmiştir (27 §12). ELLE DÜZENLEMEYİN.",
    "# Kaynak: projects.settings.egressDomains",
    "",
  ];
  const seen = new Set<string>();
  for (const entry of entries) {
    const fresh = entry.domains.filter((d) => !seen.has(d));
    if (fresh.length === 0) continue;
    for (const d of fresh) seen.add(d);
    // proje slug'ı yalnız YORUM satırında ve o da temizlenmiş hâliyle
    lines.push(`# ${entry.slug.replace(/[^a-z0-9-]/gi, "")}`);
    lines.push(`acl allowed_dst dstdomain ${fresh.join(" ")}`);
  }
  if (seen.size === 0) lines.push("# (hiçbir proje ek alan adı tanımlamadı)");
  return `${lines.join("\n")}\n`;
}

/**
 * Include'u üret ve YALNIZ değiştiyse yaz. Proxy dosyanın md5'ini izleyip
 * yeniden yapılandırıyor; her turda dokunmak gereksiz reload demek olurdu.
 * Yazma atomik: geçici dosya + rename, çünkü proxy dosyayı her an okuyabilir
 * ve yarım yazılmış bir konfigürasyon parse hatası verir.
 */
export async function writeEgressInclude(db: Db, includePath: string): Promise<boolean> {
  const rendered = renderEgressInclude(await loadEgressEntries(db));
  const current = await readFile(includePath, "utf8").catch(() => null);
  if (current === rendered) return false;
  await mkdir(dirname(includePath), { recursive: true });
  const tmp = `${includePath}.tmp`;
  await writeFile(tmp, rendered, "utf8");
  await rename(tmp, includePath);
  return true;
}

/** Aktif projelerin egress ayarlarını okur. */
export async function loadEgressEntries(
  db: Db,
): Promise<Array<{ slug: string; domains: string[] }>> {
  const rows = await db
    .select({ slug: projects.slug, settings: projects.settings })
    .from(projects)
    .where(and(isNull(projects.archivedAt), eq(projects.status, "active")));
  return rows
    .map((r) => ({ slug: r.slug, domains: parseEgressDomains(r.settings) }))
    .filter((r) => r.domains.length > 0);
}
