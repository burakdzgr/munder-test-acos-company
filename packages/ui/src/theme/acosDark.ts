// acosDark theme (36 §2) — dark command-center tokens, the only shell theme.
// Single source of truth: consumed by the Tailwind preset (preset.ts) and
// emitted as CSS variables (acosDarkCss) for canvas/inline-style consumers.
import { departmentColors } from "./departmentColors.js";

// Surfaces (near-black, cool) + hairline border.
export const acosDarkSurfaces = {
  "bg-0": "#0a0c10", // app
  "bg-1": "#0f1218", // panel
  "bg-2": "#151a22", // raised
  "bg-3": "#1c232d", // hover
  line: "#232b36",
} as const;

// Text hierarchy.
export const acosDarkText = {
  "fg-0": "#e6edf3",
  "fg-1": "#9aa7b4",
  "fg-2": "#5c6773",
} as const;

// Presence status colors (11-state set, 36 §2).
export const presenceColors = {
  working: "#4c9aff",
  thinking: "#a879ff",
  communicating: "#3fd0a0",
  reviewing: "#ffcb47",
  testing: "#3fd0a0",
  learning: "#a879ff",
  blocked: "#ff6b8a",
  escalating: "#ff4d4d",
  waiting: "#ffcb47",
  idle: "#5c6773",
  offline: "#3a424c",
} as const;

export type PresenceStatus = keyof typeof presenceColors;

export function presenceColor(status: string): string {
  return (presenceColors as Record<string, string>)[status] ?? presenceColors.offline;
}

// `:root` CSS variable block. Surface/text vars use the mockup names
// (--bg-0, --fg-1, --line); departments and presence are namespaced.
export const acosDarkCss = `:root{${[
  ...Object.entries(acosDarkSurfaces).map(([k, v]) => `--${k}:${v}`),
  ...Object.entries(acosDarkText).map(([k, v]) => `--${k}:${v}`),
  ...Object.entries(departmentColors).map(([k, v]) => `--dept-${k}:${v}`),
  ...Object.entries(presenceColors).map(([k, v]) => `--presence-${k}:${v}`),
].join(";")}}`;
