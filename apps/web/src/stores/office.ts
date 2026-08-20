// officeStore (23 §7): the ONLY entry point for office instructions on the
// client. Enforces the digital-twin invariant client-side — an instruction
// without a causeEventId THROWS in dev builds and is dropped (with a console
// warning) in prod. The Pixi bridge reads the engine directly; React renders
// overlays only, never per-frame state.
import { create } from "zustand";
import { OfficeInstructionSchema, type OfficeLayout, type PresenceState } from "@acos/contracts";
import { OfficeSceneEngine } from "../features/office/sceneState.js";
import { FloorProjector, type RosterEntry } from "../features/office/tiled/project.js";
import { officeMap } from "../features/office/tiled/tiledMap.js";

const IS_DEV: boolean =
  typeof import.meta !== "undefined" &&
  Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

interface OfficeStoreState {
  /** stable engine ref — mutated by enqueue/tick, never replaced. */
  engine: OfficeSceneEngine;
  /**
   * FAZ 2B: talimatlar motora GİRMEDEN önce sabit kata yansıtılır. Kat elle
   * çizilmiş olduğu için sunucunun kendi ızgarasındaki hücreler bizde duvara
   * denk gelir; yansıtıcı koltukları eşler ve güzergâhı bu katta yeniden
   * hesaplar. Hareketin sebebi/zamanı hâlâ TALİMATTAN gelir (23 §4.1).
   */
  projector: FloorProjector;
  snapshotCount: number;
  /** koltuk eşlemesi için unvan/tepe-yönetici bilgisi (panelden gelir) */
  setRoster: (roster: Map<string, RosterEntry>) => void;
  enqueue: (instruction: unknown) => void;
  applySnapshot: (state: PresenceState, layout?: OfficeLayout | null) => void;
  setLayout: (layout: OfficeLayout) => void;
  reset: () => void;
}

export const useOfficeStore = create<OfficeStoreState>()((set, get) => ({
  engine: new OfficeSceneEngine(),
  projector: new FloorProjector(officeMap()),
  snapshotCount: 0,
  setRoster: (roster) => {
    if (get().projector.setRoster(roster)) set((s) => ({ snapshotCount: s.snapshotCount + 1 }));
  },
  enqueue: (instruction) => {
    const causeEventId = (instruction as { causeEventId?: unknown } | null)?.causeEventId;
    if (typeof causeEventId !== "string" || causeEventId.length === 0) {
      const message = "office instruction rejected: missing causeEventId (digital-twin invariant)";
      if (IS_DEV) throw new Error(message);
      console.warn(message, instruction);
      return;
    }
    try {
      // Şema burada da doğrulanır (motor kendi içinde bir kez daha doğrular —
      // dijital ikiz invariantı iki kapıda da açık kalsın).
      const parsed = OfficeInstructionSchema.parse(instruction);
      const projected = get().projector.project(parsed);
      // Yansıtılamayan talimat MOTORA HİÇ girmez: uydurma ya da duvarın
      // içinden geçen hareket üretmektense hiç hareket etmemek doğru.
      if (!projected) return;
      get().engine.apply(projected);
    } catch (err) {
      if (IS_DEV) throw err;
      console.warn("office instruction rejected by schema", err);
    }
  },
  applySnapshot: (state, layout) => {
    get().engine.applySnapshot(get().projector.projectSnapshot(state), layout ?? null);
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
  reset: () =>
    set({
      engine: new OfficeSceneEngine(),
      projector: new FloorProjector(officeMap()),
      snapshotCount: 0,
    }),
}));
