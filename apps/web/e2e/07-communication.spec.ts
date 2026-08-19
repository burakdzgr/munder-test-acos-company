// Demo step 14 (29 §3): real inter-agent communication surface — channels
// auto-provision with their anchors, the Founder sends into a team channel,
// and the message is a durable domain fact (persists across reload).
import { expect, test } from "@playwright/test";
import { login, openCompany } from "./helpers";

test("communication: team channel auto-provisions; Founder message persists", async ({ page }) => {
  await login(page);
  await openCompany(page, "Acme Technologies");

  // create a fresh team through the API — its channel must auto-provision
  const companyId = page.url().match(/\/c\/([0-9a-f-]{36})/)![1]!;
  const csrf = (await page.context().cookies()).find((c) => c.name === "acos_csrf")?.value;
  const slug = `comms-team-${Date.now() % 100000}`;
  const units = await (await page.request.get(`/api/v1/companies/${companyId}/org/units`)).json();
  const dept = units.find((u: { kind: string }) => u.kind === "department");
  const created = await page.request.post(`/api/v1/companies/${companyId}/org/units`, {
    headers: { "x-csrf-token": csrf ?? "" },
    data: { name: `Comms Team ${slug}`, slug, kind: "team", parentId: dept.id },
  });
  expect(created.ok()).toBe(true);
  const unit = await created.json();

  await page.getByTestId("nav-communication").click();
  const channels = await (
    await page.request.get(`/api/v1/companies/${companyId}/channels?kind=team`)
  ).json();
  const channel = channels.find((c: { orgUnitId: string }) => c.orgUnitId === unit.id);
  expect(channel).toBeTruthy();

  await page.getByTestId(`channel-${channel.id}`).click();
  const body = `Standup note ${Date.now() % 100000}`;
  await page.fill('input[name="messageDraft"]', body);
  await page.getByTestId("send-message").click();
  await expect(page.getByTestId("message-pane")).toContainText(body, { timeout: 15_000 });
  await expect(page.getByTestId("message-pane")).toContainText("Founder");

  // a message is a domain fact — it survives a full reload (11 §0.1)
  await page.reload();
  await page.getByTestId(`channel-${channel.id}`).click();
  await expect(page.getByTestId("message-pane")).toContainText(body, { timeout: 15_000 });
});
