// Playwright against the compose Mode-A stack (32 §5): web (nginx) proxies
// /api to the server; seed provides founder@acme.local with
// SEED_FOUNDER_PASSWORD.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0, // E2E allowed one auto-retry, never more (32 §12)
  workers: 1, // specs share the seeded company state
  use: {
    baseURL: process.env.ACOS_WEB_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
  },
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
});
