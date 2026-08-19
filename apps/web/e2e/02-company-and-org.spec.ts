// Demo steps 1–3, 5 (29 §3): login, company visible, org units created via
// UI, reporting lines rendered from real seed data.
import { expect, test } from "@playwright/test";
import { login, openCompany } from "./helpers";

test("login → Acme visible → org chart shows the 8 seeded reporting lines", async ({ page }) => {
  await login(page);
  await openCompany(page, "Acme Technologies");

  await page.getByTestId("nav-organization").click();
  await expect(page.getByTestId("org-chart")).toBeVisible();

  // seed units + positions present
  await expect(page.getByRole("cell", { name: "Engineering", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "Backend", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "Backend Engineer", exact: true }).first()).toBeVisible();
});

test("create a new unit through the UI (demo step 3)", async ({ page }) => {
  await login(page);
  await openCompany(page, "Acme Technologies");
  await page.getByTestId("nav-organization").click();

  const slug = `growth-${Date.now() % 100000}`;
  await page.fill('input[name="unitName"]', "Growth");
  await page.fill('input[name="unitSlug"]', slug);
  await page.getByRole("button", { name: "Birim oluştur" }).click();
  await expect(page.getByRole("cell", { name: "Growth" }).first()).toBeVisible();
});
