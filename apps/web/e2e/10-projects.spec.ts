// T42 UI slice (demo step 6's greenfield side): the Founder creates a
// project with ONLY name + business goal (P4), the intake workflow seeds the
// repo, routes the GOAL to the CEO with founder authority and the project
// goes active; the scripted cascade then fills the board. The imported-repo
// path (report artifact + analyzers) is proven in the worker's Docker-gated
// intake suite.
import { test, expect } from "@playwright/test";
import { login, openCompany } from "./helpers";

test("greenfield project: 3-field create → intake → active; GOAL cascades onto the board", async ({
  page,
}) => {
  test.setTimeout(240_000);
  const name = `Greenfield ${Date.now() % 100000}`;

  await login(page);
  await openCompany(page, "Acme");
  // E1 tek ekran: nav sekme satırı yok — görünümler panel açıcıdan gelir.
  await page.getByTestId("panel-launcher").click();
  await page.getByTestId("nav-projects").click();
  await page.getByTestId("project-create-open").click();
  await page.fill('input[name="name"]', name);
  await page.fill(
    'textarea[name="objective"]',
    "Analyze this project and implement feature X",
  );
  await page.getByTestId("project-create-submit").click();

  // the row appears and — once intake routes with founder authority — flips
  // to active without any further Founder input
  const row = page.getByTestId("project-row").filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await expect(row).toContainText("active", { timeout: 120_000 });

  // detail: overview shows the objective + the platform-origin repository
  await row.click();
  const detail = page.getByTestId("project-detail");
  await expect(detail).toContainText("Analyze this project and implement feature X");
  await expect(detail).toContainText("/data/repos/", { timeout: 30_000 });
  await expect(detail).toContainText("greenfield");

  // report tab: B4 (2026-08-15) — repo'suz proje de artık intake raporu alıyor.
  // Önceden bu yolda HİÇ artefakt üretilmiyordu ve burada "rapor yok" rozeti
  // beklenirdi; CEO'ya çıplak bir hedef cümlesi gidiyordu. Şimdi depo
  // bölümleri "henüz depo yok" diyor, yorumlayıcı bölümler hedeften yazılıyor.
  await page.getByTestId("project-tab-report").click();
  await expect(page.getByTestId("report-missing")).toHaveCount(0);
  const report = page.getByTestId("intake-report");
  await expect(report).toContainText("Project Intake Report", { timeout: 30_000 });
  await expect(report).toContainText("no repository yet");
  await expect(report).toContainText("Analyze this project and implement feature X");

  // the routed GOAL cascaded through the scripted org onto the board
  // E1 tek ekran: nav sekme satırı yok — görünümler panel açıcıdan gelir.
  await page.getByTestId("panel-launcher").click();
  await page.getByTestId("nav-tasks").click();
  await expect(
    page.getByText("Deliver: Analyze this project and implement feature X").first(),
  ).toBeVisible({ timeout: 120_000 });
});
