// Demo step 12 (29 §3): the tasks board shows PLANNED→ASSIGNED transitions
// with per-role permissions enforced — the Founder grooms and assigns, but an
// owner-only transition attempted as the Founder is refused with 409 and the
// board says so.
import { expect, test } from "@playwright/test";
import { login, openCompany } from "./helpers";

test("tasks board: groom → assign; owner-only transition refused for the Founder", async ({
  page,
}) => {
  await login(page);
  await openCompany(page, "Acme Technologies");
  await page.getByTestId("nav-tasks").click();
  await expect(page.getByTestId("kanban-board").or(page.getByText("Görev yok"))).toBeVisible({
    timeout: 15_000,
  });

  // create an ad-hoc task through the composer
  const title = `Board Probe ${Date.now() % 100000}`;
  await page.getByTestId("new-task-button").click();
  await page.selectOption('select[name="taskKind"]', "task");
  await page.fill('input[name="taskTitle"]', title);
  await page.fill('textarea[name="taskObjective"]', "Prove demo step 12.");
  await page.getByTestId("create-task-submit").click();
  await expect(page.getByTestId("column-Draft").getByText(title)).toBeVisible({ timeout: 15_000 });

  // groom: DRAFT→BACKLOG→PLANNED (Founder-permitted)
  await page.getByTestId("column-Draft").getByText(title).click();
  await page.getByTestId("transition-BACKLOG").click();
  await expect(page.getByTestId("column-Backlog").getByText(title)).toBeVisible({ timeout: 15_000 });
  await page.getByTestId("column-Backlog").getByText(title).click();
  await page.getByTestId("transition-PLANNED").click();
  await expect(page.getByTestId("column-Planned").getByText(title)).toBeVisible({ timeout: 15_000 });

  // assign an owner (PLANNED→ASSIGNED, Founder override). Since T36 an
  // assignment auto-starts the owner's workflow; Baran (QA/Reviewer) has no
  // matching script in the scripted stack, so this card provably stays put —
  // the members drive the delegation cascade in 08-objective-to-tasks.
  await page.getByTestId("column-Planned").getByText(title).click();
  await page.selectOption('select[name="taskAssignee"]', { label: "Baran Çelik" });
  await page.getByTestId("assign-button").click();
  await expect(page.getByTestId("column-Assigned").getByText(title)).toBeVisible({
    timeout: 15_000,
  });

  // per-role enforcement: ASSIGNED→IN_PROGRESS is owner/system-only — the
  // Founder's attempt surfaces the 409 and the card stays put
  await page.getByTestId("column-Assigned").getByText(title).click();
  await page.getByTestId("transition-IN_PROGRESS").click();
  await expect(page.getByTestId("transition-error")).toContainText("task_transition_invalid", {
    timeout: 15_000,
  });
  await page.getByRole("button", { name: "Diyaloğu kapat" }).click();
  await expect(page.getByTestId("column-Assigned").getByText(title)).toBeVisible();
});
