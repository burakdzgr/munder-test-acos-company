// eventTickerStore (24 §4): WS-fed bounded ring of the newest 1,000 domain
// events, newest first. The Events view's "live" mode and the status bar read
// from here; REST paging never writes here.
import { create } from "zustand";
import type { Event } from "@acos/contracts";

const RING_SIZE = 1_000;

interface EventTickerState {
  events: Event[];
  lastSeq: number;
  push: (batch: Event[]) => void;
  reset: () => void;
}

export const useEventTicker = create<EventTickerState>()((set) => ({
  events: [],
  lastSeq: 0,
  push: (batch) =>
    set((state) => {
      const fresh = batch.filter((e) => e.seq > state.lastSeq);
      if (fresh.length === 0) return state;
      const events = [...fresh.reverse(), ...state.events].slice(0, RING_SIZE);
      return { events, lastSeq: events[0]!.seq };
    }),
  reset: () => set({ events: [], lastSeq: 0 }),
}));
