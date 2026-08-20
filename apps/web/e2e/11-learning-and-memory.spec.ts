// Demo steps 20–21 (29 §3, T48; the handoff's 10-learning-and-memory scenario
// at the repo's next free number): failures become learning — a task the
// Founder fails goes task.failed → outbox → NATS memory-trigger →
// memoryConsolidationWorkflow (scripted extraction + pseudo-embeddings) → a
// typed memory row with REAL evidence provenance, visible in the Memory
// Observatory. Plus the §8.7 contradiction queue with Founder resolution and
// the §8.8 Founder edit path (version + audit trail).
import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { login, openCompany } from "./helpers";

const PG_URL = process.env.ACOS_PG_URL ?? "postgres://acos:acos@localhost:5432/acos";

test("failure → consolidation → Observatory with provenance; contradiction queue + founder edit", async ({
  page,
}) => {
  test.setTimeout(300_000);

  // ---- seed: a tagged in-progress task owned by a seeded engineer ----
  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();
  const { rows: [company] } = await pg.query("SELECT id FROM companies WHERE slug = 'acme'");
  const companyId = company.id as string;
  const { rows: [founder] } = await pg.query(
    "SELECT id FROM users WHERE lower(email) = 'founder@acme.local'",
  );
  const { rows: [agent] } = await pg.query(
    `SELECT id FROM agents WHERE company_id = $1 AND status = 'active'
     ORDER BY employee_number LIMIT 1`,
    [companyId],
  );
  const taskNumber = 800_000 + Math.floor(Math.random() * 90_000);
  const projectId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  await pg.query(
    `INSERT INTO projects (id, company_id, slug, name, objective_md, status, created_by_user_id)
     VALUES ($1, $2, 'memory-demo-' || $3, 'Memory Demo', 'demo', 'active', $4)`,
    [projectId, companyId, taskNumber, founder.id],
  );
  await pg.query(
    `INSERT INTO tasks (id, company_id, project_id, number, kind, title, objective, status, owner_agent_id, context)
     VALUES ($1, $2, $3, $4, 'task', 'Flaky signup spec', 'fix the flake', 'IN_PROGRESS', $5,
             '{"taskFixture":"flaky-test-failure"}'::jsonb)`,
    [taskId, companyId, projectId, taskNumber, agent.id],
  );

  await login(page);
  await openCompany(page, "Acme");

  // ---- demo 20: the Founder fails the task — task.failed rides the outbox
  // to NATS; the memory-trigger consumer starts the consolidation workflow.
  // Cookie-session mutations need the CSRF double-submit header (18 §2).
  const csrf = (await page.context().cookies()).find((c) => c.name === "acos_csrf")?.value;
  const transition = await page.request.post(
    `/api/v1/companies/${companyId}/tasks/${taskId}/transitions`,
    {
      data: { to: "FAILED", reason: "signup spec is order-dependent" },
      headers: { "x-csrf-token": csrf ?? "" },
    },
  );
  expect(transition.ok()).toBeTruthy();

  // ---- demo 21: the consolidated memory appears in the Observatory ----
  // (.first(): persistent-stack re-runs accumulate one lesson per run)
  // E1 tek ekran: nav sekme satırı yok — görünümler panel açıcıdan gelir.
  await page.getByTestId("panel-launcher").click();
  await page.getByTestId("nav-memory").click();
  const row = page
    .getByTestId("memory-row")
    .filter({ hasText: "Signup e2e test is order-dependent" })
    .first();
  await expect(row).toBeVisible({ timeout: 120_000 });
  await expect(row).toContainText("failure");

  // ---- Zaman sekmesi (PROMPT1): kronolojik akışta aynı anı görünür ----
  await page.getByTestId("memory-tab-timeline").click();
  await expect(
    page
      .getByTestId("timeline-row")
      .filter({ hasText: "Signup e2e test is order-dependent" })
      .first(),
  ).toBeVisible();
  await page.getByTestId("memory-tab-list").click();
  await expect(row).toContainText("active"); // importance 0.45 ⇒ active (12 §5.9)

  // type filter narrows to the failure lesson
  await page.getByTestId("memory-type-filter").selectOption("failure");
  await expect(row).toBeVisible();

  // ---- provenance inspector: REAL evidence rows resolved from the window ----
  await row.click();
  const inspector = page.getByTestId("memory-inspector");
  await expect(inspector).toBeVisible();
  await expect(page.getByTestId("inspector-title")).toContainText(
    "Signup e2e test is order-dependent",
  );
  await expect(page.getByTestId("evidence-row").first()).toBeVisible();
  await expect(page.getByTestId("evidence-row").first()).toContainText("event");
  await expect(page.getByTestId("inspector-history")).toContainText("consolidation");

  // ---- §8.7 contradiction queue: seeded pair → badge → founder resolves ----
  const memA = crypto.randomUUID();
  const memB = crypto.randomUUID();
  const relId = crypto.randomUUID();
  for (const [id, title, content] of [
    [memA, "Retry uploads with backoff", "Retry 3x with exponential backoff."],
    [memB, "Never retry uploads", "Fail fast; retries amplify load."],
  ] as const) {
    await pg.query(
      `INSERT INTO memories (id, company_id, scope, scope_ref, type, title, content, summary, importance, confidence, status)
       VALUES ($1, $2, 'project', $3, 'failure', $4, $5, $4, 0.7, 0.8, 'active')`,
      [id, companyId, projectId, title, content],
    );
  }
  await pg.query(
    `INSERT INTO memory_relations (id, company_id, from_memory_id, to_memory_id, kind, created_by)
     VALUES ($1, $2, $3, $4, 'contradicts', 'system')`,
    [relId, companyId, memA, memB],
  );

  await page.getByTestId("memory-tab-queues").click();
  await expect(page.getByTestId("contradiction-badge")).toBeVisible({ timeout: 30_000 });
  const pair = page
    .getByTestId("contradiction-pair")
    .filter({ hasText: "Never retry uploads" })
    .first();
  await expect(pair).toBeVisible();
  await pair.getByTestId(`keep-${memA}`).click();
  await expect(pair).not.toBeVisible({ timeout: 15_000 }); // loser → superseded, queue drains
  const { rows: [loser] } = await pg.query("SELECT status FROM memories WHERE id = $1", [memB]);
  expect(loser.status).toBe("superseded");

  // ---- §8.8 founder edit: title change writes a version + memory.updated ----
  await page.getByTestId("memory-tab-list").click();
  await row.click();
  await page.getByTestId("memory-edit-open").click();
  await page.fill('input[name="memoryTitle"]', "Signup spec needs a clean users table");
  await page.getByTestId("memory-edit-save").click();
  await expect(
    page
      .getByTestId("memory-row")
      .filter({ hasText: "Signup spec needs a clean users table" })
      .first(),
  ).toBeVisible({ timeout: 15_000 });
  const { rows: [edited] } = await pg.query(
    `SELECT id FROM memories WHERE company_id = $1 AND title = 'Signup spec needs a clean users table'
     ORDER BY created_at DESC LIMIT 1`,
    [companyId],
  );
  const { rows: versions } = await pg.query(
    `SELECT version, changed_by FROM memory_versions WHERE memory_id = $1 ORDER BY version`,
    [edited.id],
  );
  expect(versions.length).toBeGreaterThanOrEqual(2);
  expect(versions.at(-1).changed_by).toBe("founder");

  await pg.end();
});
