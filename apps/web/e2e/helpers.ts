import { expect, type Page } from "@playwright/test";

export const FOUNDER_EMAIL = "founder@acme.local";

// Single-user mode (AUTH_AUTOLOGIN, default on): there is no login form —
// the first /api/v1 GET mints a Founder session server-side, so landing on
// "/" goes straight to company select.
export async function login(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByTestId("company-list")).toBeVisible({ timeout: 15_000 });
}

export async function openCompany(page: Page, name: string): Promise<void> {
  await page.getByTestId("company-list").getByText(name, { exact: false }).first().click();
  await expect(page.getByTestId("me-name")).toBeVisible();
}
