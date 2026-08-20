// Demo step 4 (29 §3): hire an agent through the wizard; the grid and the
// org chart pick it up.
import { expect, test } from "@playwright/test";
import { login, openCompany } from "./helpers";

test("hire wizard creates an active agent visible in grid and detail", async ({ page }) => {
  await login(page);
  await openCompany(page, "Acme Technologies");

  // E1 tek ekran: nav sekme satırı yok — görünümler panel açıcıdan gelir.

  await page.getByTestId("panel-launcher").click();

  await page.getByTestId("nav-agents").click();
  await expect(page.getByTestId("agent-grid")).toBeVisible();
  const seededCards = await page.getByTestId("agent-grid").locator("a").count();
  expect(seededCards).toBeGreaterThanOrEqual(8); // the 8 seed agents (demo step 4)

  const name = `Test Agent ${Date.now() % 100000}`;
  await page.getByTestId("hire-button").click();
  await page.fill('input[name="agentName"]', name);
  await page.selectOption('select[name="agentPosition"]', { label: "Backend Engineer" });
  await page.selectOption('select[name="agentUnit"]', { label: "Backend" });
  await page.selectOption('select[name="agentManager"]', { label: "Kerem Yıldız" });
  await page.fill('textarea[name="agentPersona"]', "E2E-hired agent.");
  await page.getByRole("button", { name: "İşe al & aktifleştir" }).click();

  const card = page.getByTestId("agent-grid").getByText(name);
  await expect(card).toBeVisible();

  await card.click();
  await expect(page.getByTestId("agent-name")).toHaveText(name);
  // escalation chain resolves through the seed forest up to the virtual Founder
  await expect(page.getByTestId("escalation-chain")).toContainText("Kerem Yıldız");
  await expect(page.getByTestId("escalation-chain")).toContainText("Founder (sanal)");
});
