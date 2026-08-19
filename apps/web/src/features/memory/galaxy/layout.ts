// Galaksi yerleşimi (ADR-021) — SAF fonksiyonlar, hiçbir three bağımlılığı yok.
//
// Kural: bir düğümün yeri KİMLİĞİNDEN türetilir, rastgele değil. Her yenilemede
// aynı anı aynı yerde durur; yeni bir anı eklendiğinde diğerleri zıplamaz.
// (Kuvvet tabanlı yerleşim her hesapta farklı sonuç verirdi ve galaksi her
// yenilemede yeniden karılırdı.)
//
// Şekil: KÜRE, disk değil.
//
// İlk sürüm yassı sarmal bir diskti. Yatay bir gezegen gibi görünüyordu ve
// bilgi grafiği o değil: bir bilgi ağı her yöne bağlanır, tek bir düzleme
// oturmaz. Küresel yerleşim hem daha dürüst hem de kameranın hangi açıdan
// bakarsa baksın yapıyı göstermesini sağlıyor (diskte kenardan bakınca her
// şey üst üste biniyordu).
//
// Üç küresel kabuk — 12 §2'nin kapsam hiyerarşisinin görsel karşılığı:
//   company → merkez çekirdek (yoğun, parlak)
//   project → orta kabuk
//   agent   → dış kabuk
//
// Kabuk İÇİNDE konum kapsam sahibine göre KÜMELENİR: aynı projenin bütün
// anıları kürenin aynı bölgesinde toplanır, farklı projeler ayrı bölgelere
// düşer. Sarmal koldaki fikrin küresel karşılığı bu — "kimin anısı" sorusu
// yine bakınca cevaplanabiliyor.
export type MemoryScope = "company" | "project" | "agent";

export interface GalaxyNodeInput {
  id: string;
  title: string;
  type: string;
  scope: string;
  /** Kapsamın sahibi: proje id'si / ajan id'si / null (company). */
  scopeRef: string | null;
  /** Proje ya da ajan adı — tooltip ve kol göstergesi için. */
  scopeLabel: string | null;
  importance: number;
  confidence: number;
  status: string;
}

export interface GalaxyNode extends GalaxyNodeInput {
  /** Sahne koordinatı (deterministik). */
  position: [number, number, number];
  /** Dalga fazı — aynı anda hepsi birlikte inip çıkmasın diye kimlikten. */
  phase: number;
  /** 0.35–1.0: importance'tan türetilen yarıçap. */
  radius: number;
}

/** FNV-1a: kısa, hızlı, çakışması bu ölçekte önemsiz; sürüm boyu sabit. */
export function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Hash'ten [0,1) aralığında kararlı bir sayı (n = alan ayırıcı). */
function unit(hash: number, n: number): number {
  const mixed = Math.imul(hash ^ (n * 0x9e3779b9), 0x85ebca6b) >>> 0;
  return (mixed % 100000) / 100000;
}

const SHELL: Record<MemoryScope, { inner: number; outer: number }> = {
  // çekirdek: küçük küre, yoğun
  company: { inner: 0, outer: 4 },
  // orta kabuk
  project: { inner: 7, outer: 12.5 },
  // dış kabuk
  agent: { inner: 13.5, outer: 18 },
};

/** Alanın (dekoratif küre bulutunun) dış sınırı — düğümler hep içinde kalır. */
export const FIELD_RADIUS = 19;

/**
 * Bir kümenin açısal yarıçapı (radyan).
 *
 * Küçük tutuluyor: kümeler dağılırsa küre düzgün bir top olur ve "hangi
 * anı kimin" bilgisi görsel olarak kaybolur. Fazla küçük olursa da anılar
 * üst üste biner — 0.42 ikisi arasında ölçüldü.
 */
const CLUSTER_SPREAD = 0.42;

export function scopeOf(raw: string): MemoryScope {
  return raw === "company" || raw === "project" || raw === "agent" ? raw : "agent";
}

/**
 * Bir düğümün küredeki yeri.
 *
 * Yön kapsam sahibinden (küme), uzaklık kapsamdan (kabuk) gelir. İkisi de
 * hash'ten türediği için sonuç deterministik: aynı anı her yenilemede aynı
 * noktada durur, yeni anı gelince diğerleri kımıldamaz.
 */
export function placeNode(node: GalaxyNodeInput): GalaxyNode {
  const hash = hashId(node.id);
  const scope = scopeOf(node.scope);
  const shell = SHELL[scope];

  // 1) Küme yönü: kapsam sahibinden (proje/ajan id'si). Sahipsiz (company)
  //    anılar düğümün kendi kimliğini kullanır — çekirdek küme yapmaz, küre
  //    içinde düzgün dağılır.
  const ownerHash = hashId(node.scopeRef ?? node.id);
  const baseTheta = unit(ownerHash, 1) * Math.PI * 2;
  // cos(phi)'yi düzgün seçmek küre üzerinde DÜZGÜN dağılım verir; doğrudan
  // phi seçmek kutuplarda yığılmaya yol açardı.
  const baseCosPhi = unit(ownerHash, 2) * 2 - 1;

  // 2) Küme içi dağılım
  const theta = baseTheta + (unit(hash, 1) - 0.5) * CLUSTER_SPREAD * 2;
  const cosPhi = Math.min(
    1,
    Math.max(-1, baseCosPhi + (unit(hash, 2) - 0.5) * CLUSTER_SPREAD),
  );
  const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);

  // 3) Kabuk içinde uzaklık
  const radius = shell.inner + unit(hash, 3) * (shell.outer - shell.inner);

  return {
    ...node,
    position: [
      radius * sinPhi * Math.cos(theta),
      radius * cosPhi,
      radius * sinPhi * Math.sin(theta),
    ],
    phase: unit(hash, 5) * Math.PI * 2,
    // Önem büyüklüğe gider; taban yarıçap küçük anıların da görünmesini
    // sağlar. Şirket kapsamı biraz daha iri: çekirdek uzaktan da okunsun.
    radius: (scope === "company" ? 0.3 : 0.22) + 0.42 * clamp01(node.importance),
  };
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Kapsam renkleri — acosDark paletiyle uyumlu (mavi çekirdek → mor kol → camgöbeği toz). */
export const SCOPE_COLOR: Record<MemoryScope, string> = {
  company: "#4c9aff",
  project: "#a879ff",
  agent: "#3fd0a0",
};

/** İlişki türü → çizgi rengi (mevcut 2D grafiğin paletiyle aynı). */
export const EDGE_COLOR: Record<string, string> = {
  contradicts: "#ff4d4d",
  derived_from: "#a879ff",
  supports: "#3fd0a0",
  supersedes: "#5c6773",
  related_to: "#3a424c",
};
