// Takım panel (36 §7 — U09): per-team summary for the right-bottom tab —
// headcount from active member_of edges, live presence distribution from
// the WS badge map. Read-only.
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { presenceColor } from "@acos/ui";
import { api, keys } from "../../lib/api.js";
import { usePresence } from "../../stores/presence.js";

export function TeamPanel() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const units = useQuery({
    queryKey: keys.orgUnits(companyId),
    queryFn: () => api.org.listUnits(companyId),
  });
  const edges = useQuery({
    queryKey: keys.orgEdges(companyId),
    queryFn: () => api.org.listEdges(companyId),
  });
  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  const badges = usePresence((s) => s.badges);

  const agentName = new Map((agents.data ?? []).map((a) => [a.id, a.name]));
  const teams = (units.data ?? []).filter((u) => u.kind === "team" || u.kind === "department");

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-acos-bg1 p-2" data-testid="team-panel">
      {teams.map((team) => {
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
        return (
          <div
            key={team.id}
            className="mb-2 rounded-md border border-acos-line bg-acos-bg2 px-2.5 py-2"
            data-testid="team-summary"
          >
            <div className="flex items-center gap-2 text-[11px]">
              <span className="font-semibold text-acos-fg0">{team.name}</span>
              <span className="text-[8.5px] uppercase text-acos-fg2">{team.kind}</span>
              <span className="ml-auto font-mono text-[9.5px] tabular-nums text-acos-fg1">
                {memberIds.length} üye
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[8.5px] text-acos-fg2">
              {leadId && agentName.get(leadId) && <span>Lider: {agentName.get(leadId)}</span>}
              {[...byBadge.entries()].map(([badge, count]) => (
                <span
                  key={badge}
                  className="rounded-full px-1.5 py-px"
                  style={{
                    background: `${presenceColor(badge)}22`,
                    color: presenceColor(badge),
                  }}
                >
                  {badge} {count}
                </span>
              ))}
            </div>
          </div>
        );
      })}
      {teams.length === 0 && (
        <div className="p-2 text-[10px] text-acos-fg2">Henüz takım yok.</div>
      )}
    </div>
  );
}
