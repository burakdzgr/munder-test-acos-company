// Context-isolated preload bridge (36 §11 — U13/U14, security-mandatory):
// the ONLY surface the renderer sees. No Node globals leak into the SPA —
// the bridge is additive and the same bundle keeps running unchanged in a
// plain browser (where window.acosDesktop is simply absent).
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("acosDesktop", {
  shell: "electron" as const,
  platform: process.platform,
  /** U14a: approval/security WS events → native OS notification; click
   *  focuses the main window and (optionally) navigates to `route`. */
  notify(title: string, body: string, route?: string): void {
    void ipcRenderer.invoke("acos:notify", { title, body, route });
  },
  /** U14b: "⧉ Ayır" → second BrowserWindow with the standalone office route. */
  openOffice(companyId: string): void {
    void ipcRenderer.invoke("acos:open-office", { companyId });
  },
  /** U14c: light presence summary feeding the tray icon/menu. */
  setPresence(state: "idle" | "active" | "needs-approval", companyId: string): void {
    void ipcRenderer.invoke("acos:presence", { state, companyId });
  },
});
