// Staffing Gap + Agent Factory (LIFECYCLE TASK 9+10).
//
// Deterministik karşılaştırma: proje gereksinim yetenekleri (Requirement
// Analyzer çıktısı) mevcut organizasyonla eşlenir; eksikler TEK toplu
// Founder onayına dönüşür (kind=hire). Onay sonrası Agent Factory takımı
// kurar, ajanları işe alır, hiyerarşiyi ve araç izinlerini bağlar. Yanlış /
// eksik kurulmuş takım projeyi ASLA başarısız akışa sokmaz — bekletir.
import { and, eq, sql } from "drizzle-orm";
import {
  ApprovalsService,
  companyContext,
  ProjectsService,
  TasksService,
  TaskStateService,
  type CompanyContext,
  type GuardedDb,
} from "@acos/db";
import { approvals as approvalsTable, notifications, orgUnits, positions, tasks } from "@acos/db/schema";
import { OrgService } from "../org/service.js";
import { AgentsService } from "../agents/service.js";
import { seedToolGrants } from "../../seed.js";
import { linkProjectTeam } from "../projects/team-links.js";

export interface StaffingRequirement {
  capability: string;
  count: number;
}

export interface StaffingGap {
  hasTopExecutive: boolean;
  required: StaffingRequirement[];
  available: Record<string, number>;
  missing: StaffingRequirement[];
}

/** "Frontend x2" → { capability: "frontend", count: 2 } */
export function parseRequirement(raw: string): StaffingRequirement {
  const m = /^(.*?)(?:\s*[x×]\s*(\d{1,2}))?$/i.exec(raw.trim());
  const capability = (m?.[1] ?? raw).trim().toLowerCase().replace(/\s+/g, " ");
  return { capability, count: Math.max(1, Number(m?.[2] ?? 1)) };
}

/** Bilinen yetenek → birim slug eşlemesi (grant tohumuyla hizalı). */
const CAPABILITY_UNIT: Record<string, string> = {
  frontend: "frontend",
  backend: "backend",
  fullstack: "engineering",
  devops: "devops",
  qa: "qa",
  test: "qa",
  security: "security",
  seo: "marketing",
  marketing: "marketing",
  design: "design",
  mobile: "mobile",
  data: "data",
};

function slugify(text: string): string {
  return (
    text
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

export class StaffingService {
  constructor(private readonly db: GuardedDb) {}

  /** Deterministik gap analizi — LLM yok (doc kuralı). */
  async analyzeGap(ctx: CompanyContext, requiredRaw: string[]): Promise<StaffingGap> {
    const required = requiredRaw.map(parseRequirement).filter((r) => r.capability.length > 1);
    const projectsService = new ProjectsService(this.db);
    const topExec = await projectsService.topExecutive(ctx).catch(() => null);

    const available: Record<string, number> = {};
    for (const req of required) {
      const cap = `%${req.capability}%`;
      const result = await this.db.execute(sql`
        SELECT count(DISTINCT a.id)::int AS n
        FROM agents a
        LEFT JOIN positions p ON p.id = a.position_id
        LEFT JOIN org_units u ON u.id = a.org_unit_id
        WHERE a.company_id = ${ctx.companyId} AND a.status = 'active'
          AND (
            u.slug ILIKE ${cap} OR u.name ILIKE ${cap}
            OR p.title ILIKE ${cap} OR p.default_role ILIKE ${cap}
            OR EXISTS (
              SELECT 1 FROM agent_skills ask JOIN skills s ON s.id = ask.skill_id
              WHERE ask.company_id = ${ctx.companyId} AND ask.agent_id = a.id
                AND s.name ILIKE ${cap}
            )
          )
      `);
      available[req.capability] = Number((result.rows[0] as { n: number }).n);
    }

    const missing = required
      .map((r) => ({ capability: r.capability, count: r.count - (available[r.capability] ?? 0) }))
      .filter((r) => r.count > 0);
    return { hasTopExecutive: topExec !== null, required, available, missing };
  }

  /**
   * Agent Factory (TASK 10): onaylanan plan → takım + pozisyon + ajanlar +
   * reports_to + araç izinleri + proje ataması. Idempotent: aynı birim/
   * pozisyon yeniden yaratılmaz (INVARIANT 15); ajan sayısı birimdeki
   * mevcutla tamamlanır.
   */
  async applyPlan(
    ctx: CompanyContext,
    plan: StaffingRequirement[],
    opts: { projectId?: string | undefined } = {},
  ): Promise<{ hiredAgentIds: string[]; createdUnits: string[] }> {
    const orgService = new OrgService(this.db);
    const agentsService = new AgentsService(this.db, orgService);
    const projectsService = new ProjectsService(this.db);
    const topExec = await projectsService.topExecutive(ctx).catch(() => null);

    const hiredAgentIds: string[] = [];
    const createdUnits: string[] = [];
    for (const req of plan) {
      const unitSlug = CAPABILITY_UNIT[req.capability] ?? slugify(req.capability);
      let [unit] = await this.db
        .select()
        .from(orgUnits)
        .where(and(eq(orgUnits.companyId, ctx.companyId), eq(orgUnits.slug, unitSlug)));
      if (!unit) {
        unit = await orgService.createUnit(ctx, {
          name: req.capability.charAt(0).toUpperCase() + req.capability.slice(1),
          slug: unitSlug,
          kind: "team",
        });
        createdUnits.push(unitSlug);
      }
      // E2/W1 (T17): Agent Factory bir PROJE için kadro kuruyorsa takım o
      // projeye BAĞLANIR. Öncesinde bağ yalnız işten türüyordu, yani sihirbazın
      // kurduğu ekip ilk görev dağıtılana kadar projede görünmüyordu.
      if (opts.projectId) {
        await linkProjectTeam(this.db, ctx, {
          projectId: opts.projectId,
          orgUnitId: unit.id,
          addedBy: "system",
        }).catch(() => {
          /* bağ kozmetik değil ama kadro kurulumunu ASLA düşürmez */
        });
      }
      const positionTitle = `${req.capability.charAt(0).toUpperCase() + req.capability.slice(1)} Uzmanı`;
      let [position] = await this.db
        .select()
        .from(positions)
        .where(and(eq(positions.companyId, ctx.companyId), eq(positions.title, positionTitle)));
      if (!position) {
        position = await orgService.createPosition(ctx, {
          title: positionTitle,
          seniorityTrack: ["junior", "mid", "senior"],
          defaultRole: "member",
        });
      }
      // birimdeki mevcut aktif sayıya TAMAMLA — retry ikinci kadro kurmaz
      // (sayım lider işe alınmadan ÖNCE: lider üye kontenjanından düşmez)
      const [{ n: existing }] = (
        await this.db.execute(sql`
          SELECT count(*)::int AS n FROM agents
          WHERE company_id = ${ctx.companyId} AND org_unit_id = ${unit.id} AND status = 'active'
        `)
      ).rows as [{ n: number }];

      // P0-2 (15 §2.2 "…else the lead"): code-review yalnız reviewer/lead/
      // manager rollerine açık — executive de member da listede değil. Yalnız
      // member'lardan kurulan takımda request_review İNCELEYECEK KİMSE
      // bulamıyor ve görev süresiz REVIEW'da asılı kalıyordu. Her kurulan
      // takım inceleme-yetkin bir liderle doğar; üyeler lidere raporlar
      // (04 §3: CEO rutin işi doğrudan geliştiriciye atamaz), lider tepe
      // yöneticiye raporlar.
      let [unitLead] = (
        await this.db.execute(sql`
          SELECT a.id FROM agents a
          JOIN positions p ON p.id = a.position_id
          WHERE a.company_id = ${ctx.companyId} AND a.org_unit_id = ${unit.id}
            AND a.status = 'active' AND p.default_role IN ('lead','manager')
          LIMIT 1
        `)
      ).rows as [{ id: string } | undefined];
      if (!unitLead) {
        const leadTitle = `${req.capability.charAt(0).toUpperCase() + req.capability.slice(1)} Lideri`;
        let [leadPosition] = await this.db
          .select()
          .from(positions)
          .where(and(eq(positions.companyId, ctx.companyId), eq(positions.title, leadTitle)));
        if (!leadPosition) {
          leadPosition = await orgService.createPosition(ctx, {
            title: leadTitle,
            seniorityTrack: ["senior", "expert"],
            defaultRole: "lead",
          });
        }
        const lead = await agentsService.hire(ctx, {
          name: leadTitle,
          positionId: leadPosition.id,
          orgUnitId: unit.id,
          seniority: "senior",
          autonomyLevel: 4, // 2026-08-18 Founder kararı: lider/yönetici ≥L4
          persona: `${req.capability} takım lideri: iş dağıtır, kod inceler, kaliteden sorumludur.`,
          managerAgentId: topExec?.id ?? null,
          leadsUnit: true,
          activate: true,
          ...(opts.projectId && { projectId: opts.projectId }),
        });
        hiredAgentIds.push(lead.id);
        unitLead = { id: lead.id };
      }

      for (let i = Number(existing); i < req.count; i += 1) {
        const agent = await agentsService.hire(ctx, {
          name: `${positionTitle} ${i + 1}`,
          positionId: position.id,
          orgUnitId: unit.id,
          seniority: "mid",
          autonomyLevel: 3,
          persona: `${req.capability} alanında uzman, üretime dönük çalışan bir ekip üyesi.`,
          managerAgentId: unitLead?.id ?? topExec?.id ?? null,
          activate: true,
          ...(opts.projectId && { projectId: opts.projectId }),
        });
        hiredAgentIds.push(agent.id);
      }
    }
    // yeni birimler araç izinlerini hemen alır
    await seedToolGrants(this.db, ctx).catch(() => {});
    return { hiredAgentIds, createdUnits };
  }
}

export interface PlanningContinuation {
  state: "staffing_review" | "waiting_for_founder" | "executing";
  goalTaskId: string | null;
  approvalId: string | null;
  missing: StaffingRequirement[];
}

/**
 * TASK 9 orkestrasyonu — planning'in tek devam noktası. Intake workflow,
 * approval verdict hook'u ve Founder'ın "planlamaya devam" düğmesi hep
 * burayı çağırır; idempotent.
 */
export async function continueProjectPlanning(
  deps: {
    guardedDb: GuardedDb;
    startAgentWorkflow?:
      | ((input: { companyId: string; agentId: string; taskId: string }) => Promise<boolean>)
      | null
      | undefined;
  },
  companyId: string,
  projectId: string,
): Promise<PlanningContinuation> {
  const ctx = companyContext(companyId);
  const db = deps.guardedDb;
  const projectsService = new ProjectsService(db);
  const staffing = new StaffingService(db);
  const taskState = new TaskStateService(db);

  const project = await projectsService.get(ctx, projectId);
  const advance = async (to: string) => {
    await projectsService
      .transition(ctx, projectId, to as never, { kind: "system", id: null })
      .catch(() => {});
  };

  // gereksinim analizi artefaktı (TASK 8) → yetenek listesi
  let analysis = await loadRequirementAnalysis(db, ctx, projectId);
  // FAIL-CLOSED (P0-1, canlı kanıt 2026-08-19): analyzeRequirementsActivity
  // degrade-safe olduğu için artefakt hiç oluşmayabiliyor; boş liste "kadro
  // tam" sayılınca TEK KİŞİLİK (yalnız CEO) şirket bile doğrudan executing'e
  // geçiyor ve Agent Factory dalı hiç çalışmıyordu. Dosya başındaki ilke
  // ("yanlış/eksik kurulmuş takım projeyi ASLA başarısız akışa sokmaz —
  // bekletir") gereği analiz yok/boşsa kadro TAM DEĞİL varsayılır:
  // deterministik asgari mühendislik gereksinimi yazılır (degraded artefakt —
  // karar izlenebilir kalır) ve gap analizi normal yolundan Founder onayı üretir.
  if (!analysis || (analysis.required_capabilities ?? []).length === 0) {
    const fallback = {
      goal: project.objectiveMd.slice(0, 200),
      required_capabilities: ["fullstack"],
      degraded: true,
      degraded_reason: "requirement analyzer produced no capabilities; assuming minimum engineering staffing (fail-closed)",
    };
    await projectsService.saveRequirementAnalysis(ctx, projectId, fallback).catch(() => {});
    analysis = fallback;
  }
  const capabilities = analysis.required_capabilities ?? [];

  const topExec = await projectsService.topExecutive(ctx).catch(() => null);
  if (!topExec) {
    // hiç yönetici yok: proje BEKLER, Founder'a bildirim düşer (başarısız akış yok)
    await advance("staffing_review");
    await notifyFounder(db, ctx, {
      kind: "staffing",
      title: `"${project.name}" kadro bekliyor`,
      bodyMd:
        "Organizasyonda aktif bir tepe yönetici yok. Organizasyon ekranından CEO işe alın " +
        "(veya kadroyu kurun); proje planlaması kaldığı yerden devam eder.",
      refs: { projectId },
    });
    return { state: "staffing_review", goalTaskId: null, approvalId: null, missing: [] };
  }

  const gap = await staffing.analyzeGap(ctx, capabilities);

  // GOAL her iki durumda da var olmalı (onay ona bağlanır)
  const routed = await projectsService.routeIntake(ctx, projectId, {
    objective: project.objectiveMd,
    reportArtifactId: project.intakeReportArtifactId ?? null,
    findingsSummary: analysis?.goal ?? project.objectiveMd.slice(0, 400),
  });

  if (gap.missing.length > 0) {
    const approvalId = await createStaffingApproval(db, ctx, {
      projectName: project.name,
      projectId,
      goalTaskId: routed.goalTaskId,
      ceoAgentId: routed.ceoAgentId,
      gap,
    });
    await advance("staffing_review");
    await advance("waiting_for_founder");
    return {
      state: "waiting_for_founder",
      goalTaskId: routed.goalTaskId,
      approvalId,
      missing: gap.missing,
    };
  }

  // kadro tamam → GOAL CEO'ya atanır, döngü başlar, proje EXECUTING
  const [goalRow] = await db
    .select({ status: tasks.status, ownerAgentId: tasks.ownerAgentId })
    .from(tasks)
    .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, routed.goalTaskId)));
  if (goalRow && goalRow.status === "PLANNED" && !goalRow.ownerAgentId) {
    await taskState.assign(
      ctx,
      routed.goalTaskId,
      { agentId: routed.ceoAgentId, reason: "planning continuation" },
      { kind: "founder" },
    );
  }
  await deps
    .startAgentWorkflow?.({ companyId, agentId: routed.ceoAgentId, taskId: routed.goalTaskId })
    ?.catch(() => false);
  await advance("executing");
  return { state: "executing", goalTaskId: routed.goalTaskId, approvalId: null, missing: [] };
}

async function loadRequirementAnalysis(
  db: GuardedDb,
  ctx: CompanyContext,
  projectId: string,
): Promise<{ goal?: string; required_capabilities?: string[] } | null> {
  const result = await db.execute(sql`
    SELECT content_md FROM artifacts
    WHERE company_id = ${ctx.companyId} AND project_id = ${projectId}
      AND kind = 'document' AND meta->>'type' = 'requirement_analysis'
    ORDER BY created_at DESC LIMIT 1
  `);
  const row = result.rows[0] as { content_md?: string } | undefined;
  if (!row?.content_md) return null;
  try {
    return JSON.parse(row.content_md) as { goal?: string; required_capabilities?: string[] };
  } catch {
    return null;
  }
}

async function notifyFounder(
  db: GuardedDb,
  ctx: CompanyContext,
  input: { kind: string; title: string; bodyMd: string; refs: Record<string, unknown> },
): Promise<void> {
  const result = await db.execute(sql`
    SELECT cm.user_id FROM company_members cm
    WHERE cm.company_id = ${ctx.companyId} AND cm.role = 'founder' AND cm.removed_at IS NULL
    LIMIT 1
  `);
  const founder = result.rows[0] as { user_id: string } | undefined;
  if (!founder) return;
  await db.insert(notifications).values({
    companyId: ctx.companyId,
    userId: founder.user_id,
    kind: input.kind,
    title: input.title,
    bodyMd: input.bodyMd,
    refs: input.refs,
  });
}

async function createStaffingApproval(
  db: GuardedDb,
  ctx: CompanyContext,
  input: {
    projectName: string;
    projectId: string;
    goalTaskId: string;
    ceoAgentId: string;
    gap: StaffingGap;
  },
): Promise<string> {
  // idempotent re-entry: continueProjectPlanning'in her tekrar girişi (intake
  // retry, Founder düğmesi, verdict hook) buradan geçer — aynı GOAL için
  // bekleyen hire onayı varsa YENİSİ açılmaz (reddedilmiş onay sayılmaz:
  // Founder reddettiyse sonraki giriş taze onay üretebilmeli)
  const [existingPending] = await db
    .select({ id: approvalsTable.id })
    .from(approvalsTable)
    .where(
      and(
        eq(approvalsTable.companyId, ctx.companyId),
        eq(approvalsTable.taskId, input.goalTaskId),
        eq(approvalsTable.kind, "hire"),
        eq(approvalsTable.status, "pending"),
      ),
    );
  if (existingPending) return existingPending.id;

  // plan GOAL context'inde taşınır (brief 11 alanla sabittir)
  const tasksService = new TasksService(db);
  const goal = await tasksService.get(ctx, input.goalTaskId);
  const context = (goal?.context ?? {}) as Record<string, unknown>;
  if (!context.staffingPlan) {
    await db
      .update(tasks)
      .set({ context: { ...context, staffingPlan: input.gap.missing, staffingProjectId: input.projectId } })
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.goalTaskId)));
  }

  const missingLine = input.gap.missing
    .map((m) => `${m.capability} x${m.count}`)
    .join(", ");
  const estCostCents = input.gap.missing.reduce((sum, m) => sum + m.count, 0) * 500; // ~5$/gün/ajan varsayım
  const approvals = new ApprovalsService(db);
  const { row } = await approvals.create(ctx, {
    kind: "hire",
    requestedByAgentId: input.ceoAgentId,
    risk: "medium",
    urgency: "high",
    costCents: estCostCents,
    taskId: input.goalTaskId,
    brief: {
      title: `Kadro onayı: ${input.projectName}`.slice(0, 120),
      request: `Bu proje için eksik kadro: ${missingLine}. Gerekli takımları kurup ajan almama izin veriyor musun?`,
      reason:
        "Proje gereksinim analizi mevcut organizasyonla karşılaştırıldı; eksik yetenekler görev dağıtımını engelliyor.",
      attempted: ["Mevcut ajanlar yetenek/birim/pozisyon eşleşmesiyle tarandı — eksik kapatılamadı."],
      options: [
        {
          option: "Onayla",
          pros: `Takımlar kurulur, ${input.gap.missing.reduce((s, m) => s + m.count, 0)} ajan işe alınır, proje yürütmeye geçer.`,
          cons: "Ajan başına LLM maliyeti günlük bütçeden düşer.",
          cost_cents: estCostCents,
        },
        {
          option: "Reddet",
          pros: "Kadro kararını erteler; Organizasyon ekranından elle kurabilirsin.",
          cons: "Proje kadro beklemede kalır, görev dağıtımı başlamaz.",
          cost_cents: 0,
        },
      ],
      recommendation: "Onay öneriyorum: eksik yetenek olmadan görevler dağıtılamaz.",
      risk: "low — ajanlar şirket içi kalıcı varlıklardır, proje bitince başka işe atanabilirler.",
      cost: { amount_cents: estCostCents, currency: "USD" },
      impact: `Proje "${input.projectName}" yürütmeye geçer; eksik roller: ${missingLine}.`,
      urgency: "high — proje planlaması bu karara bağlı bekliyor",
      deadline: null,
    },
  });
  return row.id;
}
