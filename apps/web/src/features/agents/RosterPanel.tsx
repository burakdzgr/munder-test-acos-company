// Çalışanlar panel (36 §7 — U09): compact dark roster for the right-bottom
// tab. Row = avatar (initials until the U15 pixel faces) · name/role · live
// presence badge · terminal grid toggle (36 §4) · agent-monitor link.
// Clicking a row drives focusStore (cross-panel highlight).
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { cn, presenceColor } from "@acos/ui";
import { api, keys } from "../../lib/api.js";
import { useTeamMemberSet } from "../../lib/teamFilter.js";
import { usePresence } from "../../stores/presence.js";
import { useFocus } from "../../stores/focus.js";
import { useTerminalGrid } from "../../stores/terminalGrid.js";
import { portraitUrl, resolveAvatarId } from "../office/characters.js";

export function RosterPanel() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  const badges = usePresence((s) => s.badges);
  const selectedAgentId = useFocus((s) => s.selectedAgentId);
  const setSelectedAgent = useFocus((s) => s.setSelectedAgent);
  const closedAgentIds = useTerminalGrid((s) => s.closedAgentIds);
  const toggleTerminal = useTerminalGrid((s) => s.toggleAgent);

  const { team, members } = useTeamMemberSet(companyId);
  const items = (agents.data ?? []).filter(
    (a) => a.status !== "offboarded" && (members === null || members.has(a.id)),
  );

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-acos-bg1" data-testid="roster-panel">
      {team && (
        <div className="border-b border-acos-line bg-dept-engineering/10 px-2 py-1 text-[9px] text-dept-engineering">
          Filtre: {team.name}
        </div>
      )}
      {team && items.length === 0 && (
        <div className="p-3 text-[10px] text-acos-fg2" data-testid="roster-empty-team">
          {team.name} takımında henüz üye yok — "+ Ajan Ekle" ile yerleştir.
        </div>
      )}
      {items.map((agent) => {
        const badge = badges[agent.id] ?? "OFFLINE";
        const selected = agent.id === selectedAgentId;
        return (
          <div
            key={agent.id}
            data-testid={`roster-row-${agent.id}`}
            onClick={() => setSelectedAgent(selected ? null : agent.id)}
            className={cn(
              "flex cursor-pointer items-center gap-2 border-b border-acos-line/50 px-2 py-1.5",
              selected ? "bg-dept-engineering/10" : "hover:bg-acos-bg2",
            )}
          >
            {/* pixel face (U15): same character as the office floor */}
            <img
              src={portraitUrl(resolveAvatarId(agent.id, agent.avatarUrl))}
              alt=""
              className="h-5 w-5 shrink-0 rounded bg-acos-bg3 [image-rendering:pixelated]"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[10.5px] font-semibold text-acos-fg0">
                {agent.name}
              </span>
              <span className="block text-[8.5px] text-acos-fg2">
                {agent.displayNumber} · {agent.seniority} · L{agent.autonomyLevel}
              </span>
            </span>
            <span
              className="rounded-full px-1.5 py-px text-[8px] font-semibold"
              style={{
                background: `${presenceColor(badge.toLowerCase())}22`,
                color: presenceColor(badge.toLowerCase()),
              }}
            >
              {badge}
            </span>
            <button
              title={
                closedAgentIds.includes(agent.id)
                  ? "terminalini grid'de aç"
                  : "terminalini grid'den kaldır"
              }
              onClick={(e) => {
                e.stopPropagation();
                toggleTerminal(agent.id);
              }}
              className={cn(
                "text-[10px]",
                closedAgentIds.includes(agent.id)
                  ? "text-acos-fg2 opacity-60 hover:opacity-100"
                  : "text-dept-engineering",
              )}
            >
              ⌨
            </button>
            <Link
              to="/c/$companyId/agents/$agentId"
              params={{ companyId, agentId: agent.id }}
              onClick={(e) => e.stopPropagation()}
              className="text-[10px] text-acos-fg2 hover:text-acos-fg0"
              title="Ajan Monitörü"
            >
              ↗
            </Link>
          </div>
        );
      })}
    </div>
  );
}
