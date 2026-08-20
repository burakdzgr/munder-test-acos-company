// FAZ 2B / 2B-4 — proje başına TEMA. Saf veri.
//
// Munder'ın tema kayıt defteri bütün bir gösteri paketi (harita + atlas +
// palet + prop çapaları) taşıyor; bizde şimdilik AYNI KOMPOZİSYON, projeye
// göre değişen PALET var: her projenin katı kendi tonunda açılıyor, ama
// oda/masa düzeni aynı kalıyor (insan "tam Munder katı" istedi — düzen
// değişmemeli). Yükleyici harita-güdümlü olduğu için ileride ikinci bir
// .tmj düşürmek yeterli: burada `mapId` alanı o gün için duruyor.
//
// Tema kimliği projeden DETERMİNİSTİK türetilir: aynı proje her açılışta
// aynı katı görür (kimlik kalıcılığı — ajan avatarlarındaki kuralın aynısı).

export interface OfficeTheme {
  id: string;
  label: string;
  /** ileride: farklı bir .tmj; şimdilik hepsi aynı kompozisyon */
  mapId: "office";
  /** zemin tonları (tileset.ts bunlarla pişirir) */
  floorOpen: number;
  floorCorridor: number;
  floorWood: number;
  floorCafe: number;
}

export const OFFICE_THEMES: OfficeTheme[] = [
  {
    id: "slate",
    label: "Kurumsal",
    mapId: "office",
    floorOpen: 0x7f8798,
    floorCorridor: 0x8d94a1,
    floorWood: 0x7a5a3d,
    floorCafe: 0x9a8570,
  },
  {
    id: "sage",
    label: "Yeşil kat",
    mapId: "office",
    floorOpen: 0x7c9184,
    floorCorridor: 0x8fa398,
    floorWood: 0x6f5c3c,
    floorCafe: 0x93876a,
  },
  {
    id: "sand",
    label: "Kum",
    mapId: "office",
    floorOpen: 0x9a917f,
    floorCorridor: 0xa79d8a,
    floorWood: 0x82603c,
    floorCafe: 0xa08a6c,
  },
  {
    id: "dusk",
    label: "Alacakaranlık",
    mapId: "office",
    floorOpen: 0x77768f,
    floorCorridor: 0x87869c,
    floorWood: 0x6b4f39,
    floorCafe: 0x8d7a6d,
  },
];

export const DEFAULT_THEME: OfficeTheme = OFFICE_THEMES[0] as OfficeTheme;

/** Proje kimliğinden kararlı tema seçimi (proje yoksa varsayılan kat). */
export function themeForProject(projectId: string | null): OfficeTheme {
  if (!projectId) return DEFAULT_THEME;
  // FNV-1a: 31'lik toplama, UUID gibi tekrarlı karakterli dizgilerde
  // çakışıyordu (2222…, 3333… ve 9999… ÜÇÜ DE aynı temaya düşüyordu —
  // fikstürlerde fark edildi). FNV karakter konumuna daha duyarlı.
  let hash = 0x811c9dc5;
  for (let i = 0; i < projectId.length; i += 1) {
    hash ^= projectId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return OFFICE_THEMES[hash % OFFICE_THEMES.length] as OfficeTheme;
}
