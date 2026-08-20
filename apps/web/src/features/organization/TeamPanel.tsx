// Takım paneli (36 §7 — U09; E1 gereksinim 4): takımlar artık PROJE bazında
// gruplanır. Headcount aktif member_of kenarlarından, canlı varlık dağılımı
// WS rozet haritasından gelir. Salt-okunur.
//
// Neden gruplu: düz liste "şirkette şu takımlar var" diyordu; Founder'ın
// sorusu "hangi proje hangi takımla yürüyor" idi. Proje→takım bağı veriden
// türetilir (useProjectTeams: tasks.projectId × tasks.orgUnitId) — şemaya
// yeni ilişki eklenmedi, backend'e dokunulmadı.
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { presenceColor } from "@acos/ui";
import type { OrgUnit } from "@acos/contracts";
import { api, keys } from "../../lib/api.js";
import { usePresence } from "../../stores/presence.js";
import { useFocus } from "../../stores/focus.js";
import { useProjectTeams } from "./useProjectTeams.js";

export function TeamPanel() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const edges = useQuery({
    queryKey: keys.orgEdges(companyId),
    queryFn: () => api.org.listEdges(companyId),
  });
  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  const badges = usePresence((s) => s.badges);
  const teamFilter = useFocus((s) => s.teamFilter);
  const setTeamFilter = useFocus((s) => s.setTeamFilter);
  const { groups, idleTeams } = useProjectTeams(companyId);

  const agentName = new Map((agents.data ?? []).map((a) => [a.id, a.name]));

  function TeamCard({ team, openTasks }: { team: OrgUnit; openTasks?: number | undefined }) {
    const memberIds = (edges.data ?? [])
      .filter((e) => e.kind === "member_of" && e.toUnitId === team.id && e.endedAt === null)
      .map((e) => e.fromAgentId);
    const byBadge = new Map<string, number>();
    for (const id of memberIds) {
      const badge = (badges[id] ?? "OFFLINE").toLowerCase();
      byBadge.set(badge, (byBadge.get(badge) ?? 0) + 1);
    }
    const leadId = (edges.data ?? []).find(
      (e) => e.kind === "leads" && e.toUnitId === team.id && e.endedAt === null,
    )?.fromAgentId;
    const active = teamFilter?.unitId === team.id;
    return (
      <button
        onClick={() =>
          setTeamFilter(active ? null : { unitId: team.id, name: team.name })
        }
        title="komuta merkezini bu takıma filtrele"
        className={`mb-1.5 w-full rounded-md border px-2.5 py-2 text-left ${
          active
            ? "border-dept-engineering bg-dept-engineering/10"
            : "border-acos-line bg-acos-bg2 hover:border-acos-fg2"
        }`}
        data-testid="team-summary"
      >
        <div className="flex items-center gap-2 text-[11px]">
          <span className="font-semibold text-acos-fg0">{team.name}</span>
          <span className="text-[8.5px] uppercase text-acos-fg2">{team.kind}</span>
          <span className="ml-auto font-mono text-[9.5px] tabular-nums text-acos-fg1">
            {memberIds.length} üye
            {openTasks ? ` · ${openTasks} iş` : ""}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[8.5px] text-acos-fg2">
          {leadId && agentName.get(leadId) && <span>Lider: {agentName.get(leadId)}</span>}
          {[...byBadge.entries()].map(([badge, count]) => (
            <span
              key={badge}
              className="rounded-full px-1.5 py-px"
              style={{ background: `${presenceColor(badge)}22`, color: presenceColor(badge) }}
            >
              {badge} {count}
            </span>
          ))}
        </div>
      </button>
    );
  }

  const populated = groups.filter((g) => g.teams.length > 0);

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-acos-bg1 p-2" data-testid="team-panel">
      {populated.map((group) => (
        <section
          key={group.projectId ?? "loose"}
          className="mb-3"
          data-testid={`team-project-${group.projectId ?? "none"}`}
        >
          <div className="mb-1 flex items-center gap-2 border-b border-acos-line/60 pb-1">
            <span className="truncate text-[11px] font-semibold text-acos-fg0">
              {group.projectName}
            </span>
            <span className="ml-auto text-[9px] text-acos-fg2">
              {group.teams.length} takım
            </span>
          </div>
          {group.teams.map((team) => (
            <TeamCard key={team.id} team={team} openTasks={group.taskCountByUnit[team.id]} />
          ))}
        </section>
      ))}

      {idleTeams.length > 0 && (
        <section data-testid="team-project-idle">
          <div className="mb-1 flex items-center gap-2 border-b border-acos-line/60 pb-1">
            <span className="text-[11px] font-semibold text-acos-fg2">İş bekleyen takımlar</span>
            <span className="ml-auto text-[9px] text-acos-fg2">{idleTeams.length}</span>
          </div>
          {idleTeams.map((team) => (
            <TeamCard key={team.id} team={team} />
          ))}
        </section>
      )}

      {populated.length === 0 && idleTeams.length === 0 && (
        <div className="p-2 text-[10px] text-acos-fg2">Henüz takım yok.</div>
      )}
    </div>
  );
}
