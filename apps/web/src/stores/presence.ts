// presenceStore (24 §4): latest-wins presence state from the
// presence:<companyId> topic — snapshot seeds it, office.status.changed
// deltas keep the badge map fresh. Agent Monitor cards read badges here
// (no polling, 24 §6.2).
import { create } from "zustand";
import type { PresenceBadge, PresenceState } from "@acos/contracts";

interface PresenceStoreState {
  snapshot: PresenceState | null;
  badges: Record<string, PresenceBadge>;
  applySnapshot: (snapshot: PresenceState) => void;
  setBadge: (agentId: string, badge: PresenceBadge) => void;
  reset: () => void;
}

export const usePresence = create<PresenceStoreState>()((set) => ({
  snapshot: null,
  badges: {},
  applySnapshot: (snapshot) =>
    set({
      snapshot,
      badges: Object.fromEntries(snapshot.agents.map((a) => [a.agentId, a.badge])),
    }),
  setBadge: (agentId, badge) => set((s) => ({ badges: { ...s.badges, [agentId]: badge } })),
  reset: () => set({ snapshot: null, badges: {} }),
}));

export type { PresenceState };
