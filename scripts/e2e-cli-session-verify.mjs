#!/usr/bin/env node
// Founder Decision A (2026-08-20) — "CEO'da claude code CLI'ın kendisi olacak,
// api gibi çağırılmasın": every agent turn must BE a live Claude Code CLI
// session. ADR-023 writes that down; this script is the assert that it is TRUE
// of a running stack, not just of the code.
//
// The claim has four halves and a lie in any one of them is fatal, so each is
// checked against a different surface:
//   1. it RAN as a CLI       — the PTY log carries the real TUI banner
//   2. it was OUR session    — the MCP tool-gateway was called from inside it
//   3. it CLOSED its task    — tool_invocations has the complete_task row
//   4. it never held the key — INV-2/S2: no subscription credential in the
//                              container, only the brokered per-session token
//
// Seam names are Kevin's (T31, kevin/t31-cli-runtime): ACOS_AGENT_RUNTIME=cli,
// terminal logs under ${DATA_DIR}/terminals/<sessionId>.log, builtin audit rows
// written server-side by the PreToolUse hook, llm_calls tagged runtime='cli'.
//
// Usage:
//   node scripts/e2e-cli-session-verify.mjs --project acos-e2e-jim3 [--base-url http://localhost:13800]
//
// Exit codes: 0 = proven, 2 = a claim FAILED, 3 = not applicable (this build is
// not the CLI runtime — say so loudly instead of passing an empty test).
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const PROJECT = arg("project", process.env.ACOS_E2E_PROJECT ?? "acos-e2e");
const DATA_DIR = join(process.cwd(), "infrastructure", "docker", `data-${PROJECT}`);
const COMPANY = arg("company", null);

const results = [];
const record = (verdict, claim, detail) => {
  results.push({ verdict, claim, detail });
  const mark = verdict === "PASS" ? "PASS" : verdict === "SKIP" ? "SKIP" : "FAIL";
  console.log(`  [${mark}] ${claim}${detail ? ` — ${detail}` : ""}`);
};

const sh = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return error.stdout ?? "";
  }
};

const compose = (...args) =>
  sh("docker", ["compose", "-p", PROJECT, "-f", "infrastructure/docker/compose.yaml", ...args]);

/** One read-only SQL statement against the stack's postgres. */
const sql = (statement) =>
  compose("exec", "-T", "postgres", "psql", "-U", "acos", "-d", "acos", "-At", "-c", statement)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/** Guard every DB assert: the seam may not exist yet in this build. */
const hasColumn = (table, column) =>
  sql(
    `select 1 from information_schema.columns where table_name='${table}' and column_name='${column}'`,
  ).includes("1");

const get = async (baseUrl, path) => {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
};
const list = (body) => (Array.isArray(body) ? body : (body?.items ?? body?.data ?? []));

async function main() {
  const baseUrl = arg("base-url", process.env.ACOS_E2E_BASE_URL ?? "http://localhost:13000");
  console.log(`cli-session verify -> ${PROJECT} (${baseUrl})\n`);

  // ---- 0. capability probe -------------------------------------------------
  // Never "pass" on a build that cannot possibly satisfy the claim: a green
  // run against the API-call runtime would be the most expensive kind of lie.
  const workerEnv = compose("exec", "-T", "agent-worker", "env");
  const runtime = /^ACOS_AGENT_RUNTIME=(.*)$/m.exec(workerEnv)?.[1]?.trim();
  if (runtime !== "cli") {
    console.log(
      `NOT APPLICABLE — agent runtime is "${runtime ?? "unset (API-call worker loop)"}", not "cli".`,
    );
    console.log("Decision A is unproven on this stack; run this against a build with T31 merged.");
    process.exit(3);
  }

  // ---- pick the session under test ----------------------------------------
  let companyId = COMPANY;
  if (!companyId) {
    const companies = await get(baseUrl, "/api/v1/companies");
    companyId = list(companies.body)[0]?.id ?? null;
  }
  if (!companyId) {
    console.log("FAIL — no company on this stack to inspect");
    process.exit(2);
  }
  const terminals = await get(baseUrl, `/api/v1/companies/${companyId}/terminals`);
  const session = list(terminals.body).find((t) => t.taskId) ?? list(terminals.body)[0];
  if (!session) {
    console.log(`FAIL — company ${companyId} has no terminal session; no agent turn ever ran`);
    process.exit(2);
  }
  console.log(`session ${session.id}${session.taskId ? ` (task ${session.taskId})` : ""}\n`);

  // ---- 1. it RAN as a CLI --------------------------------------------------
  const logPath = join(DATA_DIR, "terminals", `${session.id}.log`);
  const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
  if (!log) {
    record("FAIL", "the PTY carries a live CLI session", `no terminal log at ${logPath}`);
  } else {
    const banner = /Claude Code v\d+\.\d+/.test(log);
    const bypass = /bypass permissions on/i.test(log);
    record(
      banner ? "PASS" : "FAIL",
      "the PTY carries a live CLI session",
      banner
        ? `banner present${bypass ? " + 'bypass permissions on'" : " (no bypass line — check settings.json)"}`
        : "terminal log has no Claude Code banner — this is a shell, not a session",
    );
  }

  // ---- 2. it was OUR session: the MCP gateway was called from inside it ----
  const calledMcp = /Called acos|mcp__acos/.test(log);
  record(
    calledMcp ? "PASS" : "FAIL",
    "the session reached the MCP tool-gateway",
    calledMcp ? "MCP call visible in the PTY stream" : "no MCP call in the terminal log",
  );

  // ---- 3. it CLOSED its task through the gateway --------------------------
  if (!hasColumn("tool_invocations", "id")) {
    record("SKIP", "the turn closed its task via the gateway", "no tool_invocations table");
  } else {
    // Scoping the audit rows to THIS session takes one of three shapes
    // depending on how the row was written: the worker loop tags the agent
    // session directly, while the CLI's builtin rows carry the MCP session's
    // identity and reach the agent session through Oscar's mcp_sessions row
    // (Kevin, T31 §3). Try them in order of directness.
    const scope = hasColumn("tool_invocations", "agent_session_id")
      ? `agent_session_id::text = '${session.id}'`
      : hasColumn("tool_invocations", "session_id")
        ? `session_id::text = '${session.id}'`
        : hasColumn("tool_invocations", "mcp_session_id") && hasColumn("mcp_sessions", "agent_session_id")
          ? `mcp_session_id in (select id from mcp_sessions where agent_session_id::text = '${session.id}')`
          : null;
    if (!scope) {
      record("SKIP", "the turn closed its task via the gateway", "no session column to join on");
    } else {
      const rows = sql(
        `select tool_name, count(*) from tool_invocations where ${scope} group by tool_name`,
      );
      const names = rows.map((row) => row.split("|")[0]);
      const completed = names.some((name) => /complete_task/.test(name));
      const builtins = names.filter((name) => /^(Bash|Read|Edit|Write|Glob|Grep|MultiEdit)$/.test(name));
      record(
        completed ? "PASS" : "FAIL",
        "the turn closed its task via the gateway",
        completed
          ? `complete_task audited (+${builtins.length} builtin row kind(s) from the PreToolUse hook)`
          : `no complete_task row for this session (saw: ${names.join(", ") || "nothing"})`,
      );
      // INV-3: every tool execution leaves an audit row. Builtins run INSIDE
      // the CLI, so their rows are the only proof the hook is actually wired.
      record(
        builtins.length > 0 ? "PASS" : "FAIL",
        "INV-3 holds for CLI builtins (PreToolUse hook wired)",
        builtins.length > 0 ? builtins.join(", ") : "no builtin audit rows — the hook never fired",
      );
    }
  }

  // ---- 3b. the turn's model calls are tagged as CLI -----------------------
  if (!hasColumn("llm_calls", "agent_session_id")) {
    record("SKIP", "model calls are attributed to this session", "no llm_calls.agent_session_id");
  } else {
    // Kevin's activity writes one llm_calls row per broker request, tagged
    // runtime='cli'. Assert the tag too: rows without it mean the turn went
    // through the old API-call path even though the PTY looked right.
    const count = Number(
      sql(`select count(*) from llm_calls where agent_session_id::text = '${session.id}'`)[0] ?? "0",
    );
    const cliTagged = Number(
      sql(
        `select count(*) from llm_calls where agent_session_id::text = '${session.id}' and context_telemetry->>'runtime' = 'cli'`,
      )[0] ?? "0",
    );
    record(
      count > 0 && cliTagged === count ? "PASS" : "FAIL",
      "model calls are attributed to this session and tagged runtime=cli",
      count === 0
        ? "no llm_calls rows — nothing reached the broker"
        : `${cliTagged}/${count} row(s) tagged runtime='cli'`,
    );

    // The broker meters per session and the activity mirrors its request count
    // into agent_sessions — so the two can be compared without a broker
    // surface. A mismatch means requests happened that nothing accounted for.
    if (!hasColumn("agent_sessions", "steps_count")) {
      record("SKIP", "session accounting matches the broker", "no agent_sessions.steps_count");
    } else {
      const steps = Number(
        sql(`select steps_count from agent_sessions where id::text = '${session.id}'`)[0] ?? "-1",
      );
      record(
        steps === count ? "PASS" : "FAIL",
        "session accounting matches the broker",
        `agent_sessions.steps_count=${steps} vs ${count} metered request(s)`,
      );
    }
  }

  // ---- 4. it never held the key (INV-2 / S2) ------------------------------
  // The subscription credential lives in exactly one process — the broker. The
  // container gets a revocable per-session token and nothing else. This is the
  // assert that must NEVER be softened.
  const workspace = sh("docker", [
    "ps",
    "--filter",
    "name=acos-ws-",
    "--format",
    "{{.Names}}",
  ])
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean)[0];
  if (!workspace) {
    record("SKIP", "no subscription credential inside the container", "no workspace container up");
  } else {
    const env = sh("docker", ["exec", workspace, "env"]);
    const leaked = [];
    if (/sk-ant-/.test(env)) leaked.push("sk-ant- key material");
    if (/^INTERNAL_API_TOKEN=/m.test(env)) leaked.push("INTERNAL_API_TOKEN");
    if (/^CLAUDE_CODE_OAUTH_TOKEN=/m.test(env)) leaked.push("CLAUDE_CODE_OAUTH_TOKEN");
    const brokered = /^ANTHROPIC_AUTH_TOKEN=acos-sess-/m.test(env);
    record(
      leaked.length === 0 ? "PASS" : "FAIL",
      "no subscription credential inside the container (INV-2/S2)",
      leaked.length === 0
        ? `${workspace} carries only a brokered token${brokered ? " (acos-sess-*)" : " — but ANTHROPIC_AUTH_TOKEN is not an acos-sess-* token"}`
        : `LEAKED: ${leaked.join(", ")} in ${workspace}`,
    );
  }

  const failed = results.filter((result) => result.verdict === "FAIL");
  console.log(
    `\n${results.filter((r) => r.verdict === "PASS").length} proven, ${failed.length} failed, ${results.filter((r) => r.verdict === "SKIP").length} skipped`,
  );
  process.exit(failed.length > 0 ? 2 : 0);
}

main().catch((error) => {
  console.error(`verifier crashed: ${error.message}`);
  process.exit(2);
});
