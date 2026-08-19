// 12 §5.1 pencere özeti — canlı yolun tek başına kırılabildiği yer.
//
// Özet satırlarında olay kimliği yoksa model kanıt olarak gösterecek gerçek
// bir şey bulamaz; uydurduğu her referans §5.7 doğrulamasında düşer ve TÜM
// adaylar "halüsinasyon kanıt" diye atılır. Scripted yol referansları
// doğrudan window.events[].id'den aldığı için bu kusuru göremez — o yüzden
// test doğrudan render edilen metne bakıyor.
import { describe, expect, it } from "vitest";
import type { TriggerWindow } from "@acos/db";
import { renderWindowDigest } from "./activities.js";

const EVENT_ID = "019ffe3e-f02d-71ab-bfdd-31c395cf2893";
const OTHER_ID = "019ffe3e-f02d-71ab-bfdd-31c395cf2894";

const window: TriggerWindow = {
  task: {
    id: "019ffecb-ce3c-72d5-9ef8-cac1857379ca",
    title: "Görev detayında durum geçmişi",
    status: "DONE",
    ownerAgentId: "019ff96a-6a28-744a-b144-8b6e11232c9e",
    projectId: null,
    fixtureKey: null,
  },
  agent: null,
  events: [
    {
      id: EVENT_ID,
      type: "task.status.changed",
      occurredAt: "2026-08-15T11:01:29.000Z",
      payloadSummary: "REVIEW → DONE",
    },
    {
      id: OTHER_ID,
      type: "review.completed",
      occurredAt: "2026-08-15T11:00:10.000Z",
      payloadSummary: "verdict=approved",
    },
  ],
  steps: [],
} as unknown as TriggerWindow;

describe("renderWindowDigest (12 §5.1)", () => {
  it("her satırda alıntılanabilir olay kimliğini gösterir", () => {
    const digest = renderWindowDigest(window);
    // §5.1: "every candidate must cite at least one concrete evidence ref from
    // the window" — kimlik görünmüyorsa bu talimat yerine getirilemez.
    expect(digest).toContain(`id=${EVENT_ID}`);
    expect(digest).toContain(`id=${OTHER_ID}`);
    for (const line of digest.split("\n")) {
      expect(line).toMatch(/^- id=[0-9a-f-]{36} \[/);
    }
  });

  it("tür ve özeti korur (model bağlamı kaybetmesin)", () => {
    const digest = renderWindowDigest(window);
    expect(digest).toContain("task.status.changed: REVIEW → DONE");
    expect(digest).toContain("review.completed: verdict=approved");
  });

  it("boş pencerede boş dizge döner", () => {
    expect(renderWindowDigest({ ...window, events: [] } as TriggerWindow)).toBe("");
  });
});
