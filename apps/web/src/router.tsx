// Route tree (24 §2; E1 tek ekran).
//
// E1 (Founder isteği, 2026-08-20): şirket içindeki 16 görünüm rotası TEK
// EKRANA katlandı. Rota nesneleri duruyor — eski derin bağlantılar,
// yer imleri ve e2e URL'leri kırılmasın diye — ama artık kendi sayfalarını
// AÇMIYOR: `beforeLoad` ilgili PANELİ ister ve komuta merkezine yönlendirir.
// Yani /c/:id/tasks bağlantısı hâlâ "görev panosunu göster" demek; sadece
// gideceği yer ayrı bir sayfa değil, tek ekranın bir paneli.
import {
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { AcosApiError } from "@acos/contracts/client";
import { api } from "./lib/api.js";
import { usePanelBus } from "./stores/panels.js";
import { useFocus } from "./stores/focus.js";
import { AppShell } from "./shell/AppShell.js";
import { CommandCenter } from "./shell/CommandCenter.js";
import { LoginPage } from "./features/auth/LoginPage.js";
import { SetupPage } from "./features/auth/SetupPage.js";
import { CompanySelectPage } from "./features/home/CompanySelectPage.js";
// E1: görünüm bileşenleri artık burada değil, CommandCenter'ın panel
// kayıt defterinde import edilir (tek varış noktası orası).
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


/**
 * Tek ekrana katla: istenen paneli aç ve komuta merkezine yönlendir.
 * (Panel kimlikleri CommandCenter'daki kayıt defteriyle birebir.)
 */
function foldIntoCommandCenter(panelId: string) {
  return ({ params }: { params: { companyId: string } }) => {
    usePanelBus.getState().openPanel(panelId);
    throw redirect({ to: "/c/$companyId", params: { companyId: params.companyId } });
  };
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
  beforeLoad: foldIntoCommandCenter("organization"),
});

const agentsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "agents",
  beforeLoad: foldIntoCommandCenter("agents"),
});

const agentDetailRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "agents/$agentId",
  // Derin bağlantı korunur: ajan ODAĞA alınır (paneller ona göre vurgular)
  // ve Ajanlar paneli açılır — ayrı bir sayfa açılmaz.
  beforeLoad: ({ params }) => {
    useFocus.getState().setSelectedAgent(params.agentId);
    usePanelBus.getState().openPanel("agents");
    throw redirect({ to: "/c/$companyId", params: { companyId: params.companyId } });
  },
});

const eventsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "events",
  beforeLoad: foldIntoCommandCenter("events"),
});

const officeRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "office",
  beforeLoad: foldIntoCommandCenter("office"),
});

const tasksRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "tasks",
  beforeLoad: foldIntoCommandCenter("tasks"),
});

const commsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "communication",
  beforeLoad: foldIntoCommandCenter("communication"),
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
  beforeLoad: foldIntoCommandCenter("approvals"),
});

const terminalsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "terminals",
  beforeLoad: foldIntoCommandCenter("terminals"),
});

const projectsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "projects",
  beforeLoad: foldIntoCommandCenter("projects"),
});

const skillsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "skills",
  beforeLoad: foldIntoCommandCenter("skills"),
});

const memoryRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "memory",
  beforeLoad: foldIntoCommandCenter("memory"),
});

const costsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "costs",
  beforeLoad: foldIntoCommandCenter("costs"),
});

const reportsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "reports",
  beforeLoad: foldIntoCommandCenter("reports"),
});

const dashboardRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "dashboard",
  beforeLoad: foldIntoCommandCenter("dashboard"),
});

const settingsRoute = createRoute({
  getParentRoute: () => companyRoute,
  path: "settings",
  beforeLoad: foldIntoCommandCenter("settings"),
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
