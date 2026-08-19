// T12 acceptance (+0012 from T21): every migration applies in order; row-level
// insert/read on EVERY table — dark Phase-2 tables included.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { runMigrations } from "../../src/migrate.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

/** Beklenen migration sayısı journal'dan; elle yazılan sayı sessizce eskiyor. */
const EXPECTED_MIGRATIONS: number = (
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../migrations/meta/_journal.json"),
      "utf8",
    ),
  ) as { entries: unknown[] }
).entries.length;

let container: StartedPostgreSqlContainer;
let client: Client;

/** Deterministic UUIDv7-shaped ids for fixture rows. */
const uid = (n: number) => `018f0000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const U = {
  user: uid(1),
  company: uid(2),
  unit: uid(3),
  position: uid(4),
  agent: uid(5),
  agent2: uid(6),
  provider: uid(7),
  project: uid(8),
  repo: uid(9),
  env: uid(10),
  deployment: uid(11),
  task: uid(12),
  task2: uid(13),
  artifact: uid(14),
  review: uid(15),
  event: uid(16),
  channel: uid(17),
  message: uid(18),
  memory: uid(19),
  memory2: uid(20),
  skill: uid(21),
  agentSkill: uid(22),
  policy: uid(23),
  approval: uid(24),
  workspace: uid(25),
  experiment: uid(26),
  incident: uid(27),
  asset: uid(28),
  contentItem: uid(29),
  session: uid(30),
} as const;

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  client = new Client({ connectionString: container.getConnectionUri() });
  await client.connect();
}, 240_000);

afterAll(async () => {
  await client?.end();
  await container?.stop();
});

async function insertBase(): Promise<void> {
  await client.query(
    `INSERT INTO users (id, email, password_hash, display_name) VALUES ($1,'founder@acme.local','x','Founder')`,
    [U.user],
  );
  await client.query(
    `INSERT INTO companies (id, name, slug, created_by_user_id) VALUES ($1,'Acme','acme',$2)`,
    [U.company, U.user],
  );
  await client.query(
    `INSERT INTO org_units (id, company_id, kind, name, slug) VALUES ($1,$2,'department','Engineering','eng')`,
    [U.unit, U.company],
  );
  await client.query(
    `INSERT INTO positions (id, company_id, title, seniority_track, default_role)
     VALUES ($1,$2,'Engineer','{junior,mid}','member')`,
    [U.position, U.company],
  );
  await client.query(
    `INSERT INTO agents (id, company_id, employee_number, name, position_id, org_unit_id, persona)
     VALUES ($1,$2,1,'Alex',$3,$4,'x'), ($5,$2,2,'Deniz',$3,$4,'y')`,
    [U.agent, U.company, U.position, U.unit, U.agent2],
  );
  await client.query(
    `INSERT INTO model_providers (id, kind, name) VALUES ($1,'anthropic','anthropic-main')`,
    [U.provider],
  );
}

describe("migrations 0001–0011 + row-level coverage of every table (T12)", () => {
  // Sayı journal'dan türetiliyor: sabit yazılıydı ve yeni migration'lar
  // eklenince sessizce kırıldı (entegrasyon suite'i `test` görevinde koşmuyor).
  it("applies every migration in the journal", async () => {
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM drizzle."__drizzle_migrations"',
    );
    expect(rows[0].n).toBe(EXPECTED_MIGRATIONS);
  });

  it("inserts and reads a row in every table", async () => {
    await insertBase();

    // ---- 0001 remainder ----
    await client.query(`INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1,'th', now() + interval '1 day')`, [U.user]);
    await client.query(`INSERT INTO personal_access_tokens (id, user_id, name, token_hash, token_prefix) VALUES (gen_random_uuid(), $1,'cli','h','acos_')`, [U.user]);
    await client.query(`INSERT INTO rate_limits (key, tokens, refilled_at) VALUES ('ip:1.2.3.4', 10, now())`);
    await client.query(`INSERT INTO company_members (id, company_id, user_id) VALUES (gen_random_uuid(), $1,$2)`, [U.company, U.user]);
    await client.query(`INSERT INTO company_settings (company_id) VALUES ($1)`, [U.company]);
    await client.query(`INSERT INTO company_sequences (company_id, name, value) VALUES ($1,'task_number',1)`, [U.company]);
    await client.query(`INSERT INTO secrets (id, company_id, name, ciphertext, created_by_user_id) VALUES (gen_random_uuid(), $1,'gh-token','\\xdeadbeef',$2)`, [U.company, U.user]);
    await client.query(`INSERT INTO model_profiles (id, company_id, purpose, provider_id, model) VALUES (gen_random_uuid(), $1,'reasoning',$2,'claude-fable-5')`, [U.company, U.provider]);
    await client.query(`INSERT INTO idempotency_keys (id, company_id, key, endpoint, request_hash) VALUES (gen_random_uuid(), $1,'k','/api/tasks','h')`, [U.company]);

    // ---- 0003 remainder ----
    await client.query(`INSERT INTO agent_model_bindings (id, company_id, agent_id, purpose, provider_id, model) VALUES (gen_random_uuid(), $1,$2,'primary',$3,'claude-fable-5')`, [U.company, U.agent, U.provider]);
    await client.query(
      `INSERT INTO agent_sessions (id, company_id, agent_id, workflow_id, run_id) VALUES ($1,$2,$3,'wf-1','run-1')`,
      [U.session, U.company, U.agent],
    );
    await client.query(
      `INSERT INTO agent_steps (id, company_id, agent_session_id, agent_id, step_no, action_kind, action) VALUES (gen_random_uuid(), $1,$2,$3,1,'send_message','{}')`,
      [U.company, U.session, U.agent],
    );
    await client.query(
      `INSERT INTO org_edges (id, company_id, from_agent_id, to_agent_id, kind) VALUES (gen_random_uuid(), $1,$2,$3,'reports_to')`,
      [U.company, U.agent, U.agent2],
    );

    // ---- 0004 projects & tasks ----
    await client.query(
      `INSERT INTO projects (id, company_id, slug, name, objective_md, created_by_user_id) VALUES ($1,$2,'store','Storefront','Sell things.',$3)`,
      [U.project, U.company, U.user],
    );
    await client.query(`INSERT INTO project_members (id, company_id, project_id, agent_id, role) VALUES (gen_random_uuid(), $1,$2,$3,'engineer')`, [U.company, U.project, U.agent]);
    await client.query(
      `INSERT INTO repositories (id, company_id, project_id, name, bare_path) VALUES ($1,$2,$3,'store','/data/repos/${U.project}.git')`,
      [U.repo, U.company, U.project],
    );
    await client.query(`INSERT INTO environments (id, company_id, project_id, name) VALUES ($1,$2,$3,'local')`, [U.env, U.company, U.project]);
    await client.query(
      `INSERT INTO tasks (id, company_id, project_id, number, kind, title, objective) VALUES ($1,$2,$3,81,'task','Implement login','Users sign in'), ($4,$2,$3,82,'task','Write tests','Coverage')`,
      [U.task, U.company, U.project, U.task2],
    );
    await client.query(
      `INSERT INTO deployments (id, company_id, project_id, environment_id, task_id, git_ref) VALUES ($1,$2,$3,$4,$5,'abc123')`,
      [U.deployment, U.company, U.project, U.env, U.task],
    );
    await client.query(`INSERT INTO task_dependencies (id, company_id, task_id, depends_on_task_id) VALUES (gen_random_uuid(), $1,$2,$3)`, [U.company, U.task2, U.task]);
    await client.query(`INSERT INTO task_assignments (id, company_id, task_id, agent_id) VALUES (gen_random_uuid(), $1,$2,$3)`, [U.company, U.task, U.agent]);
    await client.query(
      `INSERT INTO artifacts (id, company_id, task_id, project_id, kind, title, content_md) VALUES ($1,$2,$3,$4,'intake_report','Intake','# Report')`,
      [U.artifact, U.company, U.task, U.project],
    );
    await client.query(`UPDATE projects SET intake_report_artifact_id = $1 WHERE id = $2`, [U.artifact, U.project]);
    await client.query(
      `INSERT INTO reviews (id, company_id, task_id, project_id, repository_id, branch, author_agent_id, reviewer_agent_id)
       VALUES ($1,$2,$3,$4,$5,'task/81-implement-login',$6,$7)`,
      [U.review, U.company, U.task, U.project, U.repo, U.agent, U.agent2],
    );

    // reviewer == author must fail (23514)
    await expect(
      client.query(
        `INSERT INTO reviews (id, company_id, task_id, project_id, repository_id, branch, author_agent_id, reviewer_agent_id)
         VALUES (gen_random_uuid(), $1,$2,$3,$4,'task/82-x',$5,$5)`,
        [U.company, U.task2, U.project, U.repo, U.agent],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // ---- 0005 events ----
    await client.query(
      `INSERT INTO events (id, company_id, seq, type, actor, task_id, payload) VALUES ($1,$2,1,'task.created','{"kind":"agent","id":"${U.agent}"}',$3,'{}')`,
      [U.event, U.company, U.task],
    );
    await client.query(
      `INSERT INTO dead_events (id, company_id, event_id, event_type, consumer, error, payload) VALUES (gen_random_uuid(), $1,$2,'task.created','projector','boom','{}')`,
      [U.company, U.event],
    );

    // ---- 0006 communication ----
    await client.query(
      `INSERT INTO channels (id, company_id, kind, task_id) VALUES ($1,$2,'task_thread',$3)`,
      [U.channel, U.company, U.task],
    );
    await client.query(`INSERT INTO channel_members (id, company_id, channel_id, agent_id) VALUES (gen_random_uuid(), $1,$2,$3)`, [U.company, U.channel, U.agent]);
    await client.query(
      `INSERT INTO messages (id, company_id, channel_id, sender_agent_id, body) VALUES ($1,$2,$3,$4,'On it.')`,
      [U.message, U.company, U.channel, U.agent],
    );
    await client.query(
      `INSERT INTO notifications (id, company_id, user_id, kind, title) VALUES (gen_random_uuid(), $1,$2,'approval.requested','New approval')`,
      [U.company, U.user],
    );

    // ---- 0007 memory & knowledge ----
    await client.query(
      `INSERT INTO memories (id, company_id, scope, scope_ref, type, title, content, summary, importance, confidence, embedding, embedding_model, embedding_dim)
       VALUES ($1,$2,'agent',$3,'failure','pg first','…','Start pg first.',0.6,0.8,'[0.1,0.2,0.3]','test-model',3),
              ($4,$2,'project',$5,'decision','use drizzle','…','Drizzle it is.',0.7,0.9,NULL,NULL,NULL)`,
      [U.memory, U.company, U.agent, U.memory2, U.project],
    );
    await client.query(
      `INSERT INTO memory_versions (id, company_id, memory_id, version, title, content, summary, importance, confidence, status, changed_by)
       VALUES (gen_random_uuid(), $1,$2,1,'pg first','…','s',0.6,0.8,'candidate','system')`,
      [U.company, U.memory],
    );
    await client.query(`INSERT INTO memory_evidence (id, company_id, memory_id, kind, ref) VALUES (gen_random_uuid(), $1,$2,'event','event:${U.event}')`, [U.company, U.memory]);
    await client.query(
      `INSERT INTO memory_relations (id, company_id, from_memory_id, to_memory_id, kind, created_by) VALUES (gen_random_uuid(), $1,$2,$3,'related_to','system')`,
      [U.company, U.memory, U.memory2],
    );
    await client.query(
      `INSERT INTO memory_promotions (id, company_id, source_memory_id, target_scope, target_ref) VALUES (gen_random_uuid(), $1,$2,'project',$3)`,
      [U.company, U.memory, U.project],
    );
    await client.query(
      `INSERT INTO decisions (id, company_id, project_id, number, title, context_md, decision_md, task_id) VALUES (gen_random_uuid(), $1,$2,1,'Use Drizzle','ctx','dec',$3)`,
      [U.company, U.project, U.task],
    );
    await client.query(
      `INSERT INTO experiments (id, company_id, project_id, owner_agent_id, name, hypothesis_md, learning_memory_id) VALUES ($1,$2,$3,$4,'CTA test','More clicks.',$5)`,
      [U.experiment, U.company, U.project, U.agent, U.memory2],
    );
    await client.query(
      `INSERT INTO experiment_results (id, company_id, experiment_id, arm, metric_key, value, measured_at) VALUES (gen_random_uuid(), $1,$2,'baseline','ctr',0.05, now())`,
      [U.company, U.experiment],
    );
    await client.query(
      `INSERT INTO incidents (id, company_id, number, severity, title, summary_md) VALUES ($1,$2,1,'sev3','Flaky test','It flakes.')`,
      [U.incident, U.company],
    );

    // ---- 0008 skills ----
    await client.query(`INSERT INTO skills (id, company_id, name, category) VALUES ($1,$2,'TypeScript','engineering')`, [U.skill, U.company]);
    await client.query(
      `INSERT INTO agent_skills (id, company_id, agent_id, skill_id) VALUES ($1,$2,$3,$4)`,
      [U.agentSkill, U.company, U.agent, U.skill],
    );
    await client.query(
      `INSERT INTO skill_evidence (id, company_id, agent_skill_id, kind, weight, ref) VALUES (gen_random_uuid(), $1,$2,'task_success',0.5,'task:${U.task}')`,
      [U.company, U.agentSkill],
    );
    await client.query(
      `INSERT INTO performance_snapshots (id, company_id, agent_id, period_start, period_end) VALUES (gen_random_uuid(), $1,$2,'2026-08-03','2026-08-09')`,
      [U.company, U.agent],
    );

    // ---- 0009 governance ----
    await client.query(
      `INSERT INTO tools (id, name, version, description, risk_class, scopes, input_schema) VALUES (gen_random_uuid(), 'fs.read','1','Read files','R0','{fs}','{}')`,
    );
    await client.query(
      `INSERT INTO policies (id, company_id, name, kind, effect, rule) VALUES ($1,$2,'no-prod-friday','tool','deny','{}')`,
      [U.policy, U.company],
    );
    await client.query(`UPDATE tasks SET approval_policy_id = $1 WHERE id = $2`, [U.policy, U.task]);
    await client.query(`UPDATE memory_promotions SET rule_policy_id = $1`, [U.policy]);
    await client.query(
      `INSERT INTO tool_permissions (id, company_id, tool_name, subject_kind, subject_id) VALUES (gen_random_uuid(), $1,'fs.read','agent',$2)`,
      [U.company, U.agent],
    );
    await client.query(
      `INSERT INTO approvals (id, company_id, number, kind, title, request_md, requested_by_agent_id, risk) VALUES ($1,$2,1,'vendor','Sentry','## Brief',$3,'medium')`,
      [U.approval, U.company, U.agent],
    );
    await client.query(
      `INSERT INTO tool_invocations (id, company_id, agent_id, task_id, tool_name, risk_class, input, decision, decision_reason, approval_id, status)
       VALUES (gen_random_uuid(), $1,$2,$3,'fs.read','R0','{}','allow','matrix',$4,'succeeded')`,
      [U.company, U.agent, U.task, U.approval],
    );
    await client.query(
      `INSERT INTO audit_log (id, company_id, actor_kind, actor_id, action) VALUES (gen_random_uuid(), $1,'agent',$2,'tool.exec.r0')`,
      [U.company, U.agent],
    );

    // ---- 0010 workspaces & costs ----
    await client.query(
      `INSERT INTO workspaces (id, company_id, project_id, task_id, repository_id, agent_id, isolation_level, image, branch)
       VALUES ($1,$2,$3,$4,$5,$6,'coding','acos/workspace-node','task/81-implement-login')`,
      [U.workspace, U.company, U.project, U.task, U.repo, U.agent],
    );
    await client.query(`UPDATE reviews SET workspace_id = $1 WHERE id = $2`, [U.workspace, U.review]);
    await client.query(`UPDATE tool_invocations SET workspace_id = $1`, [U.workspace]);
    await client.query(
      `INSERT INTO workspace_locks (id, company_id, workspace_id, repository_id, path_prefix, task_id) VALUES (gen_random_uuid(), $1,$2,$3,'src/auth/',$4)`,
      [U.company, U.workspace, U.repo, U.task],
    );
    await client.query(
      `INSERT INTO terminal_sessions (id, company_id, workspace_id, agent_id, title, log_path) VALUES (gen_random_uuid(), $1,$2,$3,'npm test — TASK-81','/data/terminals/x.log')`,
      [U.company, U.workspace, U.agent],
    );
    await client.query(
      `INSERT INTO budgets (id, company_id, scope_kind, scope_ref, period, limit_cents, kind) VALUES (gen_random_uuid(), $1,'company',NULL,'daily',5000,'hard')`,
      [U.company],
    );
    await client.query(
      `INSERT INTO cost_entries (id, company_id, kind, ref, agent_id, task_id, amount_cents) VALUES (gen_random_uuid(), $1,'llm','llm_call:x',$2,$3,12)`,
      [U.company, U.agent, U.task],
    );
    await client.query(
      `INSERT INTO llm_calls (id, company_id, agent_id, task_id, purpose, provider_id, model, status) VALUES (gen_random_uuid(), $1,$2,$3,'reasoning',$4,'claude-fable-5','ok')`,
      [U.company, U.agent, U.task, U.provider],
    );

    // ---- 0011 dark marketing tables ----
    await client.query(
      `INSERT INTO assets (id, company_id, kind, title, uri, mime) VALUES ($1,$2,'image','Logo','/data/assets/logo.png','image/png')`,
      [U.asset, U.company],
    );
    await client.query(
      `INSERT INTO content_items (id, company_id, platform, kind, title, asset_ids, experiment_id) VALUES ($1,$2,'instagram','reel','Launch reel','{${U.asset}}',$3)`,
      [U.contentItem, U.company, U.experiment],
    );
    await client.query(
      `INSERT INTO publish_jobs (id, company_id, content_item_id, platform, scheduled_at) VALUES (gen_random_uuid(), $1,$2,'instagram', now() + interval '1 day')`,
      [U.company, U.contentItem],
    );
    await client.query(
      `INSERT INTO metric_snapshots (id, company_id, content_item_id, platform, captured_at, views) VALUES (gen_random_uuid(), $1,$2,'instagram', now(), 1000)`,
      [U.company, U.contentItem],
    );

    // ---- 0012 consumer offsets ----
    await client.query(
      `INSERT INTO consumer_offsets (consumer, company_id, last_seq) VALUES ('office-projector', $1, 1)`,
      [U.company],
    );

    // ---- 0013 memory retrievals (UNLOGGED, T45) ----
    await client.query(
      `INSERT INTO memory_retrievals (id, company_id, agent_id, task_id, returned_ids, scores, budget_tokens_used, duration_ms)
       VALUES (gen_random_uuid(), $1, $2, $3, ARRAY[$4]::uuid[], ARRAY[0.7]::real[], 120, 45)`,
      [U.company, U.agent, U.task, U.memory],
    );

    // ---- 0019 code index (REVISION TASK 4) ----
    await client.query(
      `INSERT INTO code_files (id, company_id, project_id, path, language, sha)
       VALUES ('cccccccc-0000-4000-8000-000000000001', $1, $2, 'src/x.ts', 'ts', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`,
      [U.company, U.project],
    );
    await client.query(
      `INSERT INTO code_symbols (id, company_id, project_id, file_id, name, kind)
       VALUES ('cccccccc-0000-4000-8000-000000000002', $1, $2, 'cccccccc-0000-4000-8000-000000000001', 'x', 'function')`,
      [U.company, U.project],
    );
    await client.query(
      `INSERT INTO code_edges (id, company_id, project_id, kind, from_file_id, to_symbol_id, symbol_name)
       VALUES (gen_random_uuid(), $1, $2, 'call', 'cccccccc-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000002', 'x')`,
      [U.company, U.project],
    );

    // ---- 0021 github connections (LIFECYCLE TASK 7) ----
    await client.query(
      `INSERT INTO github_connections (id, company_id, owner, credential_ref)
       VALUES (gen_random_uuid(), $1, 'octocat', 'github.token.test')`,
      [U.company],
    );

    // every table now has ≥1 row
    const { rows } = await client.query(`
      SELECT c.relname AS t, s.n_live_tup
      FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
      WHERE c.relname NOT LIKE 'events_%' AND c.relname NOT LIKE 'agent_steps_%'
        AND c.relname NOT LIKE 'cost_entries_%' AND c.relname <> '__drizzle_migrations'
        AND c.relkind = 'r'`);
    const empty = rows.filter((r) => Number(r.n_live_tup) === 0).map((r) => r.t);
    // pg_stat is async; verify suspected-empty tables with direct counts
    for (const t of empty) {
      const { rows: cnt } = await client.query(`SELECT count(*)::int AS n FROM "${t}"`);
      expect(cnt[0].n, `table ${t} must have rows`).toBeGreaterThan(0);
    }
  });

  it("events and cost_entries route into monthly partitions", async () => {
    const ev = await client.query(`SELECT tableoid::regclass::text AS p FROM events LIMIT 1`);
    expect(ev.rows[0].p).toMatch(/^events_\d{6}$/);
    const ce = await client.query(`SELECT tableoid::regclass::text AS p FROM cost_entries LIMIT 1`);
    expect(ce.rows[0].p).toMatch(/^cost_entries_\d{6}$/);
  });

  it("HNSW partial indexes exist for both dimensions on memories and assets", async () => {
    const { rows } = await client.query(
      `SELECT indexname FROM pg_indexes WHERE indexname LIKE '%_hnsw' ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname)).toEqual([
      "assets_emb_1536_hnsw",
      "assets_emb_768_hnsw",
      "memories_emb_1536_hnsw",
      "memories_emb_768_hnsw",
    ]);
  });

  it("cost_rollup_daily materialized view refreshes and aggregates", async () => {
    await client.query(`REFRESH MATERIALIZED VIEW cost_rollup_daily`);
    const { rows } = await client.query(`SELECT sum(amount_cents)::int AS total FROM cost_rollup_daily`);
    expect(rows[0].total).toBe(12);
  });

  it("memories scope/scope_ref CHECK holds", async () => {
    await expect(
      client.query(
        `INSERT INTO memories (id, company_id, scope, scope_ref, type, title, content, summary, importance, confidence)
         VALUES (gen_random_uuid(), $1,'company',$2,'semantic','bad','…','s',0.5,0.5)`,
        [U.company, U.agent],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
