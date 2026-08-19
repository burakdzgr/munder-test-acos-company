// Command-center shell (24 §1, 36 §3 — U02): dark acosDark chrome. Top bar =
// brand · company switcher · team chips (+ Takım) · global search · token
// pill (wired in U11) · + Ajan Ekle · approvals/notifications badges ·
// Founder menu. Left icon rail keeps all 14 views reachable (accessible
// names unchanged for the e2e suite). Legacy views render on a light island
// inside the dark chrome until U03 wraps them as dockview panels.
import { useEffect, useState, type ComponentType } from "react";
import { Link, Outlet, useNavigate, useParams, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  cn,
  departmentColors,
  type IconProps,
  CommandIcon,
  DashboardIcon,
  OfficeIcon,
  TasksIcon,
  AgentsIcon,
  ProjectsIcon,
  MemoryIcon,
  OrganizationIcon,
  SkillsIcon,
  CommunicationIcon,
  TerminalsIcon,
  ApprovalsIcon,
  EventsIcon,
  ReportsIcon,
  CostsIcon,
  SettingsIcon,
  BellIcon,
} from "@acos/ui";
import { api, keys } from "../lib/api.js";
import { useEventTicker } from "../stores/eventTicker.js";
import { usePresence } from "../stores/presence.js";
import { useUiPrefs, type CommandPreset } from "../stores/uiPrefs.js";
import { useFocus } from "../stores/focus.js";
import { RealtimeDispatcher, useRealtimeStatus } from "../realtime/RealtimeDispatcher.js";
import { HireModal } from "../features/agents/HireModal.js";
import { TeamManageModal } from "../features/organization/TeamManageModal.js";
import { useNotifications } from "../stores/notifications.js";
import { Toasts } from "./Toasts.js";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const PRESETS: Array<{ key: CommandPreset; label: string }> = [
  { key: "operations", label: "Ops" },
  { key: "engineering", label: "Eng" },
  { key: "overview", label: "Genel" },
];

// id = kararlı test/route anahtarı (data-testid={`nav-${id}`}); label = görünen
// + erişilebilir Türkçe ad. e2e seçicileri nav-* testid'lerini kullanır.
const NAV_ITEMS: Array<{
  id: string;
  label: string;
  icon: ComponentType<IconProps>;
  path?: string;
}> = [
  { id: "command", label: "Komuta", icon: CommandIcon, path: "/c/$companyId" },
  { id: "dashboard", label: "Dashboard", icon: DashboardIcon, path: "/c/$companyId/dashboard" },
  { id: "office", label: "Ofis", icon: OfficeIcon, path: "/c/$companyId/office" },
  { id: "tasks", label: "Görevler", icon: TasksIcon, path: "/c/$companyId/tasks" },
  { id: "agents", label: "Ajanlar", icon: AgentsIcon, path: "/c/$companyId/agents" },
  { id: "projects", label: "Projeler", icon: ProjectsIcon, path: "/c/$companyId/projects" },
  { id: "memory", label: "Hafıza", icon: MemoryIcon, path: "/c/$companyId/memory" },
  {
    id: "organization",
    label: "Organizasyon",
    icon: OrganizationIcon,
    path: "/c/$companyId/organization",
  },
  { id: "skills", label: "Yetenekler", icon: SkillsIcon, path: "/c/$companyId/skills" },
  {
    id: "communication",
    label: "İletişim",
    icon: CommunicationIcon,
    path: "/c/$companyId/communication",
  },
  { id: "terminals", label: "Terminaller", icon: TerminalsIcon, path: "/c/$companyId/terminals" },
  { id: "approvals", label: "Onaylar", icon: ApprovalsIcon, path: "/c/$companyId/approvals" },
  { id: "events", label: "Olaylar", icon: EventsIcon, path: "/c/$companyId/events" },
  { id: "reports", label: "Raporlar", icon: ReportsIcon, path: "/c/$companyId/reports" },
  { id: "costs", label: "Maliyetler", icon: CostsIcon, path: "/c/$companyId/costs" },
  { id: "settings", label: "Ayarlar", icon: SettingsIcon, path: "/c/$companyId/settings" },
];

function GlobalSearch({ companyId }: { companyId: string }) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  const hits = q.trim()
    ? (agents.data ?? []).filter((a) => a.name.toLowerCase().includes(q.trim().toLowerCase()))
    : [];

  async function open(agentId: string) {
    setQ("");
    await navigate({ to: "/c/$companyId/agents/$agentId", params: { companyId, agentId } });
  }

  return (
    <div className="relative hidden md:block">
      <input
        data-testid="global-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) void open(hits[0].id);
          if (e.key === "Escape") setQ("");
        }}
        placeholder="ara…"
        className="w-40 rounded-md border border-acos-line bg-acos-bg2 px-2 py-0.5 text-[11px] text-acos-fg0 placeholder:text-acos-fg2 focus:border-dept-engineering focus:outline-none"
      />
      {hits.length > 0 && (
        <ul className="absolute left-0 top-full z-50 mt-1 max-h-56 w-56 overflow-auto rounded-md border border-acos-line bg-acos-bg2 py-1 shadow-lg">
          {hits.slice(0, 8).map((agent) => (
            <li key={agent.id}>
              <button
                onMouseDown={() => void open(agent.id)}
                className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[11px] text-acos-fg0 hover:bg-acos-bg3"
              >
                {agent.name}
                <span className="ml-auto text-[9px] text-acos-fg2">{agent.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TeamChips({ companyId }: { companyId: string }) {
  const navigate = useNavigate();
  const [manageOpen, setManageOpen] = useState(false);
  const units = useQuery({
    queryKey: keys.orgUnits(companyId),
    queryFn: () => api.org.listUnits(companyId),
  });
  const edges = useQuery({
    queryKey: keys.orgEdges(companyId),
    queryFn: () => api.org.listEdges(companyId),
  });
  const teamFilter = useFocus((s) => s.teamFilter);
  const setTeamFilter = useFocus((s) => s.setTeamFilter);
  const teams = (units.data ?? []).filter((u) => u.kind === "team");
  const headcount = (unitId: string) =>
    (edges.data ?? []).filter(
      (e) => e.kind === "member_of" && e.toUnitId === unitId && e.endedAt === null,
    ).length;

  // P1-A: a chip FILTERS the Command Center to that team (0-member teams
  // included — panels show their empty states); second click clears.
  function toggle(team: { id: string; name: string }) {
    setTeamFilter(
      teamFilter?.unitId === team.id ? null : { unitId: team.id, name: team.name },
    );
    void navigate({ to: "/c/$companyId", params: { companyId } });
  }

  return (
    // N7: chips are decorative context — they yield first under ~1100px
    <div className="hidden min-w-0 items-center gap-1.5 lg:flex" data-testid="team-chips">
      {teams.slice(0, 6).map((team) => {
        const active = teamFilter?.unitId === team.id;
        return (
          <button
            key={team.id}
            data-testid={`team-chip-${team.id}`}
            onClick={() => toggle(team)}
            title={`${team.name} — komuta merkezini bu takıma filtrele`}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
              active
                ? "border-dept-engineering bg-dept-engineering/15 text-acos-fg0"
                : "border-acos-line bg-acos-bg2 text-acos-fg1 hover:border-acos-fg2",
            )}
          >
            <span className="max-w-28 truncate">{team.name}</span>
            <span
              className={cn(
                "rounded-full px-1.5 text-[9px] tabular-nums",
                active ? "bg-dept-engineering text-acos-bg0" : "bg-acos-bg3",
              )}
            >
              {headcount(team.id)}
            </span>
          </button>
        );
      })}
      {teams.length > 6 && <span className="text-[10px] text-acos-fg2">+{teams.length - 6}</span>}
      {teamFilter && (
        <button
          data-testid="team-filter-clear"
          onClick={() => setTeamFilter(null)}
          className="shrink-0 text-[10px] text-acos-fg2 hover:text-acos-fg0"
          title="takım filtresini kaldır"
        >
          ✕ filtre
        </button>
      )}
      <button
        onClick={() => setManageOpen(true)}
        className="shrink-0 text-[11px] text-acos-fg2 hover:text-acos-fg1"
        title="Takımları yönet — oluştur (tekli/toplu) ve arşivle"
        data-testid="team-manage-open"
      >
        + Takım
      </button>
      {manageOpen && <TeamManageModal companyId={companyId} onClose={() => setManageOpen(false)} />}
    </div>
  );
}

export function AppShell() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const navigate = useNavigate();
  const companies = useQuery({ queryKey: keys.companies, queryFn: api.companies.list });
  const me = useQuery({ queryKey: keys.me, queryFn: api.auth.me });
  const pendingApprovals = useQuery({
    queryKey: keys.approvals(companyId, "pending"),
    queryFn: () => api.approvals.list(companyId, { status: "pending" }),
  });
  const wsStatus = useRealtimeStatus();
  const lastEvent = useEventTicker((s) => s.events[0]);
  const requestPreset = useUiPrefs((s) => s.requestPreset);
  const [hireOpen, setHireOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const unread = useNotifications((s) => s.unread);
  const recentNotifications = useNotifications((s) => s.recent);
  const markAllRead = useNotifications((s) => s.markAllRead);
  // today's llm_calls aggregate (U11) — 30s poll; T29 cached-token accounting
  const usage = useQuery({
    queryKey: [companyId, "costs", "llm-usage"],
    queryFn: () => api.costs.llmUsage(companyId),
    refetchInterval: 30_000,
  });
  const forecast = useQuery({
    queryKey: [companyId, "costs", "forecast"],
    queryFn: () => api.costs.forecast(companyId),
    refetchInterval: 60_000,
  });
  const cacheHit = usage.data
    ? Math.round(
        (usage.data.tokensCached / Math.max(1, usage.data.tokensIn + usage.data.tokensCached)) *
          100,
      )
    : null;
  const companyBudget =
    forecast.data?.items.find((b) => b.scopeKind === "company") ?? forecast.data?.items[0] ?? null;
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // The Command Center owns the full dark canvas; legacy routes render on a
  // light island until U05–U09 restyle them.
  const onCommandCenter = pathname.replace(/\/$/, "") === `/c/${companyId}`;

  const approvalsCount = pendingApprovals.data?.length ?? 0;

  // U14c: light presence summary → Electron tray icon (no-op in a browser)
  const presenceBadges = usePresence((s) => s.badges);
  useEffect(() => {
    if (!window.acosDesktop) return;
    const active = Object.values(presenceBadges).some(
      (badge) => badge !== "IDLE" && badge !== "OFFLINE",
    );
    const state = approvalsCount > 0 ? "needs-approval" : active ? "active" : "idle";
    window.acosDesktop.setPresence(state, companyId);
  }, [approvalsCount, presenceBadges, companyId]);

  function applyPreset(preset: CommandPreset) {
    requestPreset(preset);
    void navigate({ to: "/c/$companyId", params: { companyId } });
  }

  return (
    <div className="grid h-screen grid-rows-[38px_40px_minmax(0,1fr)_24px] bg-acos-bg0 font-sans text-[13px] text-acos-fg0">
      <header className="flex items-center gap-2.5 overflow-hidden border-b border-acos-line bg-acos-bg1 px-3 text-xs">
        <span className="font-bold">
          A<b style={{ color: "#2ec26a" }}>C</b>OS
        </span>
        <select
          aria-label="Şirket"
          value={companyId}
          onChange={(e) =>
            void navigate({ to: "/c/$companyId", params: { companyId: e.target.value } })
          }
          className="max-w-36 rounded-md border border-acos-line bg-acos-bg2 px-1.5 py-0.5 text-[11px] text-acos-fg0 focus:outline-none"
        >
          {companies.data?.map((company) => (
            <option key={company.id} value={company.id}>
              {company.name}
            </option>
          ))}
        </select>
        <TeamChips companyId={companyId} />
        <div className="flex-1" />
        {/* Layout presets (36 §3): saved Command Center arrangements. */}
        <span className="hidden items-center gap-1 xl:flex" data-testid="layout-presets">
          {PRESETS.map((preset) => (
            <button
              key={preset.key}
              onClick={() => applyPreset(preset.key)}
              className="rounded border border-acos-line bg-acos-bg2 px-1.5 py-0.5 text-[10px] text-acos-fg1 hover:border-acos-fg2 hover:text-acos-fg0"
              title={`${preset.label} yerleşimini uygula`}
            >
              {preset.label}
            </button>
          ))}
        </span>
        <GlobalSearch companyId={companyId} />
        {/* Today's tokens + cache hit from llm_calls (36 §9 — U11). */}
        <span
          className="hidden shrink-0 rounded-md border border-acos-line bg-acos-bg2 px-2 py-0.5 font-mono text-[10.5px] tabular-nums text-acos-fg1 lg:inline"
          data-testid="token-pill"
          title={
            usage.data
              ? `bugün ${usage.data.calls} çağrı · in ${formatTokens(usage.data.tokensIn)} · out ${formatTokens(usage.data.tokensOut)} · cache ${formatTokens(usage.data.tokensCached)}`
              : "llm_calls agregasyonu yükleniyor"
          }
        >
          ⚡ bugün{" "}
          <b style={{ color: "#2ec26a" }}>
            {usage.data ? formatTokens(usage.data.tokensOut) : "—"}
          </b>{" "}
          jeton · %{cacheHit ?? "—"} önbellek
        </span>
        <button
          data-testid="topbar-hire"
          onClick={() => setHireOpen(true)}
          className="shrink-0 rounded-md px-2.5 py-1 text-[11px] font-semibold text-white"
          style={{ background: departmentColors.product }}
        >
          + Ajan Ekle
        </button>
        <Link
          to="/c/$companyId/approvals"
          params={{ companyId }}
          aria-label="Bekleyen onaylar"
          className="relative px-1 text-acos-fg1 hover:text-acos-fg0"
          data-testid="approvals-badge"
        >
          ✓
          {approvalsCount > 0 && (
            <span
              className="absolute -right-1.5 -top-1.5 rounded-full px-1 text-[8px] font-bold text-white"
              style={{ background: "#ff4d4d" }}
            >
              {approvalsCount}
            </span>
          )}
        </Link>
        <span className="relative">
          <button
            data-testid="bell"
            onClick={() => {
              setBellOpen((v) => !v);
              markAllRead();
            }}
            className="relative px-1 text-acos-fg1 hover:text-acos-fg0"
            aria-label="Bildirimler"
          >
            <BellIcon size={16} />
            {unread > 0 && (
              <span
                data-testid="bell-badge"
                className="absolute -right-1.5 -top-1.5 rounded-full px-1 text-[8px] font-bold text-white"
                style={{ background: "#ff4d4d" }}
              >
                {unread}
              </span>
            )}
          </button>
          {bellOpen && (
            <div
              className="absolute right-0 top-7 z-50 max-h-72 w-64 overflow-auto rounded-md border border-acos-line bg-acos-bg2 py-1 shadow-lg"
              data-testid="bell-dropdown"
            >
              {recentNotifications.length === 0 && (
                <div className="px-2.5 py-2 text-[10px] text-acos-fg2">Bildirim yok.</div>
              )}
              {recentNotifications.slice(0, 10).map((n) => (
                <div key={n.id} className="border-b border-acos-line/40 px-2.5 py-1.5">
                  <div className="text-[10px] font-semibold text-acos-fg0">{n.title}</div>
                  <div className="truncate text-[9px] text-acos-fg2">{n.desc}</div>
                </div>
              ))}
            </div>
          )}
        </span>
        <span className="px-1 text-acos-fg2" title="Ayarlar (daha sonra)">
          <SettingsIcon size={15} />
        </span>
        {/* Single-user mode: no logout — the Founder identity is ambient. */}
        <span className="text-acos-fg1" data-testid="me-name">
          {me.data?.displayName} ▾
        </span>
      </header>

      {/* Tek sayfa hissi (36 §2 UI overhaul): sol icon-rail yerine üstte
          yatay sekme çubuğu — tüm 16 görünüm burada, tek satırda kaydırılabilir. */}
      <nav
        className="flex min-w-0 items-stretch gap-0.5 overflow-x-auto border-b border-acos-line bg-acos-bg1 px-2"
        aria-label="Ana gezinme"
      >
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return item.path ? (
            <Link
              key={item.id}
              to={item.path as "/c/$companyId/agents"}
              params={{ companyId }}
              activeOptions={{ exact: item.path === "/c/$companyId" }}
              aria-label={item.label}
              title={item.label}
              data-testid={`nav-${item.id}`}
              className={cn(
                "group relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-[11.5px] font-medium",
                "text-acos-fg1 transition-colors duration-150 hover:text-acos-fg0",
                "[&.active]:text-acos-fg0",
              )}
            >
              <Icon
                size={16}
                className="shrink-0 text-acos-fg2 transition-colors duration-150 group-hover:text-acos-fg1 [.active_&]:text-dept-engineering"
              />
              <span>{item.label}</span>
              {/* alt çizgi vurgusu: aktifte belirgin, hover'da soluk */}
              <span
                className={cn(
                  "pointer-events-none absolute inset-x-2 bottom-0 h-[2px] scale-x-0 rounded-full bg-dept-engineering",
                  "transition-transform duration-150 group-hover:scale-x-50",
                  "[.active_&]:scale-x-100",
                )}
              />
            </Link>
          ) : (
            <span
              key={item.id}
              aria-label={item.label}
              title={`${item.label} — daha sonraki bir görevle gelir`}
              data-testid={`nav-${item.id}`}
              className="flex shrink-0 cursor-not-allowed items-center gap-1.5 whitespace-nowrap px-3 text-[11.5px] font-medium text-acos-fg2/50"
            >
              <Icon size={16} className="shrink-0" />
              <span>{item.label}</span>
            </span>
          );
        })}
      </nav>

      {/* P0-B: no more light island — every route renders on the dark canvas */}
      <main className={cn("min-w-0 overflow-auto", onCommandCenter ? "" : "p-4")}>
        <div className={onCommandCenter ? "h-full" : "min-h-full"}>
          <Outlet />
        </div>
      </main>

      <RealtimeDispatcher companyId={companyId} />
      <footer
        className="flex items-center gap-3 border-t border-acos-line bg-acos-bg1 px-3 text-[10.5px] text-acos-fg1"
        data-testid="status-bar"
      >
        <span
          className={cn(
            "font-medium",
            wsStatus === "open"
              ? "text-presence-communicating"
              : wsStatus === "closed_auth"
                ? "text-presence-escalating"
                : "",
          )}
        >
          ● ws: {wsStatus}
        </span>
        {lastEvent && (
          <span className="truncate font-mono tabular-nums" data-testid="ticker-last">
            #{lastEvent.seq} {lastEvent.type}
          </span>
        )}
        <div className="flex-1" />
        {/* Cost burn strip (36 §3/§9): today's spend vs the company budget. */}
        {companyBudget && (
          <span className="flex items-center gap-1.5" data-testid="cost-strip">
            <span className="font-mono tabular-nums">
              $ <b className="text-acos-fg0">{(companyBudget.spentCents / 100).toFixed(2)}</b>/
              {(companyBudget.limitCents / 100).toFixed(0)}
            </span>
            <span className="h-[5px] w-20 overflow-hidden rounded-full bg-acos-bg3">
              <span
                className="block h-full"
                style={{
                  width: `${Math.min(100, (companyBudget.spentCents / Math.max(1, companyBudget.limitCents)) * 100)}%`,
                  background: companyBudget.breach
                    ? "#ff4d4d"
                    : "linear-gradient(90deg,#3fd0a0,#ffcb47)",
                }}
              />
            </span>
            <span
              className="rounded border border-acos-line px-1 text-[8.5px]"
              style={{ color: companyBudget.breach ? "#ff4d4d" : "#3fd0a0" }}
            >
              {companyBudget.breach ? "aşım riski" : "yolunda"}
            </span>
          </span>
        )}
      </footer>
      <Toasts />

      <HireModal open={hireOpen} onClose={() => setHireOpen(false)} />
    </div>
  );
}
