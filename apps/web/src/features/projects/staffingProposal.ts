// E2/W6 — kadro önerisi (staffing proposal) ADAPTÖRÜ.
//
// Sihirbazın ihtiyacı: "CEO şu takımları şu kişi sayısıyla öneriyor" → kullanıcı
// düzenler → onaylar. Bu önerinin KALICI hâli Oscar'ın T19'unda (W3/W4/W5)
// doğuyor; sözleşme yayınlanana kadar UI bloke olmasın diye sınır BURADA
// tek noktada toplandı:
//
//   1) Gerçek uç varsa onu kullanır (GET/PATCH/POST .../staffing-proposal).
//   2) Uç henüz yoksa (404/501) YEREL bir taslak önerir ve düzenlemeyi
//      yerelde tutar — ekran çalışır, akış gösterilebilir, ama "taslak"
//      olduğu kullanıcıya AÇIKÇA söylenir (source alanı).
//
// T19 indiğinde bu dosyadaki fetch'ler tipli istemciye çevrilecek; sihirbaz
// bileşeni değişmeyecek.

export interface ProposalRole {
  positionTitle: string;
  seniority: string;
  count: number;
}

export interface ProposalTeam {
  /** düzenleme sırasında kararlı kimlik (sunucu tarafı key'i ya da yerel) */
  key: string;
  name: string;
  capability: string;
  headcount: number;
  lead?: { positionTitle: string; seniority: string };
  roles?: ProposalRole[];
  rationale?: string;
}

export interface StaffingProposal {
  projectId: string | null;
  status: "thinking" | "proposed" | "adjusted" | "confirmed" | "applied" | "failed";
  rationale?: string;
  teams: ProposalTeam[];
  estimatedCostCents?: number;
  /** "server" = kalıcı öneri (T19), "local-draft" = uç yokken üretilen taslak */
  source: "server" | "local-draft";
}

function csrf(): string | null {
  const match = /(?:^|;\s*)acos_csrf=([^;]+)/.exec(document.cookie);
  return match?.[1] ?? null;
}

async function call(method: string, path: string, body?: unknown): Promise<unknown | null> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    const token = csrf();
    if (token) headers["x-csrf-token"] = token;
  }
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
      credentials: "include",
    });
  } catch {
    return null; // ağ yok — çağıran taraf yerel taslağa düşer
  }
  // 404/501 = uç henüz yok (T19 inmedi); 4xx/5xx = gerçek hata, ikisini de
  // null'a indiriyoruz çünkü sihirbaz her hâlde ilerleyebilmeli.
  if (!response.ok) return null;
  const text = await response.text();
  return text === "" ? null : (JSON.parse(text) as unknown);
}

const base = (companyId: string, projectId: string) =>
  `/api/v1/companies/${companyId}/projects/${projectId}/staffing-proposal`;

function isProposal(value: unknown): value is Omit<StaffingProposal, "source"> {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { teams?: unknown }).teams)
  );
}

/** Sunucudaki öneriyi getir; yoksa null. */
export async function fetchProposal(
  companyId: string,
  projectId: string,
): Promise<StaffingProposal | null> {
  const raw = await call("GET", base(companyId, projectId));
  return isProposal(raw) ? { ...raw, source: "server" } : null;
}

/** Kullanıcının düzenlediği TAM takım listesini gönder. */
export async function patchProposal(
  companyId: string,
  projectId: string,
  teams: ProposalTeam[],
): Promise<StaffingProposal | null> {
  const raw = await call("PATCH", base(companyId, projectId), { teams });
  return isProposal(raw) ? { ...raw, source: "server" } : null;
}

/** Onayla: kadro uygulanır ve iş başlar. */
export async function confirmProposal(
  companyId: string,
  projectId: string,
  teams: ProposalTeam[],
): Promise<{ applied: boolean; detail?: string } | null> {
  const raw = await call("POST", `${base(companyId, projectId)}/confirm`, { teams });
  if (raw === null) return null;
  const applied = (raw as { applied?: boolean }).applied;
  return { applied: applied !== false };
}

// ---------------------------------------------------------------------------
// Yerel taslak (uç yokken): gereksinim metnindeki sinyallerden kadro önerir.
// Bu bir LLM DEĞİL — sadece ekranı çalışır tutan deterministik bir iskelet.
// ---------------------------------------------------------------------------
const SIGNALS: Array<{ test: RegExp; team: Omit<ProposalTeam, "key"> }> = [
  {
    test: /(web|site|landing|vitrin|arayüz|frontend|react)/i,
    team: {
      name: "Frontend",
      capability: "frontend",
      headcount: 2,
      lead: { positionTitle: "Frontend Lead", seniority: "lead" },
      rationale: "Arayüz ve sayfa üretimi",
    },
  },
  {
    test: /(api|backend|sunucu|veritabanı|database|entegrasyon|ödeme|payment)/i,
    team: {
      name: "Backend",
      capability: "backend",
      headcount: 2,
      lead: { positionTitle: "Backend Lead", seniority: "lead" },
      rationale: "Servisler, veri modeli, entegrasyonlar",
    },
  },
  {
    test: /(mobil|ios|android|uygulama)/i,
    team: {
      name: "Mobil",
      capability: "mobile",
      headcount: 2,
      rationale: "Mobil istemci",
    },
  },
  {
    test: /(tasarım|design|ux|ui|marka)/i,
    team: { name: "Tasarım", capability: "design", headcount: 1, rationale: "UX/UI ve marka dili" },
  },
  {
    test: /(test|kalite|qa|güvenlik|security)/i,
    team: { name: "QA", capability: "qa", headcount: 1, rationale: "Kalite ve regresyon" },
  },
  {
    test: /(seo|pazarlama|marketing|içerik|content)/i,
    team: { name: "Pazarlama", capability: "marketing", headcount: 1, rationale: "İçerik ve SEO" },
  },
];

export function localDraftProposal(name: string, requirements: string): StaffingProposal {
  const text = `${name} ${requirements}`;
  const teams: ProposalTeam[] = SIGNALS.filter((s) => s.test.test(text)).map((s, index) => ({
    key: `local-${index}`,
    ...s.team,
  }));
  if (teams.length === 0) {
    teams.push({
      key: "local-0",
      name: "Ürün",
      capability: "product",
      headcount: 2,
      rationale: "Gereksinimden net bir uzmanlık sinyali çıkmadı — çekirdek ekip",
    });
  }
  return {
    projectId: null,
    status: "proposed",
    rationale:
      "Taslak kadro: gereksinim metnindeki uzmanlık sinyallerinden çıkarıldı. Sayıları değiştirebilir, takım ekleyip çıkarabilirsiniz.",
    teams,
    source: "local-draft",
  };
}
