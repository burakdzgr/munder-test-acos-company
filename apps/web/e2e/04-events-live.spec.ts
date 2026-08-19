// T24: Events view — paged REST browsing shows the seeded history; live mode
// receives a fresh mutation over the WS pipeline (outbox → relay → NATS →
// gateway → RealtimeClient → ticker) without a reload.
import { expect, test } from "@playwright/test";
import { login, openCompany } from "./helpers";

test("events timeline: paged history + live WS delivery", async ({ page }) => {
  test.setTimeout(180_000); // long-lived stacks accumulate history to page through
  await login(page);
  await openCompany(page, "Acme Technologies");

  await page.getByTestId("nav-events").click();

  // WS connects through the same-origin /ws proxy
  await expect(page.getByTestId("status-bar")).toContainText("ws: open", { timeout: 15_000 });

  // paged mode serves history from GET /events; walk the seq cursor back to
  // the company's first event (company.created, seq 1)
  await page.getByTestId("live-toggle").click(); // → Paged
  await expect(page.getByTestId("event-timeline")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("event-timeline")).toContainText("agent.hired");
  // bounded by the pages actually available (50/page), not a fixed click
  // count — a long-lived stack's history can span hundreds of pages
  const timeline = page.getByTestId("event-timeline");
  for (let i = 0; i < 300; i++) {
    if ((await timeline.getByText("company.created").count()) > 0) break;
    const older = page.getByRole("button", { name: "Daha eski olayları yükle" });
    if ((await older.count()) === 0) break;
    await older.click();
    await page.waitForTimeout(250); // let the next page land before re-checking
  }
  await expect(page.getByTestId("event-timeline")).toContainText("company.created", {
    timeout: 15_000,
  });

  // back to live; a fresh mutation must stream in without a reload
  await page.getByTestId("live-toggle").click(); // → Live
  const companyId = page.url().match(/\/c\/([0-9a-f-]{36})/)![1]!;
  const csrf = (await page.context().cookies()).find((c) => c.name === "acos_csrf")?.value;
  const slug = `live-probe-${Date.now() % 100000}`;
  const created = await page.request.post(`/api/v1/companies/${companyId}/org/units`, {
    headers: { "x-csrf-token": csrf ?? "" },
    data: { name: `Live Probe ${slug}`, slug, kind: "office" },
  });
  expect(created.ok()).toBe(true);

  await expect(page.getByTestId("event-timeline")).toContainText("org.unit.created", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("status-bar")).toContainText("org.unit.created");
});
