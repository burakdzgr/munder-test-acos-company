// Demo step 16 (29 §3, T41; the handoff's 08-terminals scenario at the repo's
// next free number): REAL terminals — xterm.js streams live PTY frames from a
// hardened workspace container over NATS → WS `terminal:<sessionId>`; a WS
// kill (page reload) replays the ring buffer and the stream continues.
//
// The spec seeds a project+task straight into compose Postgres (projects REST
// lands with T42) and triggers terminal.run through the Tool Gateway's
// internal API — exactly the path an agent's use_tool takes.
import { test, expect } from "@playwright/test";
import { Client } from "pg";
import { login, openCompany } from "./helpers";

const SERVER_URL = process.env.ACOS_SERVER_URL ?? "http://localhost:3000";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN ?? "dev-internal-token-change-me";
const PG_URL = process.env.ACOS_PG_URL ?? "postgres://acos:acos@localhost:5432/acos";

test("live npm output streams into xterm; reload replays the ring and continues (demo step 16)", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);

  // ---- seed: project + task for a seeded engineer (grants come from seed) ----
  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();
  const { rows: [company] } = await pg.query("SELECT id FROM companies WHERE slug = 'acme'");
  const companyId = company.id as string;
  const { rows: [founder] } = await pg.query(
    "SELECT id FROM users WHERE lower(email) = 'founder@acme.local'",
  );
  const { rows: [agent] } = await pg.query(
    `SELECT id FROM agents WHERE company_id = $1 AND status = 'active' AND autonomy_level = 2
     ORDER BY employee_number LIMIT 1`,
    [companyId],
  );
  const taskNumber = 900_000 + Math.floor(Math.random() * 90_000);
  // ids are app-side uuidv7 in the real stack (T11) — raw inserts supply them
  const projectId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  await pg.query(
    `INSERT INTO projects (id, company_id, slug, name, objective_md, created_by_user_id)
     VALUES ($1, $2, 'terminal-demo-' || $3, 'Terminal Demo', 'demo', $4)`,
    [projectId, companyId, taskNumber, founder.id],
  );
  await pg.query(
    `INSERT INTO tasks (id, company_id, project_id, number, kind, title, objective, status, owner_agent_id)
     VALUES ($1, $2, $3, $4, 'task', 'Terminal demo task', 'stream output', 'IN_PROGRESS', $5)`,
    [taskId, companyId, projectId, taskNumber, agent.id],
  );
  const task = { id: taskId };
  await pg.end();

  // ---- fire terminal.run through the gateway (the agent's use_tool path);
  // npm output first, then a slow line-per-second tail so the live stream is
  // observable — NOT awaited: the UI watches it run ----
  const invokePromise = request.post(`${SERVER_URL}/internal/v1/tools/invoke`, {
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
    data: {
      companyId,
      agentId: agent.id,
      taskId: task.id,
      toolName: "terminal.run",
      input: {
        command:
          "npm --version && for i in 1 2 3 4 5 6 7 8 9 10 12 14 16 18 20; do echo npm-line-$i; sleep 1; done",
        timeoutSec: 180,
      },
    },
    timeout: 280_000,
  });

  // ---- UI: Terminals view lists the session; attach shows the LIVE flow ----
  await login(page);
  await openCompany(page, "Acme");
  await page.getByTestId("nav-terminals").click();

  // first-touch provisioning (worktree clone + container) happens before the
  // session opens — the list poll picks it up. Rows are keyed by THIS run's
  // task number: earlier runs may have left sessions behind.
  const sessionRow = page
    .getByTestId("terminal-session-row")
    .filter({ hasText: `TASK-${taskNumber}` });
  await expect(sessionRow.first()).toBeVisible({ timeout: 180_000 });
  await sessionRow.first().click();
  const xterm = page.getByTestId("xterm-host");
  await expect(xterm).toBeVisible();
  await expect(xterm).toContainText("npm-line-3", { timeout: 120_000 });

  // ---- WS kill: reload drops the socket mid-stream; re-attach must REPLAY
  // the ring (earlier lines) and continue live ----
  await page.reload();
  await sessionRow.first().click();
  const xtermAfter = page.getByTestId("xterm-host");
  await expect(xtermAfter).toContainText("npm-line-1", { timeout: 60_000 }); // ring replay
  await expect(xtermAfter).toContainText("npm-line-14", { timeout: 120_000 }); // still live

  // ---- the gateway records result + cost when the command finishes ----
  const invokeResponse = await invokePromise;
  expect(invokeResponse.ok()).toBe(true);
  const result = (await invokeResponse.json()) as {
    status: string;
    output?: { exitCode: number };
    costCents?: number;
  };
  expect(result.status).toBe("succeeded");
  expect(result.output?.exitCode).toBe(0);
  expect(result.costCents ?? 0).toBeGreaterThanOrEqual(1);
});
