// Agent Monitor grid (24 §6.2): live presence badges from presenceStore
// (WS-fed, no polling) next to the lifecycle status pill.
import { useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AgentAvatar, AgentStatusPill, Button, Card, Select, StatusPill } from "@acos/ui";
import { api, keys } from "../../lib/api.js";
import { usePresence } from "../../stores/presence.js";
import { useTerminalGrid } from "../../stores/terminalGrid.js";
import { HireWizard } from "./HireWizard.js";

const BADGE_TONE = {
  WORKING: "ok",
  COMMUNICATING: "accent",
  REVIEWING: "accent",
  ESCALATING: "danger",
  BLOCKED: "danger",
  OFFLINE: "neutral",
} as const;

export function AgentsView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  // İşten çıkarılanlar varsayılan listede yok — geçmişe bakmak için aç
  const [showOffboarded, setShowOffboarded] = useState(false);
  const agents = useQuery({
    queryKey: [...keys.agents(companyId), showOffboarded ? "all" : "active"],
    queryFn: () => api.agents.list(companyId, showOffboarded ? { include: "all" } : {}),
  });
  const badges = usePresence((s) => s.badges);
  const closedAgentIds = useTerminalGrid((s) => s.closedAgentIds);
  const toggleTerminal = useTerminalGrid((s) => s.toggleAgent);
  const [statusFilter, setStatusFilter] = useState("");
  const [hireOpen, setHireOpen] = useState(false);

  const filtered = (agents.data ?? []).filter(
    (agent) => statusFilter === "" || agent.status === statusFilter,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-bold text-acos-fg0">Ajanlar</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowOffboarded((v) => !v)}
            className="rounded-md border border-acos-line px-2 py-1 text-xs text-acos-fg1 hover:bg-acos-bg3"
            data-testid="toggle-offboarded"
          >
            {showOffboarded ? "Eskileri gizle" : "Eski çalışanlar"}
          </button>
          <Select
            aria-label="Durum filtresi"
            className="!w-40"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">tüm durumlar</option>
            <option value="active">aktif</option>
            <option value="paused">duraklatıldı</option>
            <option value="draft">taslak</option>
            <option value="offboarded">işten çıkarıldı</option>
          </Select>
          <Button onClick={() => setHireOpen(true)} data-testid="hire-button">
            Ajan işe al
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-acos-fg2">
          Henüz ajan yok — Organizasyon'dan işe alın.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="agent-grid">
          {filtered.map((agent) => (
            <Link
              key={agent.id}
              to="/c/$companyId/agents/$agentId"
              params={{ companyId, agentId: agent.id }}
            >
              <Card className="transition-shadow hover:shadow-md">
                <div className="flex items-center gap-3">
                  <AgentAvatar name={agent.name} imageUrl={agent.avatarUrl} />
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-acos-fg0">{agent.name}</p>
                    <p className="text-xs text-acos-fg2">
                      {agent.displayNumber} · {agent.seniority} · L{agent.autonomyLevel}
                    </p>
                  </div>
                  <span className="ml-auto flex flex-col items-end gap-1">
                    <span className="flex items-center gap-1.5">
                      {/* terminal grid open/close (36 §4): view-only toggle */}
                      <button
                        data-testid={`terminal-toggle-${agent.id}`}
                        title={
                          closedAgentIds.includes(agent.id)
                            ? "terminalini grid'de aç"
                            : "terminalini grid'den kaldır"
                        }
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleTerminal(agent.id);
                        }}
                        className={
                          closedAgentIds.includes(agent.id)
                            ? "text-xs text-acos-fg2 opacity-50 hover:opacity-100"
                            : "text-xs text-accent-600"
                        }
                      >
                        ⌨{closedAgentIds.includes(agent.id) ? "+" : "✕"}
                      </button>
                      <AgentStatusPill status={agent.status} />
                    </span>
                    {badges[agent.id] && (
                      <span data-testid={`presence-${agent.id}`}>
                        <StatusPill
                          tone={BADGE_TONE[badges[agent.id] as keyof typeof BADGE_TONE] ?? "neutral"}
                        >
                          {badges[agent.id]}
                        </StatusPill>
                      </span>
                    )}
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <HireWizard companyId={companyId} open={hireOpen} onClose={() => setHireOpen(false)} />
    </div>
  );
}
