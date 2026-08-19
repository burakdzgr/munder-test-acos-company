// terminalGridStore (36 §4 — U05): S/M/L density + the per-agent open set
// for the Command Center terminal grid. Closing a cell detaches the VIEW
// only — the terminal session keeps running server-side. Sessions default
// to open; the roster toggle flips agents in/out of the closed set.
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type TerminalDensity = "S" | "M" | "L";
export const DENSITY_COLS: Record<TerminalDensity, number> = { S: 2, M: 4, L: 6 };

interface TerminalGridState {
  density: TerminalDensity;
  setDensity: (density: TerminalDensity) => void;
  closedAgentIds: string[];
  toggleAgent: (agentId: string) => void;
  closeAgent: (agentId: string) => void;
  openAll: () => void;
  /** Hücre sırası (2026-08-18, Founder isteği): sürükle-bırak ile ızgarada
   *  istenen konuma taşıma. Anahtarlar hücre kimlikleridir (`sess:<agentId>`
   *  / `pty:<sessionId>`); listede olmayan hücreler doğal sırayla sona eklenir. */
  order: string[];
  setOrder: (order: string[]) => void;
}

export const useTerminalGrid = create<TerminalGridState>()(
  persist(
    (set) => ({
      density: "M",
      setDensity: (density) => set({ density }),
      closedAgentIds: [],
      toggleAgent: (agentId) =>
        set((s) => ({
          closedAgentIds: s.closedAgentIds.includes(agentId)
            ? s.closedAgentIds.filter((id) => id !== agentId)
            : [...s.closedAgentIds, agentId],
        })),
      closeAgent: (agentId) =>
        set((s) => ({
          closedAgentIds: s.closedAgentIds.includes(agentId)
            ? s.closedAgentIds
            : [...s.closedAgentIds, agentId],
        })),
      openAll: () => set({ closedAgentIds: [] }),
      order: [],
      // Bırakma anında ızgara, GÖRÜNÜR dizilişten tam sırayı hesaplayıp
      // buraya yazar — sırada henüz kaydı olmayan hücreler de böylece
      // deterministik bir konum kazanır.
      setOrder: (order) => set({ order }),
    }),
    { name: "acos-terminal-grid" },
  ),
);
