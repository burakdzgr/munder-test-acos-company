import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@acos/sandbox-manager", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@acos/sandbox-manager");
  });
});
