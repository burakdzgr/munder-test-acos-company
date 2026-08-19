import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@acos/agent-worker", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@acos/agent-worker");
  });
});
