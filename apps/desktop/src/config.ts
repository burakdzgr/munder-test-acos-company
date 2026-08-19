// Pure config helpers for the Electron shell (36 §11 — U13): app-URL
// resolution + window-state clamping. No Electron imports — unit-tested.

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

export const DEFAULT_STATE: WindowState = { width: 1440, height: 900 };
export const MIN_WIDTH = 1100;
export const MIN_HEIGHT = 720;

/** Persisted geometry → a safe window state (junk falls back to defaults). */
export function clampWindowState(raw: unknown): WindowState {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_STATE };
  const candidate = raw as Partial<WindowState>;
  const width =
    typeof candidate.width === "number" && Number.isFinite(candidate.width)
      ? Math.max(MIN_WIDTH, Math.round(candidate.width))
      : DEFAULT_STATE.width;
  const height =
    typeof candidate.height === "number" && Number.isFinite(candidate.height)
      ? Math.max(MIN_HEIGHT, Math.round(candidate.height))
      : DEFAULT_STATE.height;
  const state: WindowState = { width, height };
  if (typeof candidate.x === "number" && Number.isFinite(candidate.x)) state.x = Math.round(candidate.x);
  if (typeof candidate.y === "number" && Number.isFinite(candidate.y)) state.y = Math.round(candidate.y);
  return state;
}

export interface AppTarget {
  url: string;
  mode: "env" | "dev" | "compose";
}

/**
 * Where the shell loads the SPA from (36 §11):
 * - ACOS_BASE_URL wins (already-running stack, any host);
 * - dev (unpackaged) → the Vite dev server on WEB_PORT;
 * - packaged default → the compose web service (nginx serves the SAME
 *   apps/web bundle + proxies /api and /ws). Loading the SPA off disk is
 *   deliberately not done: file:// breaks the same-origin /api + /ws calls
 *   the bundle makes — the stack's web container IS the built SPA.
 */
export function resolveAppTarget(
  env: Record<string, string | undefined>,
  isDev: boolean,
): AppTarget {
  const baseUrl = env.ACOS_BASE_URL?.trim();
  if (baseUrl) return { url: baseUrl.replace(/\/+$/, ""), mode: "env" };
  if (isDev) return { url: `http://localhost:${env.WEB_PORT ?? "5173"}`, mode: "dev" };
  return { url: "http://localhost:5173", mode: "compose" };
}

/** docker compose argv for the lifecycle helper (U13b). */
export function composeArgs(
  composeFile: string,
  action: "up" | "stop" | "logs",
): string[] {
  const base = ["compose", "-f", composeFile];
  if (action === "up") return [...base, "up", "-d"];
  if (action === "stop") return [...base, "stop"];
  return [...base, "logs", "--tail", "200", "--no-color"];
}
