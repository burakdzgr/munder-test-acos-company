// R2 resilience addendum (29 §3, T50): a second company runs the same
// learning flow and ZERO rows/events/memories cross the tenant boundary —
// probed through the API (scoped queries return nothing foreign) AND
// directly in Postgres. Plus demo step 25: the Founder's Approval Center
// holds zero routine/technical items for the whole run.
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { login, openCompany } from "./helpers";

const PG_URL = process.env.ACOS_PG_URL ?? "postgres://acos:acos@localhost:5432/acos";

test("R2: two companies, zero cross-tenant leakage; Founder inbox has zero routine items", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const marker = Date.now() % 100000;

  await login(page);
  await openCompany(page, "Acme Technologies");
  const csrf = (await page.context().cookies()).find((c) => c.name === "acos_csrf")?.value ?? "";
  const headers = { "x-csrf-token": csrf };

  // ---- create company B through the API (demo step 2 rerun) ----
  const createRes = await page.request.post(`/api/v1/companies`, {
    data: { name: `Isola ${marker}`, slug: `isola-${marker}`, currency: "USD" },
    headers,
  });
  expect(createRes.ok()).toBeTruthy();
  const companyB = (await createRes.json()) as { id: string };

  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();
  const { rows: [companyA] } = await pg.query("SELECT id FROM companies WHERE slug = 'acme'");
  const aId = companyA.id as string;
  const bId = companyB.id;

  // ---- hire an agent + run the learning flow inside B ----
  const unitRes = await page.request.post(`/api/v1/companies/${bId}/org/units`, {
    data: { name: "Eng", slug: "eng", kind: "department" },
    headers,
  });
  expect(unitRes.ok()).toBeTruthy();
  const unit = (await unitRes.json()) as { id: string };
  const posRes = await page.request.post(`/api/v1/companies/${bId}/org/positions`, {
    data: { title: "Engineer", seniorityTrack: ["mid"], defaultRole: "member" },
    headers,
  });
  expect(posRes.ok()).toBeTruthy();
  const position = (await posRes.json()) as { id: string };
  const hireRes = await page.request.post(`/api/v1/companies/${bId}/agents`, {
    data: {
      name: "Islanda Solo",
      positionId: position.id,
      orgUnitId: unit.id,
      seniority: "mid",
      autonomyLevel: 2,
      persona: "Works alone.",
    },
    headers,
  });
  expect(hireRes.ok()).toBeTruthy();
  const agentB = (await hireRes.json()) as { id: string };

  const projectB = crypto.randomUUID();
  const taskB = crypto.randomUUID();
  const { rows: [founder] } = await pg.query(
    "SELECT id FROM users WHERE lower(email) = 'founder@acme.local'",
  );
  await pg.query(
    `INSERT INTO projects (id, company_id, slug, name, objective_md, status, created_by_user_id)
     VALUES ($1, $2, 'isola-p-' || $3, 'Isola Project', 'isolated', 'active', $4)`,
    [projectB, bId, marker, founder.id],
  );
  await pg.query(
    `INSERT INTO tasks (id, company_id, project_id, number, kind, title, objective, status, owner_agent_id, context)
     VALUES ($1, $2, $3, 1, 'task', 'Isola flaky spec ${marker}', 'x', 'IN_PROGRESS', $4,
             '{"taskFixture":"flaky-test-failure"}'::jsonb)`,
    [taskB, bId, projectB, agentB.id],
  );
  const failRes = await page.request.post(
    `/api/v1/companies/${bId}/tasks/${taskB}/transitions`,
    { data: { to: "FAILED", reason: "R2 probe" }, headers },
  );
  expect(failRes.ok()).toBeTruthy();

  // the REAL pipeline consolidates B's failure into B-scoped memory
  await expect
    .poll(
      async () => {
        const { rows } = await pg.query(
          `SELECT count(*)::int AS n FROM memories WHERE company_id = $1`,
          [bId],
        );
        return rows[0].n as number;
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(1);

  // ---- isolation probes ----
  // (1) every row born in B carries B's company_id — none leaked into A
  for (const [table, ref] of [
    ["tasks", taskB],
    ["projects", projectB],
  ] as const) {
    const { rows } = await pg.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE id = $1 AND company_id <> $2`,
      [ref, bId],
    );
    expect(rows[0].n).toBe(0);
  }
  const { rows: crossEvents } = await pg.query(
    `SELECT count(*)::int AS n FROM events WHERE task_id = $1 AND company_id <> $2`,
    [taskB, bId],
  );
  expect(crossEvents[0].n).toBe(0);
  const { rows: crossMemories } = await pg.query(
    `SELECT count(*)::int AS n FROM memories m
     WHERE m.company_id = $1 AND m.scope_ref IN ($2::uuid, $3::uuid)`,
    [aId, projectB, agentB.id],
  );
  expect(crossMemories[0].n).toBe(0);

  // (2) the API never serves B's rows under A's scope
  const aMemories = await page.request.get(`/api/v1/companies/${aId}/memories?status=all`);
  const aList = (await aMemories.json()) as { items: Array<{ title: string }> };
  expect(aList.items.some((m) => m.title.includes(`Isola`))).toBe(false);
  const bTaskUnderA = await page.request.get(`/api/v1/companies/${aId}/tasks/${taskB}`);
  expect(bTaskUnderA.status()).toBe(404);
  // and B's scope DOES serve them (the probe itself is alive)
  const bMemories = await page.request.get(`/api/v1/companies/${bId}/memories?status=all`);
  const bList = (await bMemories.json()) as { items: Array<{ id: string }> };
  expect(bList.items.length).toBeGreaterThanOrEqual(1);

  // ---- demo step 25: zero routine/technical items in the Approval Center ----
  const approvals = await page.request.get(
    `/api/v1/companies/${aId}/approvals?status=pending&kind=tool_execution`,
  );
  const pending = (await approvals.json()) as Array<unknown> | { items?: Array<unknown> };
  const items = Array.isArray(pending) ? pending : (pending.items ?? []);
  expect(items.length).toBe(0);

  await pg.end();
});
