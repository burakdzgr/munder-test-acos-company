// Route tree (24 §2): /login, /setup, / (company select), /c/$companyId
// layout with organization + agents views. Remaining views land with their
// tasks (tasks T27, office T26, …).
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { AcosApiError } from "@acos/contracts/client";
import { api } from "./lib/api.js";
import { AppShell } from "./shell/AppShell.js";
import { CommandCenter } from "./shell/CommandCenter.js";
import { LoginPage } from "./features/auth/LoginPage.js";
import { SetupPage } from "./features/auth/SetupPage.js";
import { CompanySelectPage } from "./features/home/CompanySelectPage.js";
import { OrganizationView } from "./features/organization/OrganizationView.js";
import { AgentsView } from "./features/agents/AgentsView.js";
import { AgentDetailView } from "./features/agents/AgentDetailView.js";
import { EventsView } from "./features/events/EventsView.js";
import { OfficeView } from "./features/office/OfficeView.js";
import { TasksView } from "./features/tasks/TasksView.js";
import { CommunicationView } from "./features/comms/CommunicationView.js";
import { ApprovalsView } from "./features/approvals/ApprovalsView.js";
import { TerminalsView } from "./features/terminals/TerminalsView.js";
import { ProjectsView } from "./features/projects/ProjectsView.js";
import { SkillsView } from "./features/skills/SkillsView.js";
import { MemoryView } from "./features/memory/MemoryView.js";
import { CostsView } from "./features/costs/CostsView.js";
import { ReportsView } from "./features/costs/ReportsView.js";
import { SettingsView } from "./features/settings/SettingsView.js";
import { DashboardView } from "./features/dashboard/DashboardView.js";
import { ThemePreviewPage } from "./theme/PreviewPage.js";
import { OfficeWindow } from "./features/office/OfficeWindow.js";

const rootRoute = createRootRoute();

/** Search parametrelerindeki ajan/şirket kimliklerini doğrulamak için. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function requireAuth() {
  try {
    await api.auth.me();
  } catch (err) {
    if (err instanceof AcosApiError && err.problem.code === "unauthenticated") {
      throw redirect({ to: "/login" });
    }
    throw err;
  }
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  // Single-user mode (AUTH_AUTOLOGIN): the server mints a Founder session on
  // the me() probe, so /login bounces straight home. The form only renders
  // when autologin is disabled server-side.
  beforeLoad: async () => {
    let authed = false;
    try {
      await api.auth.me();
      authed = true;
    } catch (err) {
      if (!(err instanceof AcosApiError && err.problem.code === "unauthenticated")) throw err;
    }
    if (authed) throw redirect({ to: "/" });
  },
  component: LoginPage,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/setup",
  component: SetupPage,
});

// U01 (36 §2): static acosDark token/pill/button gallery — no auth, no data.
const themePreviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/theme-preview",
  component: ThemePreviewPage,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: requireAuth,
  component: CompanySelectPage,
});

const companyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/c/$companyId",
  beforeLoad: requireAuth,
  component: AppShell,
});

// Shell-less detached office (U09 "⧉ Ayır"; U14 Electron 2nd window) — a
// SIBLING of the company layout so the popup carries no chrome.
const officeWindowRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/c/$companyId/office-window",
  beforeLoad: requireAuth,
  component: OfficeWindow,
});

// U03 (36 §3): the Command Center is the default landing; the 14 views stay
// reachable as routes below (N6).
const companyIndexRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "/",
  component: CommandCenter,
});

const organizationRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "organization",
  component: OrganizationView,
});

const agentsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "agents",
  component: AgentsView,
});

const agentDetailRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "agents/$agentId",
  component: AgentDetailView,
});

const eventsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "events",
  component: EventsView,
});

const officeRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "office",
  component: OfficeView,
});

const tasksRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "tasks",
  component: TasksView,
});

const commsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "communication",
  component: CommunicationView,
  /**
   * `?dm=<agentId>` — ofisteki avatardan "Konuş" ile gelindiğinde o ajanın
   * DM'i kendiliğinden açılır. Doğrulama şart: doğrulanmamış search'te
   * TypeScript her anahtarı kabul eder, yani yazım hatası olan bir bağlantı
   * sessizce hiçbir şey yapmayan bir düğmeye dönüşürdü (bu değişiklikte tam
   * olarak öyle başladı — tip kontrolü geçti, davranış yoktu).
   */
  validateSearch: (search: Record<string, unknown>): { dm?: string } => {
    const dm = search.dm;
    return typeof dm === "string" && UUID_RE.test(dm) ? { dm } : {};
  },
});

const approvalsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "approvals",
  component: ApprovalsView,
});

const terminalsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "terminals",
  component: TerminalsView,
});

const projectsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "projects",
  component: ProjectsView,
});

const skillsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "skills",
  component: SkillsView,
});

const memoryRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "memory",
  component: MemoryView,
});

const costsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "costs",
  component: CostsView,
});

const reportsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "reports",
  component: ReportsView,
});

const dashboardRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "dashboard",
  component: DashboardView,
});

const settingsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "settings",
  component: SettingsView,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  setupRoute,
  themePreviewRoute,
  officeWindowRoute,
  indexRoute,
  companyRoute.addChildren([
    companyIndexRoute,
    dashboardRoute,
    organizationRoute,
    agentsRoute,
    agentDetailRoute,
    eventsRoute,
    officeRoute,
    tasksRoute,
    commsRoute,
    approvalsRoute,
    terminalsRoute,
    projectsRoute,
    skillsRoute,
    memoryRoute,
    costsRoute,
    reportsRoute,
    settingsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
