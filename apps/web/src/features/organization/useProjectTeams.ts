// Proje → takım kaynağı (E1'de türetilmişti, E2/W7'de KALICI BAĞA geçti).
//
// Sözleşme (Oscar, E2-faz2a-contracts.md §1):
//   GET /api/v1/companies/:companyId/project-teams
//   → { groups: [{ projectId, projectName, source:'link'|'derived',
//                  teams:[{orgUnitId,name,slug,kind,agentCount,taskCount}] }],
//       idleTeams: [{orgUnitId,name,slug,kind,agentCount}] }
// Tek sorgu, üç sorgunun yerine; `source` bir projenin kalıcı bağı henüz
// yokken (yalnız işten türetilmişken) arayüzün rozet basmasını sağlar.
//
// Uç henüz inmediyse ESKİ TÜRETME devrede kalır (tasks.projectId ×
// tasks.orgUnitId) — böylece bu ekran Oscar'ın T17'sinden bağımsız çalışır
// ve uç inince kendiliğinden kalıcı bağa geçer. Dönen şekil ikisinde de
// aynıdır; çağıran bileşenler farkı yalnız `source` alanından görür.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OrgUnit } from "@acos/contracts";
import { api, keys } from "../../lib/api.js";

export interface ProjectTeamGroup {
  projectId: string | null;
  projectName: string;
  /** 'link' = kalıcı project_team_memberships, 'derived' = işten türetildi */
  source: "link" | "derived";
  teams: OrgUnit[];
  /** takım başına o projedeki açık iş sayısı */
  taskCountByUnit: Record<string, number>;
  /** takım başına ajan sayısı (uç verdiğinde; yoksa boş) */
  agentCountByUnit: Record<string, number>;
}

interface LinkTeam {
  orgUnitId: string;
  name: string;
  slug: string;
  kind: OrgUnit["kind"];
  agentCount?: number;
  taskCount?: number;
}
interface LinkResponse {
  groups: Array<{
    projectId: string | null;
    projectName: string;
    source: "link" | "derived";
    teams: LinkTeam[];
  }>;
  idleTeams: LinkTeam[];
}

const asOrgUnit = (team: LinkTeam): OrgUnit => ({
  id: team.orgUnitId,
  name: team.name,
  slug: team.slug,
  kind: team.kind,
  parentId: null,
});

function isLinkResponse(value: unknown): value is LinkResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { groups?: unknown }).groups)
  );
}

/** Uç yoksa (404/501/ağ) null döner — çağıran taraf türetmeye düşer. */
async function fetchProjectTeams(companyId: string): Promise<LinkResponse | null> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/companies/${companyId}/project-teams`, {
      headers: { accept: "application/json" },
      credentials: "include",
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const text = await response.text();
  const json: unknown = text === "" ? null : JSON.parse(text);
  return isLinkResponse(json) ? json : null;
}

export function useProjectTeams(companyId: string): {
  groups: ProjectTeamGroup[];
  idleTeams: OrgUnit[];
  isLoading: boolean;
  /** kalıcı bağ ucu cevap veriyor mu (T17 indi mi) */
  linked: boolean;
} {
  const link = useQuery({
    queryKey: [companyId, "project-teams"],
    queryFn: () => fetchProjectTeams(companyId),
    staleTime: 15_000,
  });
  const linkOff = link.isFetched && link.data === null;

  // --- türetilmiş yedek (T17 inene kadar) ---
  const units = useQuery({
    queryKey: keys.orgUnits(companyId),
    queryFn: () => api.org.listUnits(companyId),
    enabled: linkOff,
  });
  const projects = useQuery({
    queryKey: [companyId, "projects", "list"],
    queryFn: () => api.projects.list(companyId),
    enabled: linkOff,
  });
  const tasks = useQuery({
    queryKey: keys.tasks(companyId),
    queryFn: () => api.tasks.list(companyId),
    enabled: linkOff,
  });

  const fromLink = useMemo<{ groups: ProjectTeamGroup[]; idleTeams: OrgUnit[] } | null>(() => {
    if (!link.data) return null;
    return {
      groups: link.data.groups.map((group) => ({
        projectId: group.projectId,
        projectName: group.projectName,
        source: group.source,
        teams: group.teams.map(asOrgUnit),
        taskCountByUnit: Object.fromEntries(
          group.teams.map((t) => [t.orgUnitId, t.taskCount ?? 0]),
        ),
        agentCountByUnit: Object.fromEntries(
          group.teams.map((t) => [t.orgUnitId, t.agentCount ?? 0]),
        ),
      })),
      idleTeams: link.data.idleTeams.map(asOrgUnit),
    };
  }, [link.data]);

  const derived = useMemo<{ groups: ProjectTeamGroup[]; idleTeams: OrgUnit[] }>(() => {
    const unitById = new Map((units.data ?? []).map((u) => [u.id, u]));
    const byProject = new Map<string | null, { units: Set<string>; counts: Record<string, number> }>();
    for (const task of tasks.data ?? []) {
      if (!task.orgUnitId) continue;
      const key = task.projectId ?? null;
      const entry = byProject.get(key) ?? { units: new Set<string>(), counts: {} };
      entry.units.add(task.orgUnitId);
      entry.counts[task.orgUnitId] = (entry.counts[task.orgUnitId] ?? 0) + 1;
      byProject.set(key, entry);
    }
    const groups: ProjectTeamGroup[] = (projects.data?.items ?? []).map((project) => {
      const entry = byProject.get(project.id);
      return {
        projectId: project.id,
        projectName: project.name,
        source: "derived",
        teams: [...(entry?.units ?? [])]
          .map((id) => unitById.get(id))
          .filter((u): u is OrgUnit => !!u),
        taskCountByUnit: entry?.counts ?? {},
        agentCountByUnit: {},
      };
    });
    const loose = byProject.get(null);
    if (loose && loose.units.size > 0) {
      groups.push({
        projectId: null,
        projectName: "Proje dışı",
        source: "derived",
        teams: [...loose.units].map((id) => unitById.get(id)).filter((u): u is OrgUnit => !!u),
        taskCountByUnit: loose.counts,
        agentCountByUnit: {},
      });
    }
    const claimed = new Set(groups.flatMap((g) => g.teams.map((t) => t.id)));
    const idleTeams = (units.data ?? []).filter((u) => u.kind === "team" && !claimed.has(u.id));
    return { groups, idleTeams };
  }, [units.data, projects.data, tasks.data]);

  const result = fromLink ?? derived;
  return {
    groups: result.groups,
    idleTeams: result.idleTeams,
    isLoading: link.isLoading || (linkOff && (units.isLoading || projects.isLoading || tasks.isLoading)),
    linked: fromLink !== null,
  };
}
