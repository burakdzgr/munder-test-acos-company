// CommandCenter (36 §3 — U03): dockview-based default landing at
// /c/$companyId. Mirrors the acos-final mockup's three columns — left
// Hafıza/Skiller/Tarayıcı, center Terminal/Raporlar/Görevler, right
// Ofis/Kod over Çalışanlar/Takım/Konuşma — with draggable splitters,
// three presets (Operations/Engineering/Overview) and the layout persisted
// per user in uiPrefsStore. Panels host the existing views on a light
// island until U05–U09 restyle them; Kod/Tarayıcı are labelled placeholders.
import { useEffect, useRef, useState, type FunctionComponent, type ReactNode } from "react";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { useUiPrefs, type CommandPreset } from "../stores/uiPrefs.js";
import { GoalsPanel } from "./GoalsPanel.js";
import { MemoryPanel } from "../features/memory/MemoryPanel.js";
import { SkillsPanel } from "../features/skills/SkillsPanel.js";
import { TerminalGrid } from "../features/terminals/TerminalGrid.js";
import { ReportsPanel } from "../features/costs/ReportsPanel.js";
import { CostsView } from "../features/costs/CostsView.js";
import { TaskBoardPanel } from "../features/tasks/TaskBoardPanel.js";
import { OfficePanel } from "../features/office/OfficePanel.js";
import { CodePanel } from "../features/code/CodePanel.js";
import { RosterPanel } from "../features/agents/RosterPanel.js";
import { TeamPanel } from "../features/organization/TeamPanel.js";
import { ChatPanel } from "../features/comms/ChatPanel.js";
import { ApprovalsView } from "../features/approvals/ApprovalsView.js";
import { EventsView } from "../features/events/EventsView.js";
import { ProjectsView } from "../features/projects/ProjectsView.js";
// E1 (tek ekran): eskiden yalnız rota olan görünümler de panel oldu — nav
// sekme satırı kalktığı için tek varış noktası burası.
import { OrganizationView } from "../features/organization/OrganizationView.js";
import { AgentsView } from "../features/agents/AgentsView.js";
import { CommunicationView } from "../features/comms/CommunicationView.js";
import { DashboardView } from "../features/dashboard/DashboardView.js";
import { SettingsView } from "../features/settings/SettingsView.js";
import { usePanelBus } from "../stores/panels.js";

// Lazy panel: content mounts only while the panel is the visible tab of its
// group. Hidden tabs therefore never warm the Query cache with data that can
// go stale before the user looks at them (they refetch on activation), and
// heavy views (PixiJS office, xterm, cytoscape) don't all run at once.
function lazyPanel(
  render: () => ReactNode,
  chrome: "light" | "dark" = "light",
): FunctionComponent<IDockviewPanelProps> {
  return function LazyPanel({ api }: IDockviewPanelProps) {
    const [visible, setVisible] = useState(api.isVisible);
    useEffect(() => {
      const disposable = api.onDidVisibilityChange((e) => setVisible(e.isVisible));
      return () => disposable.dispose();
    }, [api]);
    if (!visible) return null;
    if (chrome === "dark") return <div className="h-full min-h-0">{render()}</div>;
    // routed views (dark since P0-B) hosted as a scrollable panel body
    return <div className="h-full overflow-auto bg-acos-bg0 p-3">{render()}</div>;
  };
}

function Placeholder({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-acos-bg1 text-center">
      <div>
        <div className="text-[12px] font-semibold text-acos-fg1">{title}</div>
        <div className="mt-1 text-[10.5px] text-acos-fg2">{note}</div>
      </div>
    </div>
  );
}

// Panel registry: id == component key; every view stays reachable as a panel (N6).
const components: Record<string, FunctionComponent<IDockviewPanelProps>> = {
  memory: lazyPanel(() => <MemoryPanel />, "dark"),
  skills: lazyPanel(() => <SkillsPanel />, "dark"),
  browser: () => <Placeholder title="Tarayıcı" note="Faz 2 — tarayıcı sandbox'ı MVP'de yok" />,
  terminals: lazyPanel(() => <TerminalGrid />, "dark"),
  reports: lazyPanel(() => <ReportsPanel />, "dark"),
  tasks: lazyPanel(() => <TaskBoardPanel />, "dark"),
  office: lazyPanel(() => <OfficePanel />, "dark"),
  code: lazyPanel(() => <CodePanel />, "dark"),
  employees: lazyPanel(() => <RosterPanel />, "dark"),
  team: lazyPanel(() => <TeamPanel />, "dark"),
  chat: lazyPanel(() => <ChatPanel />, "dark"),
  approvals: lazyPanel(() => <ApprovalsView />),
  costs: lazyPanel(() => <CostsView />),
  events: lazyPanel(() => <EventsView />),
  projects: lazyPanel(() => <ProjectsView />),
  organization: lazyPanel(() => <OrganizationView />),
  agents: lazyPanel(() => <AgentsView />),
  communication: lazyPanel(() => <CommunicationView />, "dark"),
  dashboard: lazyPanel(() => <DashboardView />),
  settings: lazyPanel(() => <SettingsView />),
};

type PanelSpec = { id: string; title: string };
const P: Record<string, PanelSpec> = {
  memory: { id: "memory", title: "Hafıza" },
  skills: { id: "skills", title: "Skiller" },
  browser: { id: "browser", title: "Tarayıcı P2" },
  terminals: { id: "terminals", title: "Terminal" },
  reports: { id: "reports", title: "Raporlar" },
  tasks: { id: "tasks", title: "Görevler" },
  office: { id: "office", title: "Ofis" },
  code: { id: "code", title: "Kod" },
  employees: { id: "employees", title: "Çalışanlar" },
  team: { id: "team", title: "Takım" },
  chat: { id: "chat", title: "Konuşma" },
  approvals: { id: "approvals", title: "Onaylar" },
  costs: { id: "costs", title: "Maliyet" },
  events: { id: "events", title: "Olaylar" },
  projects: { id: "projects", title: "Projeler" },
  organization: { id: "organization", title: "Organizasyon" },
  agents: { id: "agents", title: "Ajanlar" },
  communication: { id: "communication", title: "İletişim" },
  dashboard: { id: "dashboard", title: "Dashboard" },
  settings: { id: "settings", title: "Ayarlar" },
};

function add(
  api: DockviewApi,
  spec: PanelSpec,
  position?: { referencePanel: string; direction: "within" | "right" | "below" | "left" | "above" },
) {
  return api.addPanel({
    id: spec.id,
    component: spec.id,
    title: spec.title,
    ...(position ? { position } : {}),
  });
}

/** Mockup default: 3 columns, tabbed groups, right column split top/bottom. */
function buildDefault(api: DockviewApi) {
  api.clear();
  add(api, P.memory!);
  add(api, P.skills!, { referencePanel: "memory", direction: "within" });
  add(api, P.browser!, { referencePanel: "memory", direction: "within" });
  add(api, P.terminals!, { referencePanel: "memory", direction: "right" });
  add(api, P.reports!, { referencePanel: "terminals", direction: "within" });
  add(api, P.tasks!, { referencePanel: "terminals", direction: "within" });
  add(api, P.office!, { referencePanel: "terminals", direction: "right" });
  add(api, P.code!, { referencePanel: "office", direction: "within" });
  add(api, P.employees!, { referencePanel: "office", direction: "below" });
  add(api, P.team!, { referencePanel: "employees", direction: "within" });
  add(api, P.chat!, { referencePanel: "employees", direction: "within" });
  for (const id of ["memory", "terminals", "office", "employees"]) {
    api.getPanel(id)?.api.setActive();
  }
  api.getPanel("memory")?.api.setSize({ width: 260 });
  api.getPanel("office")?.api.setSize({ width: 420 });
  api.getPanel("employees")?.api.setSize({ height: 240 });
}

/** Operations: office-centric — the floorplan gets half the screen. */
function buildOperations(api: DockviewApi) {
  buildDefault(api);
  api.getPanel("memory")?.api.setSize({ width: 220 });
  api.getPanel("office")?.api.setSize({ width: Math.max(480, Math.round(api.width * 0.5)) });
  api.getPanel("employees")?.api.setSize({ height: Math.round(api.height * 0.3) });
}

/** Engineering: terminals + tasks big — tasks get their own row under terminals. */
function buildEngineering(api: DockviewApi) {
  api.clear();
  add(api, P.memory!);
  add(api, P.skills!, { referencePanel: "memory", direction: "within" });
  add(api, P.terminals!, { referencePanel: "memory", direction: "right" });
  add(api, P.reports!, { referencePanel: "terminals", direction: "within" });
  add(api, P.tasks!, { referencePanel: "terminals", direction: "below" });
  add(api, P.office!, { referencePanel: "terminals", direction: "right" });
  add(api, P.code!, { referencePanel: "office", direction: "within" });
  add(api, P.employees!, { referencePanel: "office", direction: "below" });
  add(api, P.chat!, { referencePanel: "employees", direction: "within" });
  for (const id of ["memory", "terminals", "tasks", "office", "employees"]) {
    api.getPanel(id)?.api.setActive();
  }
  api.getPanel("memory")?.api.setSize({ width: 200 });
  api.getPanel("office")?.api.setSize({ width: 300 });
  api.getPanel("employees")?.api.setSize({ height: 220 });
}

/** Overview: costs + approvals + reports front and center. */
function buildOverview(api: DockviewApi) {
  api.clear();
  add(api, P.costs!);
  add(api, P.reports!, { referencePanel: "costs", direction: "within" });
  add(api, P.approvals!, { referencePanel: "costs", direction: "below" });
  add(api, P.events!, { referencePanel: "approvals", direction: "within" });
  add(api, P.office!, { referencePanel: "costs", direction: "right" });
  add(api, P.employees!, { referencePanel: "office", direction: "below" });
  add(api, P.projects!, { referencePanel: "costs", direction: "left" });
  add(api, P.memory!, { referencePanel: "projects", direction: "within" });
  for (const id of ["projects", "costs", "approvals", "office", "employees"]) {
    api.getPanel(id)?.api.setActive();
  }
  api.getPanel("projects")?.api.setSize({ width: 260 });
  api.getPanel("office")?.api.setSize({ width: 360 });
  api.getPanel("employees")?.api.setSize({ height: 240 });
}

const BUILDERS: Record<CommandPreset, (api: DockviewApi) => void> = {
  default: buildDefault,
  operations: buildOperations,
  engineering: buildEngineering,
  overview: buildOverview,
};

export function CommandCenter() {
  const apiRef = useRef<DockviewApi | null>(null);
  const saveTimer = useRef<number | null>(null);
  const presetSeq = useUiPrefs((s) => s.presetSeq);
  const requestedPanelId = usePanelBus((s) => s.requestedPanelId);
  const requestSeq = usePanelBus((s) => s.requestSeq);
  // 2026-08-19 (Founder UX bulgusu): bir panel sekmesi X'lenince geri getirecek
  // hiçbir yol yoktu — kapalı paneller burada izlenir ve alttaki pill'den tek
  // tıkla geri açılır. Kalıcı layout kapalı hâli sakladığı için bu şart.
  const [missing, setMissing] = useState<PanelSpec[]>([]);
  function refreshMissing(api: DockviewApi) {
    setMissing(Object.values(P).filter((spec) => !api.getPanel(spec.id)));
  }
  function reopenPanel(spec: PanelSpec) {
    const api = apiRef.current;
    if (!api || api.getPanel(spec.id)) return;
    // aktif panelin grubuna sekme olarak katıl; hiç panel yoksa serbest ekle
    const anchor = api.activePanel?.id ?? api.panels[0]?.id;
    add(api, spec, anchor ? { referencePanel: anchor, direction: "within" } : undefined);
    api.getPanel(spec.id)?.api.setActive();
    refreshMissing(api);
  }

  function onReady(event: DockviewReadyEvent) {
    const api = (apiRef.current = event.api);
    const saved = useUiPrefs.getState().commandCenterLayout;
    let restored = false;
    if (saved) {
      try {
        api.fromJSON(saved as Parameters<DockviewApi["fromJSON"]>[0]);
        restored = true;
      } catch {
        // stale/incompatible persisted layout — fall back to the default build
      }
    }
    if (!restored) BUILDERS[useUiPrefs.getState().activePreset](api);
    refreshMissing(api);
    api.onDidLayoutChange(() => {
      refreshMissing(api);
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        useUiPrefs.getState().setCommandCenterLayout(api.toJSON());
      }, 500);
    });
  }

  // E1: üst çubuktaki panel açıcı (ve tek ekrana katlanan rotalar) bir panel
  // isteyince aç/öne getir. Kapalıysa aktif grubun sekmesi olarak katılır —
  // yerleşimi bozmadan "o görünüme gitmiş" olursun.
  useEffect(() => {
    if (requestSeq === 0 || !requestedPanelId) return;
    const api = apiRef.current;
    const spec = P[requestedPanelId];
    if (!api || !spec) return;
    if (!api.getPanel(spec.id)) {
      const anchor = api.activePanel?.id ?? api.panels[0]?.id;
      add(api, spec, anchor ? { referencePanel: anchor, direction: "within" } : undefined);
      refreshMissing(api);
    }
    api.getPanel(spec.id)?.api.setActive();
  }, [requestSeq, requestedPanelId]);

  // Top-bar preset buttons bump presetSeq; re-apply even if the name repeats.
  useEffect(() => {
    if (presetSeq === 0 || !apiRef.current) return;
    BUILDERS[useUiPrefs.getState().activePreset](apiRef.current);
  }, [presetSeq]);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    },
    [],
  );

  return (
    <div className="relative h-full" data-testid="command-center">
      <DockviewReact
        className="dockview-theme-dark dockview-theme-acos"
        components={components}
        onReady={onReady}
      />
      <GoalsPanel />
      {/* Kapalı paneller pill'i: X'lenen sekmeler buradan tek tıkla döner */}
      {missing.length > 0 && (
        <div
          className="absolute bottom-2 right-2 z-40 flex max-w-[60%] flex-wrap items-center gap-1 rounded-md border border-acos-line bg-acos-bg2/95 px-2 py-1 shadow-lg"
          data-testid="closed-panels-pill"
        >
          <span className="text-[9.5px] text-acos-fg2">kapalı:</span>
          {missing.map((spec) => (
            <button
              key={spec.id}
              onClick={() => reopenPanel(spec)}
              data-testid={`reopen-${spec.id}`}
              className="rounded border border-acos-line bg-acos-bg3 px-1.5 py-0.5 text-[9.5px] text-acos-fg1 hover:border-dept-engineering hover:text-acos-fg0"
              title={`${spec.title} panelini geri aç`}
            >
              + {spec.title}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
