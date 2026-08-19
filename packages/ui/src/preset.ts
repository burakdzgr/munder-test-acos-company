// Tailwind preset (28 §2, 24 §7, 36 §2) — shared tokens for every ACOS surface.
// `acos`/`dept`/`presence` scales come from the acosDark theme (36 §2); the
// legacy `ink`/`accent` scales stay for the pre-overhaul views (N6: additive).
import { acosDarkSurfaces, acosDarkText, presenceColors } from "./theme/acosDark.js";
import { departmentColors } from "./theme/departmentColors.js";

export const acosPreset = {
  theme: {
    extend: {
      colors: {
        // P0-B (UI/UX review): the legacy `ink` scale is INVERTED to dark
        // semantics — every pre-overhaul view (built on ink-50 surfaces +
        // ink-800/900 text) flips to the acosDark language without a rewrite.
        // Muted text tuned for WCAG AA on bg-acos-bg1.
        ink: {
          50: "#131820",
          100: "#1b222c",
          200: "#232b36",
          400: "#7c8794",
          600: "#a9b4c0",
          800: "#dbe3ea",
          900: "#e6edf3",
          950: "#05070b",
        },
        accent: {
          400: "#8aa3ff",
          500: "#4a6bfa",
          600: "#7d95ff", // text-accent-* stays readable on dark surfaces
        },
        ok: "#2fbf71",
        warn: "#e8a13c",
        danger: "#e5484d",
        acos: {
          bg0: acosDarkSurfaces["bg-0"],
          bg1: acosDarkSurfaces["bg-1"],
          bg2: acosDarkSurfaces["bg-2"],
          bg3: acosDarkSurfaces["bg-3"],
          line: acosDarkSurfaces.line,
          fg0: acosDarkText["fg-0"],
          fg1: acosDarkText["fg-1"],
          fg2: acosDarkText["fg-2"],
        },
        dept: departmentColors,
        presence: presenceColors,
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        card: "0.625rem",
      },
    },
  },
} as const;
