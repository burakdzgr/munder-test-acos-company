import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@acos/execution-worker", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@acos/execution-worker");
  });
});
