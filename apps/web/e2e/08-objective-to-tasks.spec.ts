// T36 / M3 gate — demo steps 8–12, 14–15, 25 (29 §3; doc 32 §5 names this
// scenario 05-objective-to-tasks): the Founder feeds one objective in
// through the UI; the scripted runtime decomposes it live CEO→CTO→EM→devs
// (LLM_MODE=scripted compose stack), the board fills through the cascade,
// the task threads carry real agent messages, and the Approval Center stays
// EMPTY — zero routine technical questions reach the Founder.
import { expect, test } from "@playwright/test";
import { login, openCompany } from "./helpers";

test("Founder objective decomposes through the hierarchy; inbox stays empty", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  await openCompany(page, "Acme Technologies");
  await page.getByTestId("nav-tasks").click();
  await expect(page.getByTestId("kanban-board").or(page.getByText("Görev yok"))).toBeVisible({
    timeout: 15_000,
  });

  // step 8: the Founder objective — a goal task
  const title = "Analyze this project and implement feature X";
  await page.getByTestId("new-task-button").click();
  await page.selectOption('select[name="taskKind"]', "goal");
  await page.fill('input[name="taskTitle"]', title);
  await page.fill('textarea[name="taskObjective"]', "M3 gate objective — decompose and deliver.");
  await page.getByTestId("create-task-submit").click();
  await expect(page.getByTestId("column-Draft").getByText(title)).toBeVisible({ timeout: 15_000 });

  // groom and hand it to the CEO — the assignment starts her workflow
  await page.getByTestId("column-Draft").getByText(title).click();
  await page.getByTestId("transition-BACKLOG").click();
  await expect(page.getByTestId("column-Backlog").getByText(title)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("column-Backlog").getByText(title).click();
  await page.getByTestId("transition-PLANNED").click();
  await expect(page.getByTestId("column-Planned").getByText(title)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("column-Planned").getByText(title).click();
  await page.selectOption('select[name="taskAssignee"]', { label: "Aylin Vural" });
  await page.getByTestId("assign-button").click();

  // steps 9–11: the cascade materializes on the board via live WS
  // invalidation (.first(): re-runs against a persistent stack leave earlier
  // cascades on the board — presence, not uniqueness, is the assertion)
  await expect(
    page.getByText("Initiative: analyze the project and deliver feature X").first(),
  ).toBeVisible({ timeout: 90_000 });
  await expect(
    page.getByText("Epic: implement feature X behind the existing API").first(),
  ).toBeVisible({ timeout: 90_000 });

  // step 12: both dev tasks travel PLANNED→ASSIGNED→IN_PROGRESS and land in
  // Review — per-role permissions enforced all the way (delegators assign,
  // owners work)
  await expect(
    page.getByTestId("column-Review").getByText("Implement the feature X service endpoint").first(),
  ).toBeVisible({ timeout: 90_000 });
  await expect(
    page.getByTestId("column-Review").getByText("Write integration coverage for feature X").first(),
  ).toBeVisible({ timeout: 90_000 });

  // step 14: real inter-agent communication persisted in task threads
  await page.getByTestId("nav-communication").click();
  await expect(page.getByText("task_thread").first()).toBeVisible({ timeout: 15_000 });
  const thread = page
    .locator('[data-testid^="channel-"]', { hasText: "task_thread" })
    .first();
  await thread.click();
  await expect(page.getByTestId("message-pane")).toBeVisible({ timeout: 15_000 });

  // step 15: the office renders the run from projector instructions only —
  // the debug hook proves real instructions were applied (no fake animation)
  await page.getByTestId("nav-office").click();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __acosOffice?: { agentCount: number } }).__acosOffice
              ?.agentCount ?? 0,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  // step 25 (M3 flavor): the Founder inbox stayed empty — the whole cascade
  // ran without a single routine escalation
  await page.getByTestId("nav-approvals").click();
  await expect(page.getByText("Bekleyen onay yok", { exact: false })).toBeVisible({
    timeout: 15_000,
  });
});
