// R1 resilience addendum (29 §3, T50): `docker kill agent-worker` in the
// middle of a live decomposition cascade — Temporal replays the workflow
// histories when the worker returns and the run completes with NO lost
// state. The compose-level twin of the worker-kill-resume integration suite.
// Persistent stacks accumulate earlier cascades with identical scripted
// titles, so progress is asserted as ROW-COUNT DELTAS in Postgres, never as
// presence of a title.
import { execSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { login, openCompany } from "./helpers";

const WORKER_CONTAINER = process.env.ACOS_WORKER_CONTAINER ?? "acos-agent-worker-1";
const PG_URL = process.env.ACOS_PG_URL ?? "postgres://acos:acos@localhost:5432/acos";

test("R1: killing agent-worker mid-cascade loses nothing — the run resumes and completes", async ({
  page,
}) => {
  test.setTimeout(420_000);

  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();
  const { rows: [company] } = await pg.query("SELECT id FROM companies WHERE slug = 'acme'");
  const companyId = company.id as string;
  const countTasks = async (title: string, inReview: boolean): Promise<number> => {
    const { rows } = await pg.query(
      `SELECT count(*)::int AS n FROM tasks WHERE company_id = $1 AND title = $2
       ${inReview ? "AND status = 'REVIEW'" : ""}`,
      [companyId, title],
    );
    return rows[0].n as number;
  };
  const INITIATIVE = "Initiative: analyze the project and deliver feature X";
  const DEV_TASK = "Implement the feature X service endpoint";
  const QA_TASK = "Write integration coverage for feature X";

  await login(page);
  await openCompany(page, "Acme Technologies");

  // WIP headroom: earlier scenarios' cascades leave initiatives/epics open
  // by design (their owners keep working) and the delegation engine rightly
  // refuses a third concurrent cascade (TEAM_WIP_LIMIT, 07 §6). The Founder
  // cancels the previous demo cascades through the REAL transition API
  // before starting the R1 run.
  const csrf = (await page.context().cookies()).find((c) => c.name === "acos_csrf")?.value ?? "";
  // KAPSAM: yalnız e2e senaryolarının ürettiği görevler.
  //
  // Bu sorgu eskiden şirketteki BÜTÜN açık görevleri iptal ediyordu ve
  // paylaşılan geliştirme veritabanında Founder'ın gerçek işlerini siliyordu
  // — 2026-08-15'te "Transform agent-company-os into production-ready SaaS",
  // "F1: Keşif ve Analiz", "Test ve CI durum analizi" ve altı iş daha bu
  // hazırlık adımında CANCELLED'a düştü (iptaller terminal, geri alınamıyor).
  // Yorum zaten "previous demo cascades" diyordu; SQL öyle demiyordu.
  //
  // Demo başlıkları dışında bir şey kalırsa ve WIP limiti testi bloklarsa,
  // test AÇIKÇA başarısız olur. Sessizce veri silmektense gürültülü çuvallamak
  // doğru olan: biri bir sinyal, diğeri kayıp.
  const { rows: openCascade } = await pg.query(
    `SELECT id FROM tasks WHERE company_id = $1
     AND status NOT IN ('DONE','CANCELLED','FAILED','REJECTED')
     AND (
       title ILIKE '%feature X%'
       OR title ILIKE 'Terminal demo task%'
       OR title ILIKE 'Board Probe%'
       OR title ILIKE 'Office Probe%'
       OR title ILIKE 'Greenfield %'
       OR title ILIKE 'Initiative: analyze the project%'
       OR title ILIKE 'Write integration coverage%'
     )`,
    [companyId],
  );
  for (const row of openCascade) {
    await page.request.post(`/api/v1/companies/${companyId}/tasks/${row.id}/transitions`, {
      data: { to: "CANCELLED", reason: "R1 prep — clear WIP" },
      headers: { "x-csrf-token": csrf },
    }); // per-task tolerance: some states have no CANCELLED edge
  }

  // count deltas are measured from the POST-prep baseline
  const before = {
    initiative: await countTasks(INITIATIVE, false),
    dev: await countTasks(DEV_TASK, true),
    qa: await countTasks(QA_TASK, true),
  };

  await page.getByTestId("nav-tasks").click();
  await expect(page.getByTestId("kanban-board").or(page.getByText("Görev yok"))).toBeVisible({
    timeout: 15_000,
  });

  const title = "Analyze this project and implement feature X";
  await page.getByTestId("new-task-button").click();
  await page.selectOption('select[name="taskKind"]', "goal");
  await page.fill('input[name="taskTitle"]', title);
  await page.fill('textarea[name="taskObjective"]', "R1 gate objective — survive a worker kill.");
  await page.getByTestId("create-task-submit").click();
  await page.getByTestId("column-Draft").getByText(title).first().click();
  await page.getByTestId("transition-BACKLOG").click();
  await page.getByTestId("column-Backlog").getByText(title).first().click();
  await page.getByTestId("transition-PLANNED").click();
  await page.getByTestId("column-Planned").getByText(title).first().click();
  await page.selectOption('select[name="taskAssignee"]', { label: "Aylin Vural" });
  await page.getByTestId("assign-button").click();

  // wait until THIS run's cascade is demonstrably in flight (a NEW
  // initiative row exists), then kill the worker mid-run
  await expect
    .poll(() => countTasks(INITIATIVE, false), { timeout: 120_000 })
    .toBeGreaterThan(before.initiative);
  execSync(`docker kill ${WORKER_CONTAINER}`, { stdio: "inherit" });
  await page.waitForTimeout(3_000); // the stack notices the dead worker
  execSync(`docker start ${WORKER_CONTAINER}`, { stdio: "inherit" });

  // Temporal re-dispatches on the fresh worker: THIS run's dev + QA tasks
  // still land in REVIEW — count deltas prove no lost state
  await expect
    .poll(() => countTasks(DEV_TASK, true), { timeout: 240_000 })
    .toBeGreaterThan(before.dev);
  await expect
    .poll(() => countTasks(QA_TASK, true), { timeout: 240_000 })
    .toBeGreaterThan(before.qa);

  await pg.end();
});
