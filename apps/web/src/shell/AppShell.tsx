// Command-center shell (24 §1, 36 §3 — U02; E1 tek ekran).
//
// E1 (Founder isteği, 2026-08-20): üst NAV SEKME SATIRI KALDIRILDI. Tek varış
// noktası CommandCenter; "bir görünüme gitmek" artık o panelin dockview'da
// açılması demek (panelBus). 16 rota tek ekrana katlandı (router.tsx), nav-*
// test kimlikleri panel açıcının içine TAŞINDI — silinmedi.
//
// Üst çubuk (tek satır) = marka · şirket seçici · panel açıcı · ORTADA proje
// bazlı takımlar · yerleşim önayarları · arama · jeton pill · + Ajan Ekle ·
// onay/bildirim rozetleri · Founder kimliği (tıkla → CEO'ya görev ver).
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
  UserIcon,
  ChevronDownIcon,
} from "@acos/ui";
import { api, keys } from "../lib/api.js";
import { useEventTicker } from "../stores/eventTicker.js";
import { usePresence } from "../stores/presence.js";
import { useUiPrefs, type CommandPreset } from "../stores/uiPrefs.js";
import { useFocus } from "../stores/focus.js";
import { RealtimeDispatcher, useRealtimeStatus } from "../realtime/RealtimeDispatcher.js";
import { HireModal } from "../features/agents/HireModal.js";
import { CreateCompanyModal } from "../features/companies/CreateCompanyModal.js";
import { TeamManageModal } from "../features/organization/TeamManageModal.js";
import { useNotifications } from "../stores/notifications.js";
import { usePanelBus } from "../stores/panels.js";
import { DirectiveDialog } from "../features/office/DirectiveDialog.js";
import { useProjectTeams } from "../features/organization/useProjectTeams.js";
import { ProjectWizard } from "../features/projects/ProjectWizard.js";
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

// E1: her görünüm artık bir PANEL. id = kararlı test anahtarı
// (data-testid={`nav-${id}`}) — e2e seçicileri korunsun diye adlar aynı
// bırakıldı, yalnız yerleri değişti: sekme satırı yerine panel açıcı menüsü.
// panelId = CommandCenter'daki dockview paneli (null = zaten tek ekran).
const PANEL_ITEMS: Array<{
  id: string;
  label: string;
  icon: ComponentType<IconProps>;
  panelId: string | null;
}> = [
  { id: "command", label: "Komuta", icon: CommandIcon, panelId: null },
  { id: "dashboard", label: "Dashboard", icon: DashboardIcon, panelId: "dashboard" },
  { id: "office", label: "Ofis", icon: OfficeIcon, panelId: "office" },
  { id: "tasks", label: "Görevler", icon: TasksIcon, panelId: "tasks" },
  { id: "agents", label: "Ajanlar", icon: AgentsIcon, panelId: "agents" },
  { id: "projects", label: "Projeler", icon: ProjectsIcon, panelId: "projects" },
  { id: "memory", label: "Hafıza", icon: MemoryIcon, panelId: "memory" },
  { id: "organization", label: "Organizasyon", icon: OrganizationIcon, panelId: "organization" },
  { id: "skills", label: "Yetenekler", icon: SkillsIcon, panelId: "skills" },
  { id: "communication", label: "İletişim", icon: CommunicationIcon, panelId: "communication" },
  { id: "terminals", label: "Terminaller", icon: TerminalsIcon, panelId: "terminals" },
  { id: "approvals", label: "Onaylar", icon: ApprovalsIcon, panelId: "approvals" },
  { id: "events", label: "Olaylar", icon: EventsIcon, panelId: "events" },
  { id: "reports", label: "Raporlar", icon: ReportsIcon, panelId: "reports" },
  { id: "costs", label: "Maliyetler", icon: CostsIcon, panelId: "costs" },
  { id: "settings", label: "Ayarlar", icon: SettingsIcon, panelId: "settings" },
];

/** Panel açıcı: sekme satırının yerini alan tek düğme + açılır liste. */
function PanelLauncher() {
  const [open, setOpen] = useState(false);
  const openPanel = usePanelBus((s2) => s2.openPanel);
  return (
    <span className="relative shrink-0">
      <button
        data-testid="panel-launcher"
        aria-label="Panel aç"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 rounded-md border border-acos-line bg-acos-bg2 px-2 py-0.5 text-[11px] text-acos-fg1 hover:border-acos-fg2 hover:text-acos-fg0"
        title="Görünümler — hepsi bu ekranda panel olarak açılır"
      >
        <CommandIcon size={14} />
        <span className="hidden sm:inline">Paneller</span>
        <ChevronDownIcon size={12} />
      </button>
      {open && (
        <>
          {/* dışarı tıklayınca kapansın */}
          <span className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div
            className="absolute left-0 top-7 z-50 grid w-64 grid-cols-2 gap-0.5 rounded-md border border-acos-line bg-acos-bg2 p-1 shadow-lg"
            data-testid="panel-launcher-menu"
          >
            {PANEL_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  data-testid={`nav-${item.id}`}
                  aria-label={item.label}
                  title={item.panelId ? `${item.label} panelini aç` : "Komuta merkezi"}
                  onClick={() => {
                    if (item.panelId) openPanel(item.panelId);
                    setOpen(false);
                  }}
                  className="flex items-center gap-1.5 rounded px-2 py-1 text-left text-[11px] text-acos-fg1 hover:bg-acos-bg3 hover:text-acos-fg0"
                >
                  <Icon size={14} className="shrink-0 text-acos-fg2" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </span>
  );
}

function GlobalSearch({ companyId }: { companyId: string }) {
  const [q, setQ] = useState("");
  const setSelectedAgent = useFocus((s2) => s2.setSelectedAgent);
  const openPanel = usePanelBus((s2) => s2.openPanel);
  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
  });
  const hits = q.trim()
    ? (agents.data ?? []).filter((a) => a.name.toLowerCase().includes(q.trim().toLowerCase()))
    : [];

  // E1: ayrı ajan sayfası yok — bulunan ajan ODAĞA alınır (paneller ona göre
  // vurgular/filtreler) ve Ajanlar paneli öne gelir. Tek ekran korunur.
  function open(agentId: string) {
    setQ("");
    setSelectedAgent(agentId);
    openPanel("agents");
  }

  return (
    <div className="relative hidden md:block">
      <input
        data-testid="global-search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) open(hits[0].id);
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
                onMouseDown={() => open(agent.id)}
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

/**
 * E2/W7 — ÜST-ORTA ARTIK PROJELER (2026-08-20, Founder kararı).
 *
 * E1'de burada düz bir "proje başlıklı takım şeridi" vardı; şirket büyüyünce
 * okunmaz oluyordu ve "hangi projedeyim" sorusunun cevabı ekranda yoktu.
 * Artık merkez bir PROJE SEÇİCİ (şirket seçicinin birebir deseni) ve seçili
 * projenin takımları onun ALTINDA/yanında. Seçim useFocus.selectedProjectId'e
 * yazılır — ofis odağı (W8) ve paneller aynı mercekten bakar.
 *
 * Proje→takım bağı hâlâ İŞTEN türetiliyor (useProjectTeams: tasks.projectId ×
 * tasks.orgUnitId). Oscar'ın T17 kalıcı bağı indiğinde yalnız o hook'un
 * kaynağı değişecek; bu bileşen aynı kalır.
 */
function ProjectBar({ companyId }: { companyId: string }) {
  const [manageOpen, setManageOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const { groups, idleTeams, linked } = useProjectTeams(companyId);
  const projects = useQuery({
    queryKey: [companyId, "projects", "list"],
    queryFn: () => api.projects.list(companyId),
  });
  const edges = useQuery({
    queryKey: keys.orgEdges(companyId),
    queryFn: () => api.org.listEdges(companyId),
  });
  const teamFilter = useFocus((s2) => s2.teamFilter);
  const setTeamFilter = useFocus((s2) => s2.setTeamFilter);
  const selectedProjectId = useFocus((s2) => s2.selectedProjectId);
  const setSelectedProject = useFocus((s2) => s2.setSelectedProject);

  const headcount = (unitId: string) =>
    (edges.data ?? []).filter(
      (e) => e.kind === "member_of" && e.toUnitId === unitId && e.endedAt === null,
    ).length;

  const projectItems = projects.data?.items ?? [];
  const selectedGroup = groups.find((g) => g.projectId === selectedProjectId) ?? null;
  // "Tüm şirket" seçiliyken eski davranış: her projenin takımları arka arkaya
  const teams = selectedProjectId
    ? (selectedGroup?.teams ?? [])
    : [...new Map(groups.flatMap((g) => g.teams).map((t) => [t.id, t])).values()];
  const counts = selectedProjectId
    ? (selectedGroup?.taskCountByUnit ?? {})
    : Object.fromEntries(groups.flatMap((g) => Object.entries(g.taskCountByUnit)));
  // kalıcı bağ ucu takım başına ajan sayısını da veriyor (sözleşme §1);
  // uç yokken org kenarlarından sayılır
  const agentCounts = selectedProjectId
    ? (selectedGroup?.agentCountByUnit ?? {})
    : Object.fromEntries(groups.flatMap((g) => Object.entries(g.agentCountByUnit)));

  const chip = (team: { id: string; name: string }, openTasks: number | undefined) => {
    const active = teamFilter?.unitId === team.id;
    const members = agentCounts[team.id] ?? headcount(team.id);
    return (
      <button
        key={team.id}
        data-testid={`team-chip-${team.id}`}
        onClick={() =>
          setTeamFilter(active ? null : { unitId: team.id, name: team.name })
        }
        title={`${team.name} — ${members} üye${
          openTasks ? ` · ${openTasks} açık iş` : ""
        } · komuta merkezini bu takıma filtrele`}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px]",
          active
            ? "border-dept-engineering bg-dept-engineering/15 text-acos-fg0"
            : "border-acos-line bg-acos-bg2 text-acos-fg1 hover:border-acos-fg2",
        )}
      >
        <span className="max-w-24 truncate">{team.name}</span>
        <span
          className={cn(
            "rounded-full px-1.5 text-[9px] tabular-nums",
            active ? "bg-dept-engineering text-acos-bg0" : "bg-acos-bg3",
          )}
        >
          {members}
        </span>
      </button>
    );
  };

  return (
    <div
      className="hidden min-w-0 items-center justify-center gap-2.5 overflow-x-auto lg:flex"
      data-testid="project-bar"
    >
      {/* proje seçici — şirket seçicinin aynı deseni, bir seviye aşağıda */}
      <span
        className="flex shrink-0 items-center gap-1 rounded-md border border-acos-line bg-acos-bg2 pl-2"
        data-testid="project-switcher"
      >
        <span className="text-[9.5px] uppercase tracking-wide text-acos-fg2">proje</span>
        <select
          aria-label="Proje"
          value={selectedProjectId ?? ""}
          onChange={(e) => setSelectedProject(e.target.value || null)}
          className="max-w-44 rounded-md border-0 bg-acos-bg2 px-1 py-0.5 text-[11.5px] font-semibold text-acos-fg0 focus:outline-none"
        >
          <option value="">Tüm şirket</option>
          {projectItems.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <button
          onClick={() => setWizardOpen(true)}
          data-testid="project-create-open"
          aria-label="Yeni proje ekle"
          title="Yeni proje — CEO kadroyu önersin, siz onaylayın"
          className="border-l border-acos-line px-1.5 py-0.5 text-[13px] leading-none text-acos-fg2 hover:text-acos-fg0"
        >
          +
        </button>
      </span>

      {/* seçili projenin TAKIMLARI (bağ işten türetilir) */}
      <div className="flex min-w-0 items-center gap-1.5" data-testid="team-chips">
        {teams.length > 0 ? (
          <>
            <span className="shrink-0 text-[9.5px] text-acos-fg2">takımlar:</span>
            {/* sözleşme §1: bir projenin KALICI bağı yoksa liste işten
                türetilmiştir — kullanıcı "bu daha bağlanmadı" görsün */}
            {linked && selectedGroup?.source === "derived" && (
              <span
                className="shrink-0 rounded border border-acos-line px-1 text-[8.5px] text-acos-fg2"
                title="Bu takımlar projeye kalıcı olarak bağlanmadı — işten (görevlerden) türetildi"
                data-testid="project-teams-derived"
              >
                türetilmiş
              </span>
            )}
            {teams.slice(0, 5).map((team) => chip(team, counts[team.id]))}
            {teams.length > 5 && (
              <span className="shrink-0 text-[9.5px] text-acos-fg2">+{teams.length - 5}</span>
            )}
          </>
        ) : (
          <span className="shrink-0 text-[10px] text-acos-fg2" data-testid="project-teams-empty">
            {selectedProjectId
              ? "bu projede henüz takım yok — kadro kurulunca burada görünür"
              : idleTeams.length > 0
                ? `iş bekleyen ${idleTeams.length} takım`
                : "takım yok"}
          </span>
        )}
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
      </div>

      {manageOpen && <TeamManageModal companyId={companyId} onClose={() => setManageOpen(false)} />}
      <ProjectWizard
        companyId={companyId}
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
      />
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
  const [createCompanyOpen, setCreateCompanyOpen] = useState(false);
  // E1: Founder direktifi üst çubuktan verilir; hedef her zaman şirketin
  // tepe yöneticisidir (sunucu ProjectsService.topExecutive ile bulur).
  const [directiveOpen, setDirectiveOpen] = useState(false);
  const executiveQuery = useQuery({
    queryKey: [companyId, "org", "top-executive"],
    queryFn: () => api.tasks.topExecutive(companyId),
    retry: false, // ajansız şirkette 404 normaldir
  });
  const executive = executiveQuery.data ?? null;
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
    <div className="grid h-screen grid-rows-[38px_minmax(0,1fr)_24px] bg-acos-bg0 font-sans text-[13px] text-acos-fg0">
      {/* E1: üç sütunlu üst çubuk — sol küme · ORTADA takım şeridi · sağ küme.
          (İlk sürüm şeridi mutlak konumla ortalıyordu; geniş ekranda arama
          kutusunun ÜSTÜNE biniyordu — canlı kurulumda görüldü.) */}
      <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 overflow-hidden border-b border-acos-line bg-acos-bg1 px-3 text-xs">
        <div className="flex min-w-0 items-center gap-2.5">
        <span className="font-bold">
          A<b style={{ color: "#2ec26a" }}>C</b>OS
        </span>
        {/* E1 §3: şirket satırı KALIR — seçici artık etiketli, aktif şirket
            adı okunur bir "chip" gibi görünür ve tek tıkla değiştirilir. */}
        <span
          className="flex shrink-0 items-center gap-1 rounded-md border border-acos-line bg-acos-bg2 pl-2"
          data-testid="company-switcher"
        >
          <span className="text-[9.5px] uppercase tracking-wide text-acos-fg2">şirket</span>
          <select
            aria-label="Şirket"
            value={companyId}
            onChange={(e) =>
              void navigate({ to: "/c/$companyId", params: { companyId: e.target.value } })
            }
            className="max-w-40 rounded-md border-0 bg-acos-bg2 px-1 py-0.5 text-[11.5px] font-semibold text-acos-fg0 focus:outline-none"
          >
            {companies.data?.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </select>
          {/* E2/W2: "yeni sirket acacak ekran yok" (Founder, 2026-08-20).
              Sunucu ucu zaten vardi; eksik olan giristi. Secicinin icinde
              duruyor cunku kullanicinin sirket dusundugu tek yer burasi. */}
          <button
            onClick={() => setCreateCompanyOpen(true)}
            data-testid="company-create-open"
            aria-label="Yeni şirket aç"
            title="Yeni şirket aç — kendi ajanları, projeleri ve bütçesiyle"
            className="border-l border-acos-line px-1.5 py-0.5 text-[13px] leading-none text-acos-fg2 hover:text-acos-fg0"
          >
            +
          </button>
        </span>
        <PanelLauncher />
        </div>
        {/* orta sütun: takım şeridi (dar ekranda gizlenir) */}
        <ProjectBar companyId={companyId} />
        <div className="flex min-w-0 items-center justify-end gap-2.5">
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
        {/* E1 §5+§7 — EN KRİTİK UX: Founder kimliği artık bir DÜĞME. Tıkla →
            CEO'ya serbest metin görev ver (POST /directives) → çalışma
            döngüsü başlar. Kullanıcı ilk işini buradan veriyor; ekranda
            başka "işi nereden veriyorum" sorusu kalmıyor. CEO yoksa düğme
            pasif ve nedenini söylüyor (önce bir tepe yönetici işe alın). */}
        <button
          data-testid="me-name"
          onClick={() => setDirectiveOpen(true)}
          disabled={!executive}
          aria-label={
            executive ? `${executive.name} adlı yöneticiye görev ver` : "Görev vermek için CEO gerekli"
          }
          title={
            executive
              ? `${executive.name} (${executive.positionTitle}) — tıkla, görevi ver`
              : "Şirketin tepe yöneticisi yok — önce + Ajan Ekle ile bir CEO işe alın"
          }
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px]",
            executive
              ? "border-acos-line bg-acos-bg2 text-acos-fg1 hover:border-dept-engineering hover:text-acos-fg0"
              : "cursor-not-allowed border-acos-line/60 text-acos-fg2",
          )}
        >
          <UserIcon size={14} />
          <span className="max-w-28 truncate">{me.data?.displayName}</span>
        </button>
        </div>
      </header>

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
      <CreateCompanyModal open={createCompanyOpen} onClose={() => setCreateCompanyOpen(false)} />
      {executive && (
        <DirectiveDialog
          companyId={companyId}
          executive={executive}
          open={directiveOpen}
          onClose={() => setDirectiveOpen(false)}
        />
      )}
    </div>
  );
}
