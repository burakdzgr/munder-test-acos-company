// Proje → takım türetimi (E1 gereksinim 4).
//
// Şemada proje ile org birimi arasında DOĞRUDAN bir bağ yok (bilerek: bir
// takım aynı anda birden çok projede çalışabilir, 09 §2). Bağ İŞTEN doğar:
// `tasks.projectId` + `tasks.orgUnitId`. Burada bu ilişki okunur — proje
// başına distinct orgUnitId — böylece arayüz "her projenin kendi takımları"
// diyebiliyor. Salt-okunur, yeni endpoint YOK (mevcut liste uçlarıyla).
//
// Not: görev listesi varsayılan "active" penceresini kullanır (arşiv + bir
// haftadan eski kapanmışlar hariç), yani gösterilen eşleşme ŞU AN yürüyen
// işin fotoğrafıdır — tarihsel tüm atamaların değil.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OrgUnit } from "@acos/contracts";
import { api, keys } from "../../lib/api.js";

export interface ProjectTeamGroup {
  projectId: string | null;
  projectName: string;
  /** projeye bağlı görevlerden türeyen takımlar (birim satırının kendisi) */
  teams: OrgUnit[];
  /** projede açık görevi olan takım başına görev sayısı */
  taskCountByUnit: Record<string, number>;
}

export function useProjectTeams(companyId: string) {
  const units = useQuery({
    queryKey: keys.orgUnits(companyId),
    queryFn: () => api.org.listUnits(companyId),
  });
  const projects = useQuery({
    queryKey: [companyId, "projects", "list"],
    queryFn: () => api.projects.list(companyId),
  });
  const tasks = useQuery({
    queryKey: keys.tasks(companyId),
    queryFn: () => api.tasks.list(companyId),
  });

  const groups = useMemo<ProjectTeamGroup[]>(() => {
    const unitById = new Map((units.data ?? []).map((u) => [u.id, u]));
    const projectItems = projects.data?.items ?? [];
    const byProject = new Map<string | null, { units: Set<string>; counts: Record<string, number> }>();
    for (const task of tasks.data ?? []) {
      if (!task.orgUnitId) continue;
      const key = task.projectId ?? null;
      const entry = byProject.get(key) ?? { units: new Set<string>(), counts: {} };
      entry.units.add(task.orgUnitId);
      entry.counts[task.orgUnitId] = (entry.counts[task.orgUnitId] ?? 0) + 1;
      byProject.set(key, entry);
    }

    const result: ProjectTeamGroup[] = projectItems.map((project) => {
      const entry = byProject.get(project.id);
      return {
        projectId: project.id,
        projectName: project.name,
        teams: [...(entry?.units ?? [])].map((id) => unitById.get(id)).filter((u): u is OrgUnit => !!u),
        taskCountByUnit: entry?.counts ?? {},
      };
    });

    // Projesiz iş de görünür kalsın (şirket içi/hedef görevleri).
    const loose = byProject.get(null);
    if (loose && loose.units.size > 0) {
      result.push({
        projectId: null,
        projectName: "Proje dışı",
        teams: [...loose.units].map((id) => unitById.get(id)).filter((u): u is OrgUnit => !!u),
        taskCountByUnit: loose.counts,
      });
    }
    return result;
  }, [units.data, projects.data, tasks.data]);

  /** Hiçbir projeye bağlı işi olmayan takımlar — "henüz iş almadı" kovası. */
  const idleTeams = useMemo<OrgUnit[]>(() => {
    const claimed = new Set(groups.flatMap((g) => g.teams.map((t) => t.id)));
    return (units.data ?? []).filter((u) => u.kind === "team" && !claimed.has(u.id));
  }, [groups, units.data]);

  return { groups, idleTeams, isLoading: units.isLoading || projects.isLoading || tasks.isLoading };
}
