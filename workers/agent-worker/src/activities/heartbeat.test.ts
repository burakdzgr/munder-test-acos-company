// 08 §12 satır 1 — LLM sınıfı aktivitenin Temporal heartbeat sarmalayıcısı.
// Kanıtladıkları: (1) heartbeat HEMEN ve her aralıkta atılır (workflow
// tarafındaki heartbeatTimeout 60s'in altında kalır), (2) stop kesin keser,
// (3) aktivite bağlamı dışında (birim test / doğrudan çağrı) heartbeat throw
// etse bile sarmalayıcı sızdırmaz — canlı arızanın (callModelActivity 120s
// tavanda heartbeat'siz ölüp workflow'u FAİL etmesi) regresyon kilidi.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

import { heartbeat } from "@temporalio/activity";
import { startTemporalHeartbeat } from "./agent-task.js";

describe("startTemporalHeartbeat (08 §12 LLM sınıfı)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (heartbeat as Mock).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("hemen bir kez atar, sonra her aralıkta; stop kesin keser", () => {
    const stop = startTemporalHeartbeat("llm:test", 10_000);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(heartbeat).toHaveBeenCalledWith("llm:test");

    vi.advanceTimersByTime(30_000); // 3 aralık → 3 ek heartbeat
    expect(heartbeat).toHaveBeenCalledTimes(4);

    stop();
    vi.advanceTimersByTime(60_000);
    expect(heartbeat).toHaveBeenCalledTimes(4); // stop sonrası sıfır
  });

  it("varsayılan aralık 10s — 60s'lik heartbeatTimeout penceresine 6 kanıt sığar", () => {
    const stop = startTemporalHeartbeat("llm:default");
    vi.advanceTimersByTime(60_000);
    expect((heartbeat as Mock).mock.calls.length).toBeGreaterThanOrEqual(6);
    stop();
  });

  it("aktivite bağlamı dışında heartbeat throw etse bile sarmalayıcı sızdırmaz", () => {
    (heartbeat as Mock).mockImplementation(() => {
      throw new Error("not in activity context");
    });
    const stop = startTemporalHeartbeat("llm:test", 10_000);
    expect(() => vi.advanceTimersByTime(20_000)).not.toThrow();
    stop();
  });
});
