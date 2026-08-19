import { describe, expect, it } from "vitest";
import {
  clampWindowState,
  composeArgs,
  DEFAULT_STATE,
  MIN_HEIGHT,
  MIN_WIDTH,
  resolveAppTarget,
} from "./config.js";

describe("clampWindowState", () => {
  it("falls back to defaults on junk", () => {
    expect(clampWindowState(null)).toEqual(DEFAULT_STATE);
    expect(clampWindowState("x")).toEqual(DEFAULT_STATE);
    expect(clampWindowState({ width: "big" })).toEqual(DEFAULT_STATE);
  });

  it("clamps below-minimum geometry up to 1100×720 (36 §11)", () => {
    expect(clampWindowState({ width: 300, height: 200 })).toEqual({
      width: MIN_WIDTH,
      height: MIN_HEIGHT,
    });
  });

  it("keeps a valid saved state including position", () => {
    expect(clampWindowState({ width: 1600, height: 1000, x: 10, y: 20 })).toEqual({
      width: 1600,
      height: 1000,
      x: 10,
      y: 20,
    });
  });
});

describe("resolveAppTarget", () => {
  it("ACOS_BASE_URL wins in any mode (already-running stack)", () => {
    expect(resolveAppTarget({ ACOS_BASE_URL: "http://box:5173/" }, true)).toEqual({
      url: "http://box:5173",
      mode: "env",
    });
  });

  it("dev loads the Vite server on WEB_PORT", () => {
    expect(resolveAppTarget({ WEB_PORT: "5199" }, true)).toEqual({
      url: "http://localhost:5199",
      mode: "dev",
    });
    expect(resolveAppTarget({}, true).url).toBe("http://localhost:5173");
  });

  it("packaged default is the compose web service (same SPA bundle)", () => {
    expect(resolveAppTarget({}, false)).toEqual({
      url: "http://localhost:5173",
      mode: "compose",
    });
  });
});

describe("composeArgs", () => {
  it("builds docker compose argv per action", () => {
    expect(composeArgs("c.yaml", "up")).toEqual(["compose", "-f", "c.yaml", "up", "-d"]);
    expect(composeArgs("c.yaml", "stop")).toEqual(["compose", "-f", "c.yaml", "stop"]);
    expect(composeArgs("c.yaml", "logs")).toContain("--tail");
  });
});
