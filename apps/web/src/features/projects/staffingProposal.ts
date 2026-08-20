// E2/W6 — kadro önerisi (staffing proposal) İSTEMCİSİ.
//
// Sözleşme Oscar tarafından DONDURULDU (hive: E2-faz2a-contracts.md §2) ve
// buradaki tipler birebir onu izler. Uçlar henüz inmediği için tek bir
// yerde "uç yoksa yerel taslak" düşüşü var: ekran çalışır, akış
// gösterilebilir ve taslak olduğu kullanıcıya AÇIKÇA söylenir. Uçlar inince
// bu dosyada değişecek tek şey `local` düşüşünün kendiliğinden devre dışı
// kalması — sihirbaz bileşeni aynı kalır.
//
// Akış (W4+W5, sözleşmede tarif edildiği gibi): Founder hedefi verir → CEO
// (LLM) takımları+kişi sayısını ÖNERİR → öneri status='awaiting_human' ile
// düşer ve planlama iş akışı Temporal sinyalinde DURUR → kullanıcı PATCH ile
// düzenler → confirm iş akışını devam ettirir → applyPlan tam olarak o
// takımları/ajanları kurar ve projeye bağlar.

export interface StaffingProposalTeam {
  /** kararlı satır kimliği — React key VE PATCH kimliği */
  key: string;
  /** CAPABILITY_UNIT eşlemesi (slug → org birimi) */
  capability: string;
  teamName: string;
  /** HEDEF büyüklük — kullanıcı düzenler (0 = bu takımı çıkar) */
  headcount: number;
  /** deterministik boşluk analizi: kaç kişi zaten var */
  existingCount: number;
  /** SUNUCU TÜRETİR = max(0, headcount - existingCount) — salt okunur */
  hireCount: number;
  rationale?: string;
}

export interface StaffingProposal {
  id: string;
  projectId: string;
  goalTaskId?: string | null;
  approvalId?: string | null;
  status: "draft" | "awaiting_human" | "confirmed" | "applied" | "cancelled";
  /** iyimser eşzamanlılık — PATCH'te geri yollanır */
  version: number;
  source: "llm" | "deterministic" | "human";
  rationaleMd: string;
  teams: StaffingProposalTeam[];
  estimatedCostCents: number;
  /** UI işareti: uç henüz yokken üretilmiş YEREL taslak (sunucuda yok) */
  local?: boolean;
}

/** PATCH gövdesindeki takım (hireCount/existingCount GÖNDERİLMEZ). */
export type ProposalTeamEdit = Pick<
  StaffingProposalTeam,
  "key" | "capability" | "teamName" | "headcount"
> & { rationale?: string };

export const toEdit = (team: StaffingProposalTeam): ProposalTeamEdit => ({
  key: team.key,
  capability: team.capability,
  teamName: team.teamName,
  headcount: team.headcount,
  ...(team.rationale !== undefined && { rationale: team.rationale }),
});

export class StaleProposalError extends Error {
  constructor() {
    super("stale_version");
  }
}

function csrf(): string | null {
  const match = /(?:^|;\s*)acos_csrf=([^;]+)/.exec(document.cookie);
  return match?.[1] ?? null;
}

/**
 * Sözleşmedeki uçlara ince bir sarmalayıcı. `null` = "uç yok / erişilemedi"
 * (404, 501, ağ hatası) — çağıran taraf yerel taslağa düşer. 409 ayrı:
 * gerçek bir çakışmadır, yutulmaz.
 */
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
    return null;
  }
  if (response.status === 409) throw new StaleProposalError();
  if (!response.ok) return null;
  const text = await response.text();
  return text === "" ? null : (JSON.parse(text) as unknown);
}

function isProposal(value: unknown): value is StaffingProposal {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { teams?: unknown }).teams) &&
    typeof (value as { version?: unknown }).version === "number"
  );
}

/** GET /companies/:cid/projects/:pid/staffing-proposal */
export async function fetchProposal(
  companyId: string,
  projectId: string,
): Promise<StaffingProposal | null> {
  const raw = await call(
    "GET",
    `/api/v1/companies/${companyId}/projects/${projectId}/staffing-proposal`,
  );
  return isProposal(raw) ? raw : null;
}

/** PATCH /companies/:cid/staffing-proposals/:id — TAM istenen takım listesi. */
export async function patchProposal(
  companyId: string,
  proposalId: string,
  version: number,
  teams: ProposalTeamEdit[],
): Promise<StaffingProposal | null> {
  const raw = await call("PATCH", `/api/v1/companies/${companyId}/staffing-proposals/${proposalId}`, {
    version,
    teams,
  });
  return isProposal(raw) ? raw : null;
}

/** POST .../confirm — duran planlama iş akışını devam ettirir (applyPlan). */
export async function confirmProposal(
  companyId: string,
  proposalId: string,
): Promise<{ ok: boolean } | null> {
  const raw = await call(
    "POST",
    `/api/v1/companies/${companyId}/staffing-proposals/${proposalId}/confirm`,
    {},
  );
  return raw === null ? null : { ok: true };
}

/** POST .../cancel — planlama parkta kalır. */
export async function cancelProposal(
  companyId: string,
  proposalId: string,
): Promise<{ ok: boolean } | null> {
  const raw = await call(
    "POST",
    `/api/v1/companies/${companyId}/staffing-proposals/${proposalId}/cancel`,
    {},
  );
  return raw === null ? null : { ok: true };
}

// ---------------------------------------------------------------------------
// Uç henüz yokken: gereksinim metninden deterministik YEREL taslak.
// LLM değildir; yalnız ekranı çalışır tutar ve kullanıcıya taslak olduğu
// söylenir. Sözleşmedeki alan adlarının aynısını üretir ki uçlar inince
// bileşen tarafında hiçbir şey değişmesin.
// ---------------------------------------------------------------------------
const SIGNALS: Array<{ test: RegExp; team: Omit<StaffingProposalTeam, "key" | "hireCount"> }> = [
  {
    test: /(web|site|landing|vitrin|arayüz|frontend|react)/i,
    team: {
      capability: "frontend",
      teamName: "Frontend",
      headcount: 2,
      existingCount: 0,
      rationale: "Arayüz ve sayfa üretimi",
    },
  },
  {
    test: /(api|backend|sunucu|veritabanı|database|entegrasyon|ödeme|payment)/i,
    team: {
      capability: "backend",
      teamName: "Backend",
      headcount: 2,
      existingCount: 0,
      rationale: "Servisler, veri modeli, entegrasyonlar",
    },
  },
  {
    test: /(mobil|ios|android|uygulama)/i,
    team: {
      capability: "mobile",
      teamName: "Mobil",
      headcount: 2,
      existingCount: 0,
      rationale: "Mobil istemci",
    },
  },
  {
    test: /(tasarım|design|ux|ui|marka)/i,
    team: {
      capability: "design",
      teamName: "Tasarım",
      headcount: 1,
      existingCount: 0,
      rationale: "UX/UI ve marka dili",
    },
  },
  {
    test: /(test|kalite|qa|güvenlik|security)/i,
    team: {
      capability: "qa",
      teamName: "QA",
      headcount: 1,
      existingCount: 0,
      rationale: "Kalite ve regresyon",
    },
  },
  {
    test: /(seo|pazarlama|marketing|içerik|content)/i,
    team: {
      capability: "marketing",
      teamName: "Pazarlama",
      headcount: 1,
      existingCount: 0,
      rationale: "İçerik ve SEO",
    },
  },
];

export function localDraftProposal(
  projectId: string,
  name: string,
  requirements: string,
): StaffingProposal {
  const text = `${name} ${requirements}`;
  const matched = SIGNALS.filter((s) => s.test.test(text));
  const teams: StaffingProposalTeam[] = (matched.length > 0
    ? matched.map((s) => s.team)
    : [
        {
          capability: "product",
          teamName: "Ürün",
          headcount: 2,
          existingCount: 0,
          rationale: "Gereksinimden net bir uzmanlık sinyali çıkmadı — çekirdek ekip",
        },
      ]
  ).map((team) => ({
    ...team,
    key: team.capability,
    hireCount: Math.max(0, team.headcount - team.existingCount),
  }));
  return {
    id: `local-${projectId}`,
    projectId,
    goalTaskId: null,
    approvalId: null,
    status: "awaiting_human",
    version: 0,
    source: "deterministic",
    rationaleMd:
      "Taslak kadro: gereksinim metnindeki uzmanlık sinyallerinden çıkarıldı. Sayıları değiştirebilir, takım ekleyip çıkarabilirsiniz.",
    teams,
    estimatedCostCents: 0,
    local: true,
  };
}

/** Yerel taslakta düzenleme: sunucunun yaptığı türetmeyi birebir taklit eder. */
export function applyLocalEdit(
  proposal: StaffingProposal,
  teams: ProposalTeamEdit[],
): StaffingProposal {
  const existing = new Map(proposal.teams.map((t) => [t.key, t]));
  return {
    ...proposal,
    version: proposal.version + 1,
    source: "human",
    teams: teams.map((team) => {
      const existingCount = existing.get(team.key)?.existingCount ?? 0;
      return {
        ...team,
        existingCount,
        hireCount: Math.max(0, team.headcount - existingCount),
      };
    }),
  };
}
