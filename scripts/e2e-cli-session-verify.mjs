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

/**
 * A terminal log is JSONL of PTY frames with base64 payloads, and the payload
 * is a live TUI: the banner's "spacing" is cursor movement, not spaces. Reading
 * the file as text finds neither the banner nor the MCP line even when both are
 * plainly on screen — decode the frames and strip the escape sequences first.
 */
const readTerminalLog = (path) => {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        const frame = JSON.parse(line);
        return frame.data ? Buffer.from(frame.data, "base64").toString("utf8") : "";
      } catch {
        return line; // a plain-text log still reads fine
      }
    })
    .join("");
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\r/g, "");
};


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

  // A stack usually holds several companies (seed demo + whatever the run
  // created), and "the first one the API returns" is not the one under test.
  // Picking blind made this verifier report RED for "no terminal session" when
  // the session existed one company over - a false negative on a passing run,
  // the second-worst thing a test can do. Scan every company and take the
  // newest session; --company still forces one explicitly.
  const candidates = [];
  if (COMPANY) {
    candidates.push(COMPANY);
  } else {
    const companies = await get(baseUrl, "/api/v1/companies");
    candidates.push(...list(companies.body).map((company) => company.id).filter(Boolean));
  }
  if (candidates.length === 0) {
    console.log("FAIL - no company on this stack to inspect");
    process.exit(2);
  }
  const stamp = (t) => Date.parse(t.startedAt ?? t.createdAt ?? t.openedAt ?? 0) || 0;
  let companyId = null;
  let session = null;
  for (const candidate of candidates) {
    const terminals = await get(baseUrl, `/api/v1/companies/${candidate}/terminals`);
    const items = list(terminals.body);
    // A session bound to a task is the one an agent turn ran in; an unbound one
    // is a Founder shell. Prefer bound, newest first, but keep an unbound
    // session as a last resort so "a PTY exists but no turn used it" still
    // reports as a failed claim rather than as nothing to look at.
    const best =
      [...items].filter((t) => t.taskId).sort((a, b) => stamp(b) - stamp(a))[0] ??
      [...items].sort((a, b) => stamp(b) - stamp(a))[0];
    if (best && (!session || stamp(best) > stamp(session))) {
      session = best;
      companyId = candidate;
    }
  }
  if (!session) {
    console.log(
      `FAIL - none of the ${candidates.length} company/companies on this stack has a terminal session; no agent turn ever ran`,
    );
    process.exit(2);
  }
  console.log(
    `company ${companyId}
session ${session.id}${session.taskId ? ` (task ${session.taskId})` : " (no task bound)"}
`,
  );

  // ---- 1. it RAN as a CLI --------------------------------------------------
  const logPath = join(DATA_DIR, "terminals", `${session.id}.log`);
  const log = readTerminalLog(logPath);
  // Match across the cursor moves the TUI paints between letters: after
  // stripping ANSI the banner reads "ClaudeCodev2.1.237", with no spaces left.
  const banner = /Claude\s*Code\s*v\d+\.\d+/i.test(log);
  const bypass = /bypass\s*permissions\s*on/i.test(log);
  if (!log) {
    record("FAIL", "the PTY carries a live CLI session", `no terminal log at ${logPath}`);
  } else {
    record(
      banner ? "PASS" : "FAIL",
      "the PTY carries a live CLI session",
      banner
        ? `banner present${bypass ? " + 'bypass permissions on'" : " (no bypass line - check settings.json)"}`
        : `terminal log has no Claude Code banner (${log.length} decoded chars) - this is a shell, not a session`,
    );
  }

  // ---- 2. it was OUR session: the MCP gateway was called from inside it ----
  const calledMcp = /Called\s*acos|mcp__acos/i.test(log);
  record(
    calledMcp ? "PASS" : "FAIL",
    "the session reached the MCP tool-gateway",
    calledMcp ? "MCP call visible in the PTY stream" : "no MCP call in the terminal log",
  );
  // The terminal session and the agent session are two different ids with no
  // foreign key between them: /terminals gives the PTY id (right for the log
  // file), while tool_invocations / llm_calls / agent_sessions are keyed by the
  // AGENT session. Querying the DB with the PTY id silently matched zero rows
  // and reported four claims as failures on a session that had visibly run -
  // the worst failure mode a verifier has. The reliable join is the agent that
  // opened the terminal, plus the second in which it opened it.
  const agentSessionId = (() => {
    if (!session.agentId || !hasColumn("agent_sessions", "agent_id")) return null;
    const opened = session.createdAt ?? session.startedAt ?? null;
    const window = opened
      ? `and started_at <= timestamptz '${opened}' + interval '5 seconds'`
      : "";
    return (
      sql(
        `select id from agent_sessions where company_id::text = '${companyId}' and agent_id::text = '${session.agentId}' ${window} order by started_at desc limit 1`,
      )[0] ?? null
    );
  })();
  if (!agentSessionId) {
    record("SKIP", "agent session resolved from the PTY", "no agent_sessions row for this terminal's agent");
  } else {
    record("PASS", "agent session resolved from the PTY", `terminal ${session.id.slice(0, 8)} -> agent session ${agentSessionId.slice(0, 8)}`);
  }

  // ---- 3. the turn ENDED its task the way its kind allows -----------------
  // Corrected after the runtime lane weighed in (Kevin, T31): this was asserted
  // against tool_invocations, which cannot answer it. Family B verbs run
  // through the shared action dispatch, NOT ToolGateway.invoke, so closing a
  // task leaves no tool_invocations row at all — only Family A calls and the
  // builtin audits do. Asserting there reported "the turn never closed its
  // task" about turns that had done exactly what 07 §2 asks of them.
  //
  // And the shape depends on the task's KIND. Containers (goal/initiative/epic)
  // are never "completed" by their owner — they close by roll-up, so an owner's
  // turn legitimately ends by splitting the work off and parking. Leaves
  // (task/subtask) end at REVIEW/QA/DONE. Splitting the claim this way is 07 §2,
  // not a weakening: each kind is still required to have finished something.
  const CONTAINER_KINDS = ["goal", "initiative", "epic"];
  if (!agentSessionId) {
    record("SKIP", "the turn ended its task the way its kind allows", "no agent session to scope to");
  } else {
    const [row] = sql(
      `select coalesce(t.kind,'?'), coalesce(t.status,'?'), s.agent_id, s.started_at, coalesce(s.ended_at, now()), coalesce(t.id::text,'')
         from agent_sessions s left join tasks t on t.id = s.task_id
        where s.id::text = '${agentSessionId}'`,
    );
    if (!row) {
      record("SKIP", "the turn ended its task the way its kind allows", "no agent_sessions row");
    } else {
      const [kind, status, agentId, startedAt, endedAt, taskId] = row.split("|");
      const inWindow = `occurred_at between timestamptz '${startedAt}' and timestamptz '${endedAt}'`;
      const eventsBy = (type) =>
        Number(
          sql(
            `select count(*) from events where company_id::text = '${companyId}' and type = '${type}' and agent_id::text = '${agentId}' and ${inWindow}`,
          )[0] ?? "0",
        );
      if (CONTAINER_KINDS.includes(kind)) {
        const created = eventsBy("task.created");
        const parked = eventsBy("task.status.changed");
        const delegated = eventsBy("task.delegated");
        const ok = created > 0 && parked + delegated > 0;
        record(
          ok ? "PASS" : "FAIL",
          "the turn ended its task the way its kind allows",
          ok
            ? `${kind} turn split the work off (${created} task.created) and handed it on (${delegated} delegated, ${parked} status change(s)); container now ${status} and closes by roll-up`
            : `${kind} turn left nothing behind (${created} created, ${delegated} delegated, ${parked} status change(s)) - the container cannot close by roll-up`,
        );
        // Say what this run did NOT prove. A container turn closing by handoff
        // says nothing about the leaf path, and a reader counting greens would
        // otherwise carry away "the whole close chain is proven on a real
        // server". It is not: complete_task is exercised against the mock
        // gateway only (T39 follow-up).
        record(
          "SKIP",
          "a LEAF turn closes with complete_task",
          "no leaf turn in this run - the leaf path is proven against the mock gateway, not yet on a real server (T39)",
        );
      } else {
        const handedOff = ["REVIEW", "QA", "DONE"].includes(status);
        const changed = eventsBy("task.status.changed");
        record(
          handedOff && changed > 0 ? "PASS" : "FAIL",
          "the turn ended its task the way its kind allows",
          handedOff && changed > 0
            ? `${kind} reached ${status} with a status change by this agent`
            : `${kind} sits at ${status} after the session (${changed} status change(s) by this agent) - the leaf never reached review or done`,
        );
      }
      void taskId;
    }
  }

  // ---- 3a. INV-3 holds where the tools actually execute --------------------
  if (!agentSessionId || !hasColumn("tool_invocations", "id")) {
    record("SKIP", "INV-3 holds for CLI builtins (PreToolUse hook wired)", "no session/table to scope to");
  } else {
    const scope = hasColumn("tool_invocations", "agent_session_id")
      ? `agent_session_id::text = '${agentSessionId}'`
      : hasColumn("tool_invocations", "mcp_session_id") && hasColumn("mcp_sessions", "agent_session_id")
        ? `mcp_session_id in (select id from mcp_sessions where agent_session_id::text = '${agentSessionId}')`
        : null;
    if (!scope) {
      record("SKIP", "INV-3 holds for CLI builtins (PreToolUse hook wired)", "no session column to join on");
    } else {
      // The hook posts the RAW builtin ({tool:"Bash"}), but the gateway
      // TRANSLATES it server-side (T30 §9) before writing the row, so the audit
      // trail carries ACOS verbs (terminal.run, fs.read) and never the CLI's
      // own tool names. The marker the gateway stamps is what identifies them.
      const builtins = hasColumn("tool_invocations", "result_summary")
        ? sql(
            `select tool_name, count(*) from tool_invocations where ${scope} and result_summary like '%executed by the CLI%' group by tool_name`,
          ).map((r) => r.split("|")[0])
        : [];
      const all = sql(`select tool_name, count(*) from tool_invocations where ${scope} group by tool_name`).map(
        (r) => r.split("|")[0],
      );
      record(
        builtins.length > 0 ? "PASS" : "FAIL",
        "INV-3 holds for CLI builtins (PreToolUse hook wired)",
        builtins.length > 0
          ? `${builtins.join(", ")} carry the gateway's builtin marker (of ${all.length} audited verb kind(s))`
          : `no row carries the builtin marker - the hook never fired (saw: ${all.join(", ") || "nothing"})`,
      );
    }
  }

  // ---- 3b. the turn's model calls are tagged as CLI -----------------------
  if (!agentSessionId) {
    record("SKIP", "model calls are attributed to this session", "no agent session to scope the rows to");
  } else if (!hasColumn("llm_calls", "agent_session_id")) {
    record("SKIP", "model calls are attributed to this session", "no llm_calls.agent_session_id");
  } else {
    // Kevin's activity writes one llm_calls row per broker request, tagged
    // runtime='cli'. Assert the tag too: rows without it mean the turn went
    // through the old API-call path even though the PTY looked right.
    const count = Number(
      sql(`select count(*) from llm_calls where agent_session_id::text = '${agentSessionId}'`)[0] ?? "0",
    );
    const cliTagged = Number(
      sql(
        `select count(*) from llm_calls where agent_session_id::text = '${agentSessionId}' and context_telemetry->>'runtime' = 'cli'`,
      )[0] ?? "0",
    );
    record(
      count > 0 && cliTagged === count ? "PASS" : "FAIL",
      "model calls are attributed to this session and tagged runtime=cli",
      count === 0
        ? (() => {
            // "No ledger rows" has two very different causes and the message
            // must say which: nothing ran, or something ran and was not
            // recorded. agent_sessions carries the broker's metered totals, so
            // it settles the question without a broker surface.
            const metered = Number(
              sql(
                `select coalesce(tokens_in,0) + coalesce(tokens_out,0) from agent_sessions where id::text = '${agentSessionId}'`,
              )[0] ?? "0",
            );
            return metered > 0
              ? `the broker metered ${metered} token(s) for this session but the ledger has no row - the turn ran and went unrecorded`
              : "no llm_calls rows and nothing metered - the turn never reached the broker";
          })()
        : `${cliTagged}/${count} row(s) tagged runtime='cli'`,
    );

    // The broker meters per session and the activity mirrors its request count
    // into agent_sessions — so the two can be compared without a broker
    // surface. A mismatch means requests happened that nothing accounted for.
    if (!hasColumn("agent_sessions", "steps_count")) {
      record("SKIP", "session accounting matches the broker", "no agent_sessions.steps_count");
    } else {
      const steps = Number(
        sql(`select steps_count from agent_sessions where id::text = '${agentSessionId}'`)[0] ?? "-1",
      );
      record(
        steps === count ? "PASS" : "FAIL",
        "session accounting matches the broker",
        `agent_sessions.steps_count=${steps} vs ${count} metered request(s)`,
      );
    }
  }

  // ---- 4. it never held the key (INV-2 / S2) ------------------------------
  // The subscription credential lives in exactly one process - the broker. The
  // container gets a revocable per-session token and nothing else. This is the
  // assert that must NEVER be softened.
  //
  // Two corrections learned from a real run: check the workspace THIS session
  // ran in (container name = acos-ws-<workspaceId>) rather than whichever
  // workspace container happened to be listed first, and read the container's
  // Config.Env - the per-session token is injected into the exec env
  // (docker exec -e), so it is absent from Config.Env BY DESIGN. Its absence
  // there is the stronger property, not a finding.
  const workspace = session.workspaceId ? `acos-ws-${session.workspaceId}` : null;
  const configEnv = workspace
    ? sh("docker", ["inspect", "--format", "{{json .Config.Env}}", workspace])
    : "";
  if (!workspace || !configEnv.trim()) {
    record("SKIP", "no subscription credential inside the container (INV-2/S2)", workspace ? `${workspace} is gone (workspace torn down)` : "session carries no workspace id");
  } else {
    const leaked = [];
    if (/sk-ant-/.test(configEnv)) leaked.push("sk-ant- key material");
    if (/"INTERNAL_API_TOKEN=/.test(configEnv)) leaked.push("INTERNAL_API_TOKEN");
    if (/"CLAUDE_CODE_OAUTH_TOKEN=/.test(configEnv)) leaked.push("CLAUDE_CODE_OAUTH_TOKEN");
    record(
      leaked.length === 0 ? "PASS" : "FAIL",
      "no subscription credential inside the container (INV-2/S2)",
      leaked.length === 0
        ? `${workspace} Config.Env carries no key material`
        : `LEAKED: ${leaked.join(", ")} in ${workspace}`,
    );
    // Live-only, best effort: while a session is running its exec env should
    // carry a brokered acos-sess-* token. A stopped container proves nothing
    // either way, so report it as such instead of failing the run.
    const execToken = sh("docker", ["exec", workspace, "sh", "-c", "echo $ANTHROPIC_AUTH_TOKEN"]).trim();
    if (execToken) {
      record(
        execToken.startsWith("acos-sess-") ? "PASS" : "FAIL",
        "the live session runs on a brokered token",
        execToken.startsWith("acos-sess-")
          ? "ANTHROPIC_AUTH_TOKEN is an acos-sess-* token"
          : "ANTHROPIC_AUTH_TOKEN is set but is NOT an acos-sess-* token",
      );
    } else {
      record("SKIP", "the live session runs on a brokered token", "no live exec env (session already ended)");
    }
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
