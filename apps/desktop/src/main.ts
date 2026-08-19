// Electron main process (36 §11 — U13): a thin shell over the SAME apps/web
// bundle (never a fork). Security config is mandatory: contextIsolation on,
// nodeIntegration off, sandbox on, webSecurity on — the renderer reaches the
// OS only through the preload bridge. Backend stays in docker compose; the
// lifecycle helper (U13b) can boot it and the tray can start/stop it, or
// ACOS_BASE_URL points at an already-running stack and boot is skipped.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  shell,
  Tray,
} from "electron";
import {
  clampWindowState,
  MIN_HEIGHT,
  MIN_WIDTH,
  resolveAppTarget,
  type WindowState,
} from "./config.js";
import { checkHealth, dockerAvailable, runCompose, waitForHealth } from "./lifecycle.js";

const target = resolveAppTarget(process.env, !app.isPackaged);
const composeFile = process.env.ACOS_COMPOSE_FILE ?? null;
const statePath = () => join(app.getPath("userData"), "window-state.json");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type PresenceSummary = "idle" | "active" | "needs-approval";

let mainWindow: BrowserWindow | null = null;
let officeWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let lastPresence: PresenceSummary = "idle";
let lastCompanyId: string | null = null;

function loadWindowState(): WindowState {
  try {
    return clampWindowState(JSON.parse(readFileSync(statePath(), "utf8")));
  } catch {
    return clampWindowState(null);
  }
}

function saveWindowState(window: BrowserWindow): void {
  try {
    writeFileSync(statePath(), JSON.stringify(window.getBounds()));
  } catch {
    /* geometry persistence is best-effort */
  }
}

const SPLASH_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#0a0c10;color:#9aa7b4;font:13px Inter,sans-serif">
<div style="text-align:center"><div style="font-size:22px;font-weight:700;color:#e6edf3">A<span style="color:#2ec26a">C</span>OS</div>
<div id="s" style="margin-top:10px">stack sağlık kontrolü…</div></div>
<script>window.__setStatus = (t) => { document.getElementById("s").textContent = t; };</script>
</body></html>`)}`;

async function setSplashStatus(window: BrowserWindow, text: string): Promise<void> {
  await window.webContents
    .executeJavaScript(`window.__setStatus(${JSON.stringify(text)})`)
    .catch(() => {});
}

// U14c: presence-colored tray dot — idle grey, active green, needs-approval amber.
const PRESENCE_BGRA: Record<PresenceSummary, [number, number, number]> = {
  idle: [0x73, 0x67, 0x5c], // #5c6773
  active: [0x6a, 0xc2, 0x2e], // #2ec26a
  "needs-approval": [0x47, 0xcb, 0xff], // #ffcb47
};

function trayIcon(presence: PresenceSummary): Electron.NativeImage {
  const size = 16;
  const [b, g, r] = PRESENCE_BGRA[presence];
  const buffer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buffer[i * 4] = b;
    buffer[i * 4 + 1] = g;
    buffer[i * 4 + 2] = r;
    buffer[i * 4 + 3] = 0xff;
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function navigateMain(route: string): void {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
  if (route.startsWith("/")) {
    void mainWindow.webContents.executeJavaScript(
      `window.location.assign(${JSON.stringify(route)})`,
    );
  }
}

function buildTray(): void {
  tray = new Tray(trayIcon("idle"));
  tray.setToolTip("ACOS — idle");
  const menu = Menu.buildFromTemplate([
    {
      label: "Onayları aç",
      click: () => {
        if (lastCompanyId) navigateMain(`/c/${lastCompanyId}/approvals`);
        else mainWindow?.show();
      },
    },
    {
      label: "Göster / Gizle",
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) mainWindow.hide();
        else mainWindow.show();
      },
    },
    { type: "separator" },
    {
      label: "Stack'i başlat (docker compose up)",
      enabled: composeFile !== null,
      click: () => {
        if (composeFile) void runCompose(composeFile, "up");
      },
    },
    {
      label: "Stack'i durdur",
      enabled: composeFile !== null,
      click: () => {
        if (composeFile) void runCompose(composeFile, "stop");
      },
    },
    {
      label: "Compose loglarını aç",
      enabled: composeFile !== null,
      click: () => {
        if (!composeFile) return;
        void runCompose(composeFile, "logs").then(({ output }) => {
          const file = join(app.getPath("temp"), "acos-compose.log");
          writeFileSync(file, output);
          void shell.openPath(file);
        });
      },
    },
    { type: "separator" },
    { label: "Çıkış", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => mainWindow?.show());
}

async function healthGate(window: BrowserWindow): Promise<void> {
  if (await checkHealth(target.url)) return;
  await window.loadURL(SPLASH_HTML);
  // first-run boot (U13b): compose file known + docker present → up -d
  if (composeFile && (await dockerAvailable())) {
    await setSplashStatus(window, "docker compose up -d çalışıyor…");
    const result = await runCompose(composeFile, "up");
    if (!result.ok) await setSplashStatus(window, "compose başlatılamadı — logları kontrol et");
  }
  await setSplashStatus(window, "API sağlık bekleniyor (/api/health)…");
  const healthy = await waitForHealth(target.url, 180_000, (elapsed) => {
    void setSplashStatus(window, `API sağlık bekleniyor… ${Math.round(elapsed / 1000)}s`);
  });
  if (!healthy) {
    await setSplashStatus(
      window,
      `stack'e ulaşılamadı: ${target.url} — compose'u başlatıp uygulamayı yeniden aç`,
    );
    throw new Error("stack unreachable");
  }
}

async function createWindow(): Promise<void> {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    ...state,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    backgroundColor: "#0a0c10", // dark titlebar/ground (36 §11)
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      // security-mandatory set (36 §11) — do not weaken
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.on("close", () => mainWindow && saveWindowState(mainWindow));
  mainWindow.on("closed", () => (mainWindow = null));

  try {
    await healthGate(mainWindow);
    // deploy freshness: never let a cached index.html pin an old bundle —
    // the SPA is served live from the stack, the shell must follow it
    await mainWindow.webContents.session.clearCache();
    await mainWindow.loadURL(target.url);
  } catch {
    /* splash already shows the failure hint */
  }
}

// U14a: preload-forwarded WS events (approval.requested / security.alert) →
// native OS notification; click focuses the shell + opens the given route.
ipcMain.handle(
  "acos:notify",
  (_event, payload: { title?: unknown; body?: unknown; route?: unknown }) => {
    const title = typeof payload?.title === "string" ? payload.title : "ACOS";
    const body = typeof payload?.body === "string" ? payload.body : "";
    const route = typeof payload?.route === "string" ? payload.route : null;
    const notification = new Notification({ title, body });
    notification.on("click", () => {
      if (route) navigateMain(route);
      else mainWindow?.show();
    });
    notification.show();
  },
);

// U14b: "⧉ Ayır" → second BrowserWindow rendering the shell-less office
// route (the same /c/:id/office-window the browser popup uses).
ipcMain.handle("acos:open-office", (_event, payload: { companyId?: unknown }) => {
  const companyId = typeof payload?.companyId === "string" ? payload.companyId : "";
  if (!UUID_RE.test(companyId)) return;
  if (officeWindow && !officeWindow.isDestroyed()) {
    officeWindow.show();
    officeWindow.focus();
    return;
  }
  officeWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#0a0c10",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  officeWindow.on("closed", () => (officeWindow = null));
  void officeWindow.loadURL(`${target.url}/c/${companyId}/office-window`);
});

// U14c: light presence summary over the bridge → tray icon/tooltip.
ipcMain.handle(
  "acos:presence",
  (_event, payload: { state?: unknown; companyId?: unknown }) => {
    const state = payload?.state;
    if (state !== "idle" && state !== "active" && state !== "needs-approval") return;
    if (typeof payload?.companyId === "string" && UUID_RE.test(payload.companyId)) {
      lastCompanyId = payload.companyId;
    }
    if (state === lastPresence) return;
    lastPresence = state;
    tray?.setImage(trayIcon(state));
    tray?.setToolTip(`ACOS — ${state}`);
  },
);

void app.whenReady().then(() => {
  buildTray();
  void createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  // tray keeps the app alive on Windows/Linux only if the user chose so;
  // default: quit (mac convention preserved)
  if (process.platform !== "darwin") app.quit();
});
