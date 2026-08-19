// Şirketin çıktı dili (_DECISIONS A5).
//
// A5 aynen şöyle diyor: "English is the canonical internal language of
// agents/docs; company-facing output language is a company setting." Yani
// dil SABİT KODLANAMAZ — `company_settings.output_language` alanı zaten
// vardı, API onu döndürüyordu, ama HİÇBİR prompt onu okumuyordu. Ayar ölüydü:
// değeri "tr" yapmak hiçbir şeyi değiştirmiyordu. Bu modül o boşluğu kapatır.
//
// Kural, dil kodundan yönergeye çeviren tek yerdir; dört çağrı noktası
// (ajan döngüsü, hafıza konsolidasyonu, proje intake sentezi, gelen kutusu
// triyajı) aynı metni kullanır. İki ayrı yerde iki farklı ifade, modelin
// yüzeyden yüzeye farklı davranması demekti.

/** Dil kodu → insan okunur ad. Bilinmeyen kod olduğu gibi yazılır. */
const LANGUAGE_NAMES: Record<string, string> = {
  tr: "Türkçe",
  en: "English",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
};

export function languageName(code: string): string {
  const key = code.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return LANGUAGE_NAMES[key] ?? code;
}

/**
 * Modele verilecek dil yönergesi.
 *
 * İki yarısı da şart. "Türkçe yaz" tek başına yetmiyor: model iyi niyetle
 * enum değerlerini ve JSON anahtarlarını da çevirmeye kalkışıyor
 * ("durum":"DEVAM_EDIYOR"), şema doğrulaması patlıyor ve adım ziyan
 * oluyor. Bu yüzden neyin çevrileceği kadar neyin ASLA çevrilmeyeceği de
 * açıkça sayılır.
 *
 * `en` için boş dize döner — İngilizce zaten prompt'un kendi dili, fazladan
 * bir talimat sadece token yakardı.
 */
export function outputLanguageDirective(code: string): string {
  const key = code.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (key === "en" || key === "") return "";
  const name = languageName(code);
  return [
    `# Output language (company setting: ${code})`,
    `Write EVERY human-readable text in ${name}. This includes: your reasoning/thoughts,`,
    `messages to teammates and to the Founder, task titles and objectives, success criteria,`,
    `decision records, escalation reasons and recommendations, completion summaries,`,
    `review comments and memory entries.`,
    `NEVER translate machine-readable values — they are data, not prose:`,
    `JSON keys, enum values (P0, IN_PROGRESS, initiative, high, ...), tool names,`,
    `file paths, shell commands, code, identifiers and UUIDs stay exactly as specified.`,
  ].join("\n");
}
