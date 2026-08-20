// E2/W3 (T19) — DURABLE, DÜZENLENEBİLİR kadro önerisi.
//
// Önce: plan `tasks.context.staffingPlan` içinde donuyordu ve Founder'ın tek
// seçeneği İKİLİ onaydı (onayla/reddet). "Bir takım daha ekle", "backend'i 3
// kişi yap" diyebileceği bir yüzey YOKTU — sihirbazın eksik parçası tam olarak
// buydu.
//
// Bölüşüm: gap analizi DETERMİNİSTİK kalır (doküman kuralı, LLM yok) ve
// `existingCount` alanını besler; YENİ olan LLM adımı yalnız ÖNERİDİR (W4) ve
// `teams` dizisini yazar. İnsan `headcount`'u düzenler; sunucu her yazımda
// `existingCount`/`hireCount`/maliyeti YENİDEN türetir — istemciye asla
// türetilmiş alanları yazdırmayız.
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  companyContext,
  type CompanyContext,
  type GuardedDb,
} from "@acos/db";
import { staffingProposals } from "@acos/db/schema";
import { StaffingService, type StaffingRequirement } from "./service.js";

/** Ajan başına günlük maliyet varsayımı — hire onayı brief'iyle aynı sayı. */
const COST_CENTS_PER_HIRE = 500;

export type StaffingProposalStatus =
  | "draft"
  | "awaiting_human"
  | "confirmed"
  | "applied"
  | "cancelled";

export interface StaffingProposalTeam {
  /** kararlı satır kimliği — arayüzün React anahtarı ve PATCH kimliği */
  key: string;
  /** CAPABILITY_UNIT / slugify üzerinden org birimine eşlenir */
  capability: string;
  teamName: string;
  /** HEDEF takım büyüklüğü (insan düzenler); 0 = takımı çıkar */
  headcount: number;
  /** deterministik gap analizinden: şu an kaç kişi var (sunucu türetir) */
  existingCount: number;
  /** = max(0, headcount - existingCount) (sunucu türetir) */
  hireCount: number;
  rationale?: string;
}

export interface StaffingProposalDto {
  id: string;
  projectId: string;
  goalTaskId: string | null;
  approvalId: string | null;
  /** W5: öneriyi bekleyen iş akışı; onay bunu sinyaller. */
  workflowId: string | null;
  status: StaffingProposalStatus;
  version: number;
  source: "llm" | "deterministic" | "human";
  rationaleMd: string;
  teams: StaffingProposalTeam[];
  estimatedCostCents: number;
  createdAt: string;
  updatedAt: string;
}

export class ProposalError extends Error {
  constructor(
    readonly code: "not_found" | "stale_version" | "not_editable" | "empty_plan",
    message: string,
  ) {
    super(message);
  }
}

/** "Frontend Ekibi" → "frontend-ekibi"; satır kimliği için yeterince kararlı. */
function keyFor(capability: string): string {
  return (
    capability
      .toLowerCase()
      .replace(/[çÇ]/g, "c")
      .replace(/[ğĞ]/g, "g")
      .replace(/[ıİ]/g, "i")
      .replace(/[öÖ]/g, "o")
      .replace(/[şŞ]/g, "s")
      .replace(/[üÜ]/g, "u")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "team"
  );
}

type ProposalRow = typeof staffingProposals.$inferSelect;

function toDto(row: ProposalRow): StaffingProposalDto {
  return {
    id: row.id,
    projectId: row.projectId,
    goalTaskId: row.goalTaskId,
    approvalId: row.approvalId,
    workflowId: row.workflowId,
    status: row.status as StaffingProposalStatus,
    version: row.version,
    source: row.source as StaffingProposalDto["source"],
    rationaleMd: row.rationaleMd,
    teams: (row.teams ?? []) as StaffingProposalTeam[],
    estimatedCostCents: row.estimatedCostCents,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const OPEN_STATUSES = ["draft", "awaiting_human", "confirmed"] as const;

/**
 * İstemciden gelen ham satırları normalize eder ve TÜRETİLMİŞ alanları
 * deterministik gap analizinden yeniden hesaplar. `headcount: 0` satırı
 * düşürür — "takımı çıkar" jesti budur.
 */
async function normalize(
  db: GuardedDb,
  ctx: CompanyContext,
  raw: Array<{
    key?: string | undefined;
    capability: string;
    teamName?: string | undefined;
    headcount: number;
    rationale?: string | undefined;
  }>,
): Promise<{ teams: StaffingProposalTeam[]; costCents: number }> {
  const cleaned = raw
    .map((r) => ({
      capability: r.capability.trim().toLowerCase().replace(/\s+/g, " "),
      teamName: (r.teamName ?? r.capability).trim(),
      headcount: Math.max(0, Math.min(50, Math.round(r.headcount))),
      rationale: r.rationale,
      key: r.key,
    }))
    .filter((r) => r.capability.length > 1 && r.headcount > 0);

  // aynı yetenek iki kez yollandıysa BÜYÜK olan kazanır (kullanıcı iki satırı
  // birleştirmek istemiştir; ikisini de kurmak sessizce çift takım açardı)
  const byCapability = new Map<string, (typeof cleaned)[number]>();
  for (const row of cleaned) {
    const prev = byCapability.get(row.capability);
    if (!prev || row.headcount > prev.headcount) byCapability.set(row.capability, row);
  }
  const rows = [...byCapability.values()];
  if (rows.length === 0) return { teams: [], costCents: 0 };

  // DETERMİNİSTİK gap analizi — mevcut kadro sayımı buradan gelir, LLM'den değil
  const staffing = new StaffingService(db);
  const gap = await staffing.analyzeGap(
    ctx,
    rows.map((r) => `${r.capability} x${r.headcount}`),
  );

  const teams: StaffingProposalTeam[] = rows.map((r) => {
    const existingCount = gap.available[r.capability] ?? 0;
    const hireCount = Math.max(0, r.headcount - existingCount);
    return {
      key: r.key && r.key.length > 0 ? r.key : keyFor(r.capability),
      capability: r.capability,
      teamName: r.teamName,
      headcount: r.headcount,
      existingCount,
      hireCount,
      ...(r.rationale ? { rationale: r.rationale } : {}),
    };
  });
  const costCents = teams.reduce((sum, t) => sum + t.hireCount, 0) * COST_CENTS_PER_HIRE;
  return { teams, costCents };
}

/** Projenin AÇIK önerisi (yoksa null). */
export async function getOpenProposal(
  db: GuardedDb,
  ctx: CompanyContext,
  projectId: string,
): Promise<StaffingProposalDto | null> {
  const [row] = await db
    .select()
    .from(staffingProposals)
    .where(
      and(
        eq(staffingProposals.companyId, ctx.companyId),
        eq(staffingProposals.projectId, projectId),
        inArray(staffingProposals.status, [...OPEN_STATUSES]),
      ),
    )
    .orderBy(desc(staffingProposals.createdAt))
    .limit(1);
  return row ? toDto(row) : null;
}

export async function getProposal(
  db: GuardedDb,
  ctx: CompanyContext,
  proposalId: string,
): Promise<StaffingProposalDto> {
  const [row] = await db
    .select()
    .from(staffingProposals)
    .where(
      and(eq(staffingProposals.companyId, ctx.companyId), eq(staffingProposals.id, proposalId)),
    );
  if (!row) throw new ProposalError("not_found", "staffing proposal not found");
  return toDto(row);
}

/**
 * Öneriyi açar ya da mevcut AÇIK öneriyi döner (idempotent replay: intake
 * yeniden girerse ikinci öneri üretilmez — kısmi unique index de bunu fiziksel
 * olarak garanti eder).
 */
export async function upsertProposal(
  db: GuardedDb,
  ctx: CompanyContext,
  input: {
    projectId: string;
    goalTaskId?: string | null;
    workflowId?: string | null;
    source: "llm" | "deterministic";
    rationaleMd?: string;
    teams: Array<{
      capability: string;
      teamName?: string | undefined;
      headcount: number;
      rationale?: string | undefined;
    }>;
    status?: "draft" | "awaiting_human";
  },
): Promise<StaffingProposalDto> {
  const existing = await getOpenProposal(db, ctx, input.projectId);
  if (existing) return existing;

  const { teams, costCents } = await normalize(db, ctx, input.teams);
  const [row] = await db
    .insert(staffingProposals)
    .values({
      companyId: ctx.companyId,
      projectId: input.projectId,
      goalTaskId: input.goalTaskId ?? null,
      workflowId: input.workflowId ?? null,
      status: input.status ?? "awaiting_human",
      source: input.source,
      rationaleMd: input.rationaleMd ?? "",
      teams,
      estimatedCostCents: costCents,
    })
    .returning();
  return toDto(row!);
}

/**
 * İnsanın düzenlemesi. Tam `teams` dizisi gelir: satır eklemek = takım eklemek,
 * `headcount` değiştirmek = kadroyu değiştirmek, satırı çıkarmak = takımı
 * silmek. `version` iyimser kilittir — iki sekme aynı öneriyi ezmez.
 */
export async function editProposal(
  db: GuardedDb,
  ctx: CompanyContext,
  input: {
    proposalId: string;
    version: number;
    teams: Array<{
      key?: string | undefined;
      capability: string;
      teamName?: string | undefined;
      headcount: number;
      rationale?: string | undefined;
    }>;
    rationaleMd?: string | undefined;
  },
): Promise<StaffingProposalDto> {
  const current = await getProposal(db, ctx, input.proposalId);
  if (current.status !== "draft" && current.status !== "awaiting_human") {
    throw new ProposalError(
      "not_editable",
      `öneri "${current.status}" durumunda; yalnız draft/awaiting_human düzenlenebilir`,
    );
  }
  if (current.version !== input.version) {
    throw new ProposalError(
      "stale_version",
      `öneri bu arada değişti (senin sürümün ${input.version}, güncel ${current.version})`,
    );
  }

  const { teams, costCents } = await normalize(db, ctx, input.teams);
  const [row] = await db
    .update(staffingProposals)
    .set({
      teams,
      estimatedCostCents: costCents,
      // insan dokunduysa kaynak artık insandır — izlenebilirlik
      source: "human",
      version: current.version + 1,
      updatedAt: new Date(),
      ...(input.rationaleMd !== undefined && { rationaleMd: input.rationaleMd }),
    })
    .where(
      and(
        eq(staffingProposals.companyId, ctx.companyId),
        eq(staffingProposals.id, input.proposalId),
        eq(staffingProposals.version, input.version), // yarışta ikinci yazan kaybeder
      ),
    )
    .returning();
  if (!row) throw new ProposalError("stale_version", "öneri bu arada değişti");
  return toDto(row);
}

/**
 * Onay: öneri `confirmed`'a geçer. İş akışını UYANDIRMAK çağıranın işidir
 * (routes → signal), böylece bu modül Temporal'a bağımlı kalmaz.
 */
export async function confirmProposal(
  db: GuardedDb,
  ctx: CompanyContext,
  proposalId: string,
): Promise<StaffingProposalDto> {
  const current = await getProposal(db, ctx, proposalId);
  if (current.status === "confirmed" || current.status === "applied") return current; // idempotent
  if (current.status !== "draft" && current.status !== "awaiting_human") {
    throw new ProposalError("not_editable", `öneri "${current.status}" durumunda; onaylanamaz`);
  }
  if (current.teams.length === 0) {
    throw new ProposalError("empty_plan", "boş kadro onaylanamaz — en az bir takım gerekir");
  }
  const [row] = await db
    .update(staffingProposals)
    .set({ status: "confirmed", updatedAt: new Date() })
    .where(
      and(eq(staffingProposals.companyId, ctx.companyId), eq(staffingProposals.id, proposalId)),
    )
    .returning();
  return toDto(row!);
}

export async function cancelProposal(
  db: GuardedDb,
  ctx: CompanyContext,
  proposalId: string,
): Promise<StaffingProposalDto> {
  const [row] = await db
    .update(staffingProposals)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(
      and(eq(staffingProposals.companyId, ctx.companyId), eq(staffingProposals.id, proposalId)),
    )
    .returning();
  if (!row) throw new ProposalError("not_found", "staffing proposal not found");
  return toDto(row);
}

/**
 * Onaylanan öneriyi GERÇEĞE çevirir: Agent Factory tam olarak `teams`
 * dizisindeki takımları kurar, eksik kadroyu tamamlar ve (T17) takımları
 * projeye bağlar. Idempotent: `applied` öneri ikinci kez uygulanmaz.
 */
export async function applyProposal(
  db: GuardedDb,
  ctx: CompanyContext,
  proposalId: string,
): Promise<{ proposal: StaffingProposalDto; hiredAgentIds: string[]; createdUnits: string[] }> {
  const current = await getProposal(db, ctx, proposalId);
  if (current.status === "applied") {
    return { proposal: current, hiredAgentIds: [], createdUnits: [] };
  }
  if (current.status !== "confirmed") {
    throw new ProposalError("not_editable", `öneri "${current.status}" durumunda; uygulanamaz`);
  }
  // applyPlan HEDEF sayıya tamamlar (mevcut kadroyu sayar), o yüzden hireCount
  // değil headcount yollanır — retry ikinci kadro kurmaz.
  const plan: StaffingRequirement[] = current.teams.map((t) => ({
    capability: t.capability,
    count: t.headcount,
  }));
  const staffing = new StaffingService(db);
  const result = await staffing.applyPlan(ctx, plan, { projectId: current.projectId });
  const [row] = await db
    .update(staffingProposals)
    .set({ status: "applied", updatedAt: new Date() })
    .where(
      and(eq(staffingProposals.companyId, ctx.companyId), eq(staffingProposals.id, proposalId)),
    )
    .returning();
  return { proposal: toDto(row!), ...result };
}

/** Aktivite yüzeyi (worker → server internal ucu) için ince sarmalayıcı. */
export async function proposalForProject(
  db: GuardedDb,
  companyId: string,
  projectId: string,
): Promise<StaffingProposalDto | null> {
  return getOpenProposal(db, companyContext(companyId), projectId);
}

export { COST_CENTS_PER_HIRE, keyFor, normalize as normalizeProposalTeams };
