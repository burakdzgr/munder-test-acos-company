// officeStore (23 §7): the ONLY entry point for office instructions on the
// client. Enforces the digital-twin invariant client-side — an instruction
// without a causeEventId THROWS in dev builds and is dropped (with a console
// warning) in prod. The Pixi bridge reads the engine directly; React renders
// overlays only, never per-frame state.
import { create } from "zustand";
import type { OfficeLayout, PresenceState } from "@acos/contracts";
import { OfficeSceneEngine } from "../features/office/sceneState.js";

const IS_DEV: boolean =
  typeof import.meta !== "undefined" &&
  Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

interface OfficeStoreState {
  /** stable engine ref — mutated by enqueue/tick, never replaced. */
  engine: OfficeSceneEngine;
  snapshotCount: number;
  enqueue: (instruction: unknown) => void;
  applySnapshot: (state: PresenceState, layout?: OfficeLayout | null) => void;
  setLayout: (layout: OfficeLayout) => void;
  reset: () => void;
}

export const useOfficeStore = create<OfficeStoreState>()((set, get) => ({
  engine: new OfficeSceneEngine(),
  snapshotCount: 0,
  enqueue: (instruction) => {
    const causeEventId = (instruction as { causeEventId?: unknown } | null)?.causeEventId;
    if (typeof causeEventId !== "string" || causeEventId.length === 0) {
      const message = "office instruction rejected: missing causeEventId (digital-twin invariant)";
      if (IS_DEV) throw new Error(message);
      console.warn(message, instruction);
      return;
    }
    try {
      get().engine.apply(instruction);
    } catch (err) {
      if (IS_DEV) throw err;
      console.warn("office instruction rejected by schema", err);
    }
  },
  applySnapshot: (state, layout) => {
    get().engine.applySnapshot(state, layout ?? null);
    set((s) => ({ snapshotCount: s.snapshotCount + 1 }));
  },
  setLayout: (layout) => {
    // 2026-08-18: React Query odak/yenilemede layout'u yeniden çeker; içerik
    // DEĞİŞMEDİYSE layoutVersion'ı zıplatmak tüm zemini yeniden boyatıyordu
    // ("arada bir tekrar render"). Birebir aynı layout sessizce yutulur.
    const current = get().engine.layout;
    if (current && JSON.stringify(current) === JSON.stringify(layout)) return;
    get().engine.setLayout(layout);
  },
  reset: () => set({ engine: new OfficeSceneEngine(), snapshotCount: 0 }),
}));
