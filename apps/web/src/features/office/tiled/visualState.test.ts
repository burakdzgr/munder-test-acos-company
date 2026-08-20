// FAZ 2B / 2B-3 — görsel durum: her çıktı bir TALİMAT türevi mi?
import { describe, expect, it } from "vitest";
import { typingOffset, visualStateFor } from "./visualState.js";

const base = { moving: false, atSeat: true, dir: "down" as const, interaction: null };

describe("görsel durum", () => {
  it("WORKING + masasında → oturur ve yazar", () => {
    const v = visualStateFor({ ...base, badge: "WORKING" });
    expect(v.posture).toBe("seated");
    expect(v.activity).toBe("typing");
    expect(v.facing).toBe("up"); // masaya dönük
    expect(v.atDesk).toBe(true);
  });

  it("masasında DEĞİLKEN yazamaz (klavye masada)", () => {
    const v = visualStateFor({ ...base, badge: "WORKING", atSeat: false });
    expect(v.posture).toBe("standing");
    expect(v.activity).toBe("idle");
  });

  it("THINKING → düşünce balonu, REVIEWING → inceleme, COMMUNICATING → konuşma", () => {
    expect(visualStateFor({ ...base, badge: "THINKING" }).bubble).toBe("thought");
    expect(visualStateFor({ ...base, badge: "REVIEWING" }).bubble).toBe("review");
    expect(visualStateFor({ ...base, badge: "COMMUNICATING" }).bubble).toBe("speech");
  });

  it("BLOCKED/ESCALATING → uyarı balonu", () => {
    expect(visualStateFor({ ...base, badge: "BLOCKED" }).bubble).toBe("alert");
    expect(visualStateFor({ ...base, badge: "ESCALATING" }).bubble).toBe("alert");
  });

  it("yürürken duruş yürüme, yön korunur", () => {
    const v = visualStateFor({ ...base, badge: "WORKING", moving: true, dir: "left" });
    expect(v.posture).toBe("walking");
    expect(v.activity).toBe("walking");
    expect(v.facing).toBe("left");
  });

  it("etkileşim badge'i EZER: yürürken bile balon görünür", () => {
    const v = visualStateFor({ ...base, badge: "IDLE", moving: true, interaction: "escalation" });
    expect(v.bubble).toBe("alert");
  });

  it("OFFLINE sönük", () => {
    expect(visualStateFor({ ...base, badge: "OFFLINE" }).dim).toBe(true);
    expect(visualStateFor({ ...base, badge: "WORKING" }).dim).toBe(false);
  });

  it("yazma ritmi YALNIZ yazarken çalışır (durum bitince ritim de biter)", () => {
    const typing = [0, 0.1, 0.2, 0.3].map((t) => typingOffset("typing", t));
    expect(new Set(typing).size).toBeGreaterThan(1); // ritim var
    const idle = [0, 0.1, 0.2, 0.3].map((t) => typingOffset("idle", t));
    expect(new Set(idle)).toEqual(new Set([0])); // hareket yok
  });
});
