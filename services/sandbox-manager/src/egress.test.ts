import { describe, expect, it } from "vitest";
import { parseSquidAccessLine } from "./egress.js";

describe("parseSquidAccessLine (workspace.egress.denied plumbing, T08)", () => {
  it("recognizes a denied CONNECT and extracts the destination host", () => {
    const entry = parseSquidAccessLine(
      "1691700000.123     10 172.30.0.5 TCP_DENIED/403 3928 CONNECT example.com:443 - HIER_NONE/- text/html",
    );
    expect(entry).toEqual({
      timestampMs: 1691700000123,
      clientIp: "172.30.0.5",
      denied: true,
      method: "CONNECT",
      destination: "example.com",
    });
  });

  it("recognizes an allowed tunnel as not denied", () => {
    const entry = parseSquidAccessLine(
      "1691700001.500    250 172.30.0.7 TCP_TUNNEL/200 41234 CONNECT registry.npmjs.org:443 - HIER_DIRECT/104.16.0.1 -",
    );
    expect(entry?.denied).toBe(false);
    expect(entry?.destination).toBe("registry.npmjs.org");
  });

  it("extracts hostnames from full URLs on plain-HTTP denials", () => {
    const entry = parseSquidAccessLine(
      "1691700002.000      5 172.30.0.9 TCP_DENIED/403 3928 GET http://evil.example/payload.sh - HIER_NONE/- text/html",
    );
    expect(entry?.denied).toBe(true);
    expect(entry?.destination).toBe("evil.example");
  });

  it("returns null for non-access lines", () => {
    expect(parseSquidAccessLine("2026/08/11 01:00:00| Squid Cache (Version 6.13): started")).toBeNull();
    expect(parseSquidAccessLine("")).toBeNull();
  });
});
