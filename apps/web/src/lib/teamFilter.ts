// P1-A (UI/UX review): the active team filter resolved to a member-id set —
// shared by every Command Center panel that narrows to the chip's team.
// `set === null` means "no filter"; an EMPTY set is a real, valid state
// (0-member team → panels show their empty states, never a white screen).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, keys } from "./api.js";
import { useFocus, type TeamFilter } from "../stores/focus.js";

export function useTeamMemberSet(companyId: string): {
  team: TeamFilter | null;
  members: ReadonlySet<string> | null;
} {
  const team = useFocus((s) => s.teamFilter);
  const edges = useQuery({
    queryKey: keys.orgEdges(companyId),
    queryFn: () => api.org.listEdges(companyId),
    enabled: team !== null,
  });
  const members = useMemo(() => {
    if (!team) return null;
    return new Set(
      (edges.data ?? [])
        .filter((e) => e.kind === "member_of" && e.toUnitId === team.unitId && e.endedAt === null)
        .map((e) => e.fromAgentId),
    );
  }, [team, edges.data]);
  return { team, members };
}

/**
 * E2/W8 — OFİS ODAĞI SEÇİLİ PROJEYİ İZLER (2026-08-20).
 *
 * Ofis şirket ölçeğinde tek kat; per-proje projektör (W9) FAZ 2B'de. Bu ara
 * adım ucuz ve dürüst: seçili projenin ajan kümesi focusAgentIds olarak
 * geçilir, üyesi olmayanlar zaten sönük çiziliyor (alpha 0.22). Yani "proje
 * değiştir → ofis o ekibi öne çıkarsın" bugün çalışır, kat hâlâ şirketin.
 *
 * Öncelik: TAKIM filtresi (en dar) > seçili PROJE > filtre yok.
 * Projenin ajanları İŞTEN türetilir: o projedeki görevlerin sahipleri +
 * o görevlerin org birimlerinin üyeleri (T17 kalıcı bağı inince tek kaynak
 * olarak o kullanılacak).
 */
export function useFocusAgentSet(companyId: string): {
  members: ReadonlySet<string> | null;
  reason: "team" | "project" | null;
} {
  const { team, members: teamMembers } = useTeamMemberSet(companyId);
  const projectId = useFocus((s) => s.selectedProjectId);
  const edges = useQuery({
    queryKey: keys.orgEdges(companyId),
    queryFn: () => api.org.listEdges(companyId),
    enabled: projectId !== null,
  });
  const tasks = useQuery({
    queryKey: keys.tasks(companyId),
    queryFn: () => api.tasks.list(companyId),
    enabled: projectId !== null,
  });

  const projectMembers = useMemo(() => {
    if (!projectId) return null;
    const rows = (tasks.data ?? []).filter((t) => t.projectId === projectId);
    const units = new Set(rows.map((t) => t.orgUnitId).filter((id): id is string => !!id));
    const set = new Set(rows.map((t) => t.ownerAgentId).filter((id): id is string => !!id));
    for (const edge of edges.data ?? []) {
      if (edge.kind === "member_of" && edge.endedAt === null && edge.toUnitId && units.has(edge.toUnitId)) {
        set.add(edge.fromAgentId);
      }
    }
    return set;
  }, [projectId, tasks.data, edges.data]);

  if (team) return { members: teamMembers, reason: "team" };
  if (projectMembers) return { members: projectMembers, reason: "project" };
  return { members: null, reason: null };
}
