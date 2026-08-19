import { describe, expect, it } from "vitest";
import { AVATAR_COUNT, portraitUrl, resolveAvatarId } from "./characters.js";

describe("resolveAvatarId", () => {
  it("honors an explicit pixel:avNN avatar_url (hire modal pick)", () => {
    expect(resolveAvatarId("whatever", "pixel:av07")).toBe("av07");
  });

  it("ignores non-pixel urls and hashes deterministically", () => {
    const a = resolveAvatarId("019ff466-7c83-7619-abca-95fe6cef44fd", "https://cdn/x.png");
    const b = resolveAvatarId("019ff466-7c83-7619-abca-95fe6cef44fd", null);
    expect(a).toBe(b);
    expect(a).toMatch(/^av(0[1-9]|1\d|2[0-4])$/);
  });

  it("spreads different agents across the library", () => {
    const ids = new Set(
      Array.from({ length: 60 }, (_, i) => resolveAvatarId(`agent-${i}-xyz`)),
    );
    expect(ids.size).toBeGreaterThan(AVATAR_COUNT / 2);
  });
});

describe("portraitUrl", () => {
  it("points into the baked sprite folder", () => {
    expect(portraitUrl("av03")).toBe("/sprites/characters/portraits/av03.png");
  });
});
