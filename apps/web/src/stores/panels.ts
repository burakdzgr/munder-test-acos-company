// panelBus (E1 — tek ekran): üst çubuktaki panel açıcı ile CommandCenter
// arasındaki tek yönlü kanal.
//
// Neden var: E1'de üst nav sekme satırı kaldırıldı ve 16 rota tek ekrana
// katlandı. Artık "bir görünüme gitmek" = o panelin dockview'da açılıp öne
// getirilmesi. Rota yok, dolayısıyla navigate() de yok; talebi tutan yer bu
// store. presetSeq deseninin aynısı: aynı panel arka arkaya istenirse de
// CommandCenter tepki versin diye sıra numarası artar.
import { create } from "zustand";

interface PanelBusState {
  requestedPanelId: string | null;
  requestSeq: number;
  /** Paneli aç (kapalıysa) ve öne getir. */
  openPanel: (panelId: string) => void;
}

export const usePanelBus = create<PanelBusState>((set) => ({
  requestedPanelId: null,
  requestSeq: 0,
  openPanel: (panelId) =>
    set((s) => ({ requestedPanelId: panelId, requestSeq: s.requestSeq + 1 })),
}));
