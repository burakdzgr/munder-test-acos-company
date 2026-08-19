// Electron preload bridge surface (36 §11 — U14). Absent in a plain
// browser: every call site guards with `window.acosDesktop?.` so the SAME
// bundle runs unchanged outside the desktop shell.
interface AcosDesktopBridge {
  shell: "electron";
  platform: string;
  /** native OS notification; click focuses the shell + opens `route` */
  notify(title: string, body: string, route?: string): void;
  /** "⧉ Ayır" → second BrowserWindow with the standalone office route */
  openOffice(companyId: string): void;
  /** light presence summary feeding the tray icon */
  setPresence(state: "idle" | "active" | "needs-approval", companyId: string): void;
}

interface Window {
  acosDesktop?: AcosDesktopBridge;
}
