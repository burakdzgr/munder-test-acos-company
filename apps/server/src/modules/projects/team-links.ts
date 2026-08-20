// E2/W1 (T17) — proje ↔ takım bağının okuma/yazma yüzeyi.
//
// Bağ artık `project_team_memberships`'te KALICI (migration 0026). Ama eski
// türetim (tasks.projectId × tasks.orgUnitId) ölmedi: henüz hiç bağı olmayan
// bir proje için TÜREV yanıtlanır, böylece göç öncesi kurulmuş projeler ve
// bağı elle silinmiş projeler boş görünmez. Grup başına `source` alanı hangi
// yolun kullanıldığını dürüstçe söyler — arayüz "gerçek bağ" ile "işten
// tahmin" arasını ayırt edebilsin.
import { and, eq, isNull, sql } from "drizzle-orm";
import type { CompanyContext, GuardedDb } from "@acos/db";
import { orgUnits, projects, projectTeamMemberships } from "@acos/db/schema";

export interface ProjectTeamDto {
  orgUnitId: string;
  name: string;
  slug: string;
  kind: string;
  /** birimdeki aktif ajan sayısı (şirket kapsamı — ajan projeye hapsedilmez) */
  agentCount: number;
  /** bu PROJEDE bu birime düşen açık görev sayısı */
  taskCount: number;
}

export interface ProjectTeamGroupDto {
  projectId: string | null;
  projectName: string;
  source: "link" | "derived";
  teams: ProjectTeamDto[];
}

export interface ProjectTeamsResponse {
  groups: ProjectTeamGroupDto[];
  /** hiçbir projeye bağlı olmayan takımlar — "henüz iş almadı" kovası */
  idleTeams: Omit<ProjectTeamDto, "taskCount">[];
}

interface UnitRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  agent_count: number;
}

/**
 * Şirketin TÜM projeleri için takım grupları — tek sorgu kümesi.
 * (Arayüz bunu üç ayrı liste ucunu birleştirerek yapıyordu; artık tek uç.)
 */
export async function listProjectTeams(
  db: GuardedDb,
  ctx: CompanyContext,
): Promise<ProjectTeamsResponse> {
  const units = (
    await db.execute(sql`
      SELECT u.id, u.name, u.slug, u.kind,
             (SELECT count(*)::int FROM agents a
               WHERE a.company_id = u.company_id AND a.org_unit_id = u.id AND a.status = 'active'
             ) AS agent_count
        FROM org_units u
       WHERE u.company_id = ${ctx.companyId} AND u.archived_at IS NULL
    `)
  ).rows as unknown as UnitRow[];
  const unitById = new Map(units.map((u) => [u.id, u]));

  const projects = (
    await db.execute(sql`
      SELECT p.id, p.name FROM projects p
       WHERE p.company_id = ${ctx.companyId} AND p.archived_at IS NULL
       ORDER BY p.created_at ASC
    `)
  ).rows as Array<{ id: string; name: string }>;

  // 1) kalıcı bağlar
  const links = (
    await db.execute(sql`
      SELECT m.project_id, m.org_unit_id
        FROM project_team_memberships m
       WHERE m.company_id = ${ctx.companyId} AND m.removed_at IS NULL
    `)
  ).rows as Array<{ project_id: string; org_unit_id: string }>;
  const linkedByProject = new Map<string, Set<string>>();
  for (const link of links) {
    const set = linkedByProject.get(link.project_id) ?? new Set<string>();
    set.add(link.org_unit_id);
    linkedByProject.set(link.project_id, set);
  }

  // 2) işten türev (hem yedek yol hem görev sayacı)
  const derived = (
    await db.execute(sql`
      SELECT t.project_id, t.org_unit_id, count(*)::int AS n
        FROM tasks t
       WHERE t.company_id = ${ctx.companyId} AND t.org_unit_id IS NOT NULL
       GROUP BY t.project_id, t.org_unit_id
    `)
  ).rows as Array<{ project_id: string | null; org_unit_id: string; n: number }>;
  const derivedByProject = new Map<string | null, Map<string, number>>();
  for (const row of derived) {
    const map = derivedByProject.get(row.project_id) ?? new Map<string, number>();
    map.set(row.org_unit_id, Number(row.n));
    derivedByProject.set(row.project_id, map);
  }

  const toTeam = (unitId: string, taskCount: number): ProjectTeamDto | null => {
    const unit = unitById.get(unitId);
    if (!unit) return null;
    return {
      orgUnitId: unit.id,
      name: unit.name,
      slug: unit.slug,
      kind: unit.kind,
      agentCount: Number(unit.agent_count),
      taskCount,
    };
  };

  const groups: ProjectTeamGroupDto[] = projects.map((project) => {
    const counts = derivedByProject.get(project.id) ?? new Map<string, number>();
    const linked = linkedByProject.get(project.id);
    // GERÇEK bağ varsa o kazanır; hiç yoksa türeve düşeriz (boş proje
    // görünmez olmasın — göç öncesi projeler ve yeni projeler için)
    const useLink = linked !== undefined && linked.size > 0;
    const ids = useLink ? [...linked] : [...counts.keys()];
    return {
      projectId: project.id,
      projectName: project.name,
      source: useLink ? "link" : "derived",
      teams: ids
        .map((id) => toTeam(id, counts.get(id) ?? 0))
        .filter((t): t is ProjectTeamDto => t !== null),
    };
  });

  // projesiz iş de görünür kalsın (şirket içi / hedef görevleri)
  const loose = derivedByProject.get(null);
  if (loose && loose.size > 0) {
    groups.push({
      projectId: null,
      projectName: "Proje dışı",
      source: "derived",
      teams: [...loose.entries()]
        .map(([id, n]) => toTeam(id, n))
        .filter((t): t is ProjectTeamDto => t !== null),
    });
  }

  const claimed = new Set(groups.flatMap((g) => g.teams.map((t) => t.orgUnitId)));
  const idleTeams = units
    .filter((u) => u.kind === "team" && !claimed.has(u.id))
    .map((u) => ({
      orgUnitId: u.id,
      name: u.name,
      slug: u.slug,
      kind: u.kind,
      agentCount: Number(u.agent_count),
    }));

  return { groups, idleTeams };
}

/**
 * Takımı projeye bağlar. Idempotent: aynı aktif bağ ikinci kez yazılmaz
 * (kısmi unique index), yumuşak silinmiş bağ yeniden canlandırılır.
 *
 * Not: tipli Drizzle API kullanılır, ham `INSERT ... SELECT` değil — S4
 * kiracılık muhafızı INSERT'te `company_id`'yi sütun listesi + VALUES
 * kalıbında arıyor (tenant.ts assertTenantSafe), SELECT'li gövdeyi kapsam
 * dışı sayıp sorguyu reddediyor.
 */
export async function linkProjectTeam(
  db: GuardedDb,
  ctx: CompanyContext,
  input: { projectId: string; orgUnitId: string; addedBy?: "system" | "founder" | "agent" },
): Promise<{ linked: boolean }> {
  // ikisi de AYNI şirkete ait olmalı — FK şirket sınırını bilmez
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, input.projectId)));
  const [unit] = await db
    .select({ id: orgUnits.id })
    .from(orgUnits)
    .where(and(eq(orgUnits.companyId, ctx.companyId), eq(orgUnits.id, input.orgUnitId)));
  if (!project || !unit) return { linked: false };

  const inserted = await db
    .insert(projectTeamMemberships)
    .values({
      companyId: ctx.companyId,
      projectId: input.projectId,
      orgUnitId: input.orgUnitId,
      addedBy: input.addedBy ?? "system",
    })
    .onConflictDoNothing()
    .returning({ id: projectTeamMemberships.id });
  if (inserted.length > 0) return { linked: true };

  // aktif bağ zaten varsa hiçbir şey yapma; yalnız KAPATILMIŞ bağı geri aç
  const [live] = await db
    .select({ id: projectTeamMemberships.id })
    .from(projectTeamMemberships)
    .where(
      and(
        eq(projectTeamMemberships.companyId, ctx.companyId),
        eq(projectTeamMemberships.projectId, input.projectId),
        eq(projectTeamMemberships.orgUnitId, input.orgUnitId),
        isNull(projectTeamMemberships.removedAt),
      ),
    );
  if (live) return { linked: false };

  const revived = await db
    .update(projectTeamMemberships)
    .set({ removedAt: null, addedAt: new Date() })
    .where(
      and(
        eq(projectTeamMemberships.companyId, ctx.companyId),
        eq(projectTeamMemberships.projectId, input.projectId),
        eq(projectTeamMemberships.orgUnitId, input.orgUnitId),
      ),
    )
    .returning({ id: projectTeamMemberships.id });
  return { linked: revived.length > 0 };
}

/** Bağı YUMUŞAK kaldırır — geçmiş silinmez (INV-11 ruhu). */
export async function unlinkProjectTeam(
  db: GuardedDb,
  ctx: CompanyContext,
  input: { projectId: string; orgUnitId: string },
): Promise<{ unlinked: boolean }> {
  const rows = await db
    .update(projectTeamMemberships)
    .set({ removedAt: new Date() })
    .where(
      and(
        eq(projectTeamMemberships.companyId, ctx.companyId),
        eq(projectTeamMemberships.projectId, input.projectId),
        eq(projectTeamMemberships.orgUnitId, input.orgUnitId),
        isNull(projectTeamMemberships.removedAt),
      ),
    )
    .returning({ id: projectTeamMemberships.id });
  return { unlinked: rows.length > 0 };
}
