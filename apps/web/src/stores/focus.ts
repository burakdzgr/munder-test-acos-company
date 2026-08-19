// focusStore (36 §3): cross-panel agent focus. Selecting an agent anywhere
// (office avatar, roster, terminal) highlights it across every panel —
// consumers filter/highlight by selectedAgentId (wired per panel in U05–U09).
// P1-A (UI/UX review): team chips set teamFilter — the Command Center panels
// narrow to that team's members (roster/terminals/board; office dims others).
import { create } from "zustand";

export interface TeamFilter {
  unitId: string;
  name: string;
}

interface FocusState {
  selectedAgentId: string | null;
  setSelectedAgent: (agentId: string | null) => void;
  teamFilter: TeamFilter | null;
  setTeamFilter: (filter: TeamFilter | null) => void;
}

export const useFocus = create<FocusState>((set) => ({
  selectedAgentId: null,
  setSelectedAgent: (agentId) => set({ selectedAgentId: agentId }),
  teamFilter: null,
  setTeamFilter: (filter) => set({ teamFilter: filter }),
}));
