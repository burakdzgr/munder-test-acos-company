import { describe, expect, it } from "vitest";
import { packageName } from "./index.js";

describe("@acos/llm", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@acos/llm");
  });
});
