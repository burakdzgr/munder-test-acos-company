// T49 UI slice (26 §9, 29 step 24): the Costs dashboard reads the REAL
// cost_entries ledger (totals, dimension bars, burn-rate forecast) and the
// Reports view renders the CEO's executive report artifact with the real
// ledger numbers. The completion→report chain itself is proven in the
// server's executive-report integration suite.
import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { login, openCompany } from "./helpers";

const PG_URL = process.env.ACOS_PG_URL ?? "postgres://acos:acos@localhost:5432/acos";

test("costs dashboard shows ledger totals + forecast; reports view renders the executive report", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const marker = Date.now() % 100000;

  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();
  const { rows: [company] } = await pg.query("SELECT id FROM companies WHERE slug = 'acme'");
  const companyId = company.id as string;
  const { rows: [founder] } = await pg.query(
    "SELECT id FROM users WHERE lower(email) = 'founder@acme.local'",
  );
  const { rows: [agent] } = await pg.query(
    `SELECT id FROM agents WHERE company_id = $1 AND status = 'active' ORDER BY employee_number LIMIT 1`,
    [companyId],
  );
  const projectId = crypto.randomUUID();
  await pg.query(
    `INSERT INTO projects (id, company_id, slug, name, objective_md, status, created_by_user_id)
     VALUES ($1, $2, 'report-demo-' || $3, 'Report Demo ' || $3, 'demo', 'completed', $4)`,
    [projectId, companyId, marker, founder.id],
  );
  // ledger entries: 1234¢ llm + 66¢ compute = 1300¢
  for (const [kind, cents] of [
    ["llm", 1234],
    ["compute", 66],
  ] as const) {
    await pg.query(
      `INSERT INTO cost_entries (id, company_id, kind, ref, agent_id, project_id, amount_cents)
       VALUES (gen_random_uuid(), $1, $2, $2 || ':e2e-' || $5, $3, $4, $6)`,
      [companyId, kind, agent.id, projectId, marker, cents],
    );
  }
  // an enabled company budget so the forecast panel has a row
  await pg.query(
    `INSERT INTO budgets (id, company_id, scope_kind, scope_ref, period, limit_cents, kind)
     VALUES (gen_random_uuid(), $1, 'company', NULL, 'daily', 500000, 'soft')
     ON CONFLICT DO NOTHING`,
    [companyId],
  );
  // the executive report artifact (the generation chain is int-proven)
  await pg.query(
    `INSERT INTO artifacts (id, company_id, project_id, kind, title, content_md, created_by_agent_id)
     VALUES (gen_random_uuid(), $1, $2, 'executive_report',
             'Executive report — Report Demo ${marker}',
             E'# Executive report — Report Demo ${marker}\n\n## Cost\nTotal spend: 13.00 USD (1300¢).\n\n## Learnings\n- Stream, never buffer.',
             $3)`,
    [companyId, projectId, agent.id],
  );
  await pg.end();

  await login(page);
  await openCompany(page, "Acme");

  // ---- COSTS: totals from the real ledger + forecast row ----
  await page.getByTestId("nav-costs").click();
  const total = page.getByTestId("costs-total");
  await expect(total).toBeVisible();
  // ≥ this run's 1300¢ (persistent stacks accumulate earlier runs' spend)
  await expect
    .poll(async () => {
      const text = await total.textContent();
      return Number((text ?? "").match(/\$([\d.]+)/)?.[1] ?? 0);
    }, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(13);
  await expect(page.getByTestId("costs-bar").first()).toBeVisible();
  await page.getByTestId("costs-group-project").click();
  await expect(
    page.getByTestId("costs-bar").filter({ hasText: `Report Demo ${marker}` }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("costs-forecast")).toContainText("öngörü", {
    timeout: 15_000,
  });

  // ---- REPORTS: the executive report renders with the ledger numbers ----
  await page.getByTestId("nav-reports").click();
  const row = page
    .getByTestId("report-row")
    .filter({ hasText: `Report Demo ${marker}` })
    .first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  const content = page.getByTestId("report-content");
  await expect(content).toContainText("Total spend: 13.00 USD (1300¢)");
  await expect(content).toContainText("Stream, never buffer");
});
