import { describe, expect, it } from "vitest";
import {
  acosDarkCss,
  acosPreset,
  departmentColors,
  packageName,
  presenceColor,
  presenceColors,
} from "./index.js";

describe("@acos/ui", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@acos/ui");
  });

  it("acosDark tokens match 36 §2", () => {
    expect(acosPreset.theme.extend.colors.acos.bg0).toBe("#0a0c10");
    expect(acosPreset.theme.extend.colors.acos.line).toBe("#232b36");
    expect(departmentColors.engineering).toBe("#4c9aff");
    expect(Object.keys(departmentColors)).toHaveLength(7);
    expect(Object.keys(presenceColors)).toHaveLength(11);
    expect(presenceColors.escalating).toBe("#ff4d4d");
    expect(presenceColor("unknown-status")).toBe(presenceColors.offline);
  });

  it("emits the token set as :root CSS variables", () => {
    expect(acosDarkCss.startsWith(":root{")).toBe(true);
    expect(acosDarkCss).toContain("--bg-0:#0a0c10");
    expect(acosDarkCss).toContain("--fg-1:#9aa7b4");
    expect(acosDarkCss).toContain("--dept-marketing:#ff8a5c");
    expect(acosDarkCss).toContain("--presence-working:#4c9aff");
  });
});
