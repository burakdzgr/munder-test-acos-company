import { describe, expect, it } from "vitest";
import { isUuid, isUuidv7, uuidv7, uuidv7Timestamp } from "./ids.js";

const fixedRandom = (n: number) => new Uint8Array(n).fill(0xab);

describe("uuidv7", () => {
  it("produces RFC-9562 v7 layout (version and variant bits)", () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe("7"); // version nibble
    expect(["8", "9", "a", "b"]).toContain(id[19]); // variant bits 10
    expect(isUuidv7(id)).toBe(true);
  });

  it("is deterministic with injected time and randomness", () => {
    const a = uuidv7({ now: 1_700_000_000_000, random: fixedRandom });
    const b = uuidv7({ now: 1_700_000_000_000, random: fixedRandom });
    expect(a).toBe(b);
  });

  it("embeds the timestamp and orders lexicographically by time", () => {
    const t1 = 1_700_000_000_000;
    const t2 = t1 + 1;
    const id1 = uuidv7({ now: t1, random: fixedRandom });
    const id2 = uuidv7({ now: t2, random: fixedRandom });
    expect(uuidv7Timestamp(id1)).toBe(t1);
    expect(uuidv7Timestamp(id2)).toBe(t2);
    expect(id1 < id2).toBe(true);
  });

  it("rejects out-of-range timestamps", () => {
    expect(() => uuidv7({ now: -1 })).toThrow(RangeError);
    expect(() => uuidv7({ now: 2 ** 48 })).toThrow(RangeError);
    expect(() => uuidv7({ now: 1.5 })).toThrow(RangeError);
  });

  it("uuidv7Timestamp rejects non-v7 uuids", () => {
    expect(() => uuidv7Timestamp("00000000-0000-4000-8000-000000000000")).toThrow(RangeError);
    expect(() => uuidv7Timestamp("not-a-uuid")).toThrow(RangeError);
  });

  it("isUuid rejects malformed strings", () => {
    expect(isUuid("xyz")).toBe(false);
    expect(isUuidv7("00000000-0000-4000-8000-000000000000")).toBe(false);
  });
});

describe("uuidv5 (RFC 9562 name-based)", () => {
  const DNS_NS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

  it("matches the RFC reference vector for example.com under the DNS namespace", async () => {
    const { uuidv5 } = await import("./ids.js");
    expect(uuidv5("www.example.com", DNS_NS)).toBe("2ed6657d-e927-568b-95e1-2665a8aea6a2");
  });

  it("is deterministic and namespace-sensitive", async () => {
    const { uuidv5, uuidv7, isUuid } = await import("./ids.js");
    const ns = uuidv7();
    expect(uuidv5("step-1", ns)).toBe(uuidv5("step-1", ns));
    expect(uuidv5("step-1", ns)).not.toBe(uuidv5("step-2", ns));
    expect(uuidv5("step-1", ns)).not.toBe(uuidv5("step-1", DNS_NS));
    expect(isUuid(uuidv5("step-1", ns))).toBe(true);
    expect(() => uuidv5("x", "not-a-uuid")).toThrow(RangeError);
  });
});
