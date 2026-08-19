// uiPrefsStore (24 §4, 36 §3): persisted UI preferences — realtime/ephemeral
// plane. Holds the Command Center dockview layout + the active preset.
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type CommandPreset = "default" | "operations" | "engineering" | "overview";

interface UiPrefsState {
  navCollapsed: boolean;
  toggleNav: () => void;
  /** SerializedDockview JSON of the Command Center (36 §3), null = default. */
  commandCenterLayout: unknown;
  setCommandCenterLayout: (layout: unknown) => void;
  activePreset: CommandPreset;
  /** Bumped on every preset request so CommandCenter re-applies even the same preset. */
  presetSeq: number;
  requestPreset: (preset: CommandPreset) => void;
  /** Founder's presentational "Deploy Ready" marks on DONE tasks — the
   *  16-state machine is FIXED (CLAUDE.md), so this is a board-level flag,
   *  not a task status. */
  deployReadyTaskIds: string[];
  toggleDeployReady: (taskId: string) => void;
}

export const useUiPrefs = create<UiPrefsState>()(
  persist(
    (set) => ({
      navCollapsed: false,
      toggleNav: () => set((s) => ({ navCollapsed: !s.navCollapsed })),
      commandCenterLayout: null,
      setCommandCenterLayout: (layout) => set({ commandCenterLayout: layout }),
      activePreset: "default",
      presetSeq: 0,
      requestPreset: (preset) =>
        set((s) => ({ activePreset: preset, presetSeq: s.presetSeq + 1 })),
      deployReadyTaskIds: [],
      toggleDeployReady: (taskId) =>
        set((s) => ({
          deployReadyTaskIds: s.deployReadyTaskIds.includes(taskId)
            ? s.deployReadyTaskIds.filter((id) => id !== taskId)
            : [...s.deployReadyTaskIds, taskId],
        })),
    }),
    {
      name: "acos-ui-prefs",
      partialize: (s) => ({
        navCollapsed: s.navCollapsed,
        commandCenterLayout: s.commandCenterLayout,
        activePreset: s.activePreset,
        deployReadyTaskIds: s.deployReadyTaskIds,
      }),
    },
  ),
);
