// M2 demo (35 §M2 DoD, T26): the office shows a hire live in TWO browsers —
// avatar spawn rides outbox → relay → NATS → projector → presence topic with
// zero animation without a causeEventId — and a reload catches up via the
// presence snapshot (replay catch-up).
import { expect, test, type Page } from "@playwright/test";
import { login, openCompany } from "./helpers";

async function openOffice(page: Page): Promise<void> {
  await login(page);
  await openCompany(page, "Acme Technologies");
  await page.getByTestId("nav-office").click();
  await expect(page.getByTestId("office-agent-count")).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => (window.__acosOffice?.agentCount ?? 0) > 0, undefined, {
    timeout: 15_000,
  });
}

declare global {
  interface Window {
    __acosOffice?: {
      lastAppliedEventId: string | null;
      agentCount: number;
      interactionCount: number;
      snapshotCount: number;
      debugRing: unknown[];
    };
  }
}

test("M2: live hire appears in two browsers; reload catches up from the snapshot", async ({
  browser,
}) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  await openOffice(pageA);
  await openOffice(pageB);

  const countBefore = await pageA.evaluate(() => window.__acosOffice!.agentCount);
  expect(countBefore).toBeGreaterThanOrEqual(8); // the seed workforce is on the floor

  // hire through the API with browser B's session (same as the demo's founder)
  const companyId = pageB.url().match(/\/c\/([0-9a-f-]{36})/)![1]!;
  const csrf = (await contextB.cookies()).find((c) => c.name === "acos_csrf")?.value;
  const positions = await (
    await pageB.request.get(`/api/v1/companies/${companyId}/org/positions`)
  ).json();
  const units = await (await pageB.request.get(`/api/v1/companies/${companyId}/org/units`)).json();
  const agents = await (await pageB.request.get(`/api/v1/companies/${companyId}/agents`)).json();
  const position = positions.find((p: { title: string }) => p.title === "Backend Engineer");
  const unit = units.find((u: { name: string }) => u.name === "Backend");
  const manager = agents.find((a: { name: string }) => a.name === "Kerem Yıldız");
  const name = `Office Probe ${Date.now() % 100000}`;
  const hired = await pageB.request.post(`/api/v1/companies/${companyId}/agents`, {
    headers: { "x-csrf-token": csrf ?? "" },
    data: {
      name,
      positionId: position.id,
      orgUnitId: unit.id,
      seniority: "junior",
      autonomyLevel: 1,
      persona: "Walk-on avatar for the M2 demo.",
      managerAgentId: manager.id,
      activate: true,
    },
  });
  expect(hired.ok()).toBe(true);

  // BOTH browsers see the spawn live — no reload
  for (const page of [pageA, pageB]) {
    await page.waitForFunction(
      (before) => (window.__acosOffice?.agentCount ?? 0) > before,
      countBefore,
      { timeout: 20_000 },
    );
    // zero animation without a causal event id
    const lastApplied = await page.evaluate(() => window.__acosOffice!.lastAppliedEventId);
    expect(lastApplied).toBeTruthy();
  }

  // replay catch-up: a fresh page load rebuilds the same floor from the snapshot
  await pageA.reload();
  await expect(pageA.getByTestId("office-agent-count")).toBeVisible({ timeout: 15_000 });
  await pageA.waitForFunction(
    (before) => (window.__acosOffice?.agentCount ?? 0) > before,
    countBefore,
    { timeout: 15_000 },
  );
  await expect(pageA.getByTestId("office-agent-count")).toHaveText(
    `${countBefore + 1} ajan ofiste`,
  );

  await contextA.close();
  await contextB.close();
});
