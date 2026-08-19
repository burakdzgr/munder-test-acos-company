import { defineConfig } from "vitest/config";

// packages/domain carries a CI-enforced >=90% lines/branches coverage floor
// (32-TESTING-STRATEGY.md §9, 35 §14). Other packages are 75% advisory.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        lines: 90,
        branches: 90,
      },
    },
  },
});
