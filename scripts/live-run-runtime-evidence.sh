#!/bin/sh
# E4 live workload run — RUNTIME evidence collector (4a / 4b / 4d / 4e + INV-2 scan).
# Companion of E4-LIVE-RUN-RUNTIME-EVIDENCE.md. Read-only: psql via compose, docker inspect/exec, curl.
#
# Usage (during the run, from the repo root of the stack's checkout):
#   ACOS_E2E_PROJECT=<compose project> COMPANY_ID=<uuid> RUN_START='2026-08-21T12:00:00Z' \
#   ACOS_BROKER_SECRET=<secret> [BROKER_URL=http://127.0.0.1:3779] [OUT=./evidence] \
#   sh live-run-runtime-evidence.sh watch    # loop (default 20s, WATCH_INTERVAL) snapshot live sessions: 4b transcript + 4e environ + prompt
#   sh live-run-runtime-evidence.sh report   # at the end: 4a/4b/4d/4e + INV-2 scan → PASS/FAIL/SKIP
set -u
: "${ACOS_E2E_PROJECT:?}" "${COMPANY_ID:?}" "${RUN_START:?}"
BROKER_URL=${BROKER_URL:-http://127.0.0.1:3779}
OUT=${OUT:-./evidence}; mkdir -p "$OUT"
MODE=${1:-report}
SECRET_RE='INTERNAL_API_TOKEN=|CLAUDE_CODE_OAUTH_TOKEN=|ANTHROPIC_API_KEY=|ACOS_BROKER_SECRET=|sk-ant-|acos_pat_|ghp_|github_pat_'

# psql does NOT interpolate :'var' inside a -c string; the variable is set but
# never substituted, so every query using :'company' died with `syntax error at
# or near ":"` — and the callers below then read the empty output as a clean
# result (4c printed PASS and FAIL for the same query). Feeding the statement on
# stdin makes interpolation work; verified against a live stack.
sql() { printf '%s\n' "$1" | docker compose -p "$ACOS_E2E_PROJECT" exec -T postgres \
          psql -U acos -d acos -At -F '|' -v ON_ERROR_STOP=1 \
          -v company="$COMPANY_ID" -v run_start="$RUN_START"; }
say() { printf '%s\n' "$*"; }
verdict() { # verdict PASS|FAIL|SKIP claim detail
  # `return 0` is load-bearing: the last command is a test that FAILS for a PASS
  # verdict, so the function exited non-zero and every `verdict PASS || verdict FAIL`
  # call site printed BOTH lines — a green and a red for the same query.
  printf '  [%s] %s — %s\n' "$1" "$2" "$3"; [ "$1" = FAIL ] && FAILS=$((FAILS+1)); return 0; }
FAILS=0

CLI_SESSIONS_SQL="select s.id, s.agent_id, coalesce(s.task_id::text,''), s.status, coalesce(s.ended_at::text,'') \
  from agent_sessions s where s.company_id = :'company' and s.started_at >= :'run_start' \
   and exists (select 1 from llm_calls l where l.agent_session_id = s.id and l.context_telemetry->>'runtime'='cli') order by s.started_at"

workspace_for() { # workspace_for <agent_id> <task_id> → workspaces.id (live) or empty
  sql "select id from workspaces where company_id = :'company' and agent_id = '$1' and task_id = '$2' and destroyed_at is null order by created_at desc limit 1"
}

# Capture is NO-CLOBBER: a container reaped between ticks makes `docker exec`
# return empty; we must never overwrite a good earlier capture with an empty
# one. Write to a temp and promote it only when it has content (or when nothing
# was captured before). tmpfs means the transcript is gone once the container is
# reaped, so the FIRST non-empty capture per session is the one that counts.
keep_nonempty() { # keep_nonempty <tmp> <dest>
  if [ -s "$1" ]; then mv -f "$1" "$2"; elif [ ! -f "$2" ]; then mv -f "$1" "$2"; else rm -f "$1"; fi
}
snapshot_session() { # snapshot_session <session_id> <agent_id> <task_id>
  sid=$1; ws=$(workspace_for "$2" "$3"); [ -z "$ws" ] && return 0
  c="acos-ws-$ws"
  docker inspect --format '{{json .Config.Env}}' "$c" > "$OUT/$sid.configenv.tmp" 2>/dev/null && keep_nonempty "$OUT/$sid.configenv.tmp" "$OUT/$sid.configenv.json" || rm -f "$OUT/$sid.configenv.tmp"
  # 4e — the exec'd session process environ; redact the capability token.
  # T52: a CLI turn is one short-lived `claude` process, so by a 20s snapshot
  # tick the session.pid process is often already reaped (environ 0 lines). Prefer
  # the pid file, but fall back to any live `claude` proc in the container so a
  # still-running turn is captured instead of silently SKIP'd.
  docker exec "$c" sh -c 'p=$(cat /home/node/.acos/session.pid 2>/dev/null); case "$(cat /proc/$p/comm 2>/dev/null)" in claude|node) ;; *) p="";; esac; [ -n "$p" ] || for d in /proc/[0-9]*; do case "$(cat "$d/comm" 2>/dev/null)" in claude) p=${d#/proc/}; break;; esac; done; [ -n "$p" ] && tr "\0" "\n" < /proc/$p/environ' 2>/dev/null \
    | sed -E 's/=(acos-sess-)[A-Za-z0-9_-]+/=\1<redacted>/' > "$OUT/$sid.environ.tmp"; keep_nonempty "$OUT/$sid.environ.tmp" "$OUT/$sid.environ.txt"
  # INV-2 prompt side — the CLI brief travels as ACOS_PROMPT; capture it whole (NUL-delimited, single value) for the scan. Same pid fallback as 4e.
  docker exec "$c" sh -c 'p=$(cat /home/node/.acos/session.pid 2>/dev/null); case "$(cat /proc/$p/comm 2>/dev/null)" in claude|node) ;; *) p="";; esac; [ -n "$p" ] || for d in /proc/[0-9]*; do case "$(cat "$d/comm" 2>/dev/null)" in claude) p=${d#/proc/}; break;; esac; done; [ -n "$p" ] && awk -v RS="\0" -F= "/^ACOS_PROMPT=/{print substr(\$0,13)}" /proc/$p/environ' 2>/dev/null > "$OUT/$sid.prompt.tmp"; keep_nonempty "$OUT/$sid.prompt.tmp" "$OUT/$sid.prompt.txt"
  # 4b — the CLI's own transcript: every tool_use by name (tmpfs — take it while the container lives)
  docker exec "$c" sh -c 'cat /home/node/.claude/projects/*/*.jsonl 2>/dev/null' \
    | grep -o '"type":"tool_use","id":"[^"]*","name":"[A-Za-z_]*"' | sed 's/.*"name":"//; s/"$//' | sort | uniq -c > "$OUT/$sid.tooluse.tmp"; keep_nonempty "$OUT/$sid.tooluse.tmp" "$OUT/$sid.tooluse.txt"
  say "snapshot $sid ($c): environ $(wc -l < "$OUT/$sid.environ.txt" 2>/dev/null || echo 0) lines, tool_use $(awk '{s+=$1} END{print s+0}' "$OUT/$sid.tooluse.txt" 2>/dev/null || echo 0)"
}

if [ "$MODE" = watch ]; then
  # Sessions can be short (per-company cap 3 → fast serial turns), so the loop
  # runs tight (default 20 s) to guarantee at least one capture per session
  # before its container is reaped. Override with WATCH_INTERVAL for slower hosts.
  iv=${WATCH_INTERVAL:-20}
  say "watching company $COMPANY_ID since $RUN_START every ${iv}s (Ctrl-C to stop)"
  while :; do
    sql "$CLI_SESSIONS_SQL" | while IFS='|' read -r sid aid tid status ended; do
      [ -n "$sid" ] && snapshot_session "$sid" "$aid" "$tid"
    done
    sleep "$iv"
  done
fi

# ─────────────────────────────── report ───────────────────────────────
say "== S0 CLI sessions"; sql "$CLI_SESSIONS_SQL" | tee "$OUT/s0.sessions.txt"
n=$(wc -l < "$OUT/s0.sessions.txt"); [ "$n" -ge 4 ] && verdict PASS "≥4 live CLI sessions in the run" "$n" || verdict FAIL "≥4 live CLI sessions in the run" "$n"

say "== 4a INV-3 audit rows per session"
sql "select s.id, s.agent_id, count(ti.*), count(*) filter (where ti.result_summary like 'builtin allowed%'), \
            count(*) filter (where ti.result_summary not like 'builtin allowed%' or ti.result_summary is null), \
            count(*) filter (where ti.decision='deny'), coalesce(string_agg(distinct ti.tool_name, ',' order by ti.tool_name),'') \
       from agent_sessions s left join tool_invocations ti on ti.agent_session_id = s.id \
      where s.company_id = :'company' and s.started_at >= :'run_start' \
        and exists (select 1 from llm_calls l where l.agent_session_id = s.id and l.context_telemetry->>'runtime'='cli') \
      group by s.id, s.agent_id order by min(s.started_at)" | tee "$OUT/4a.rows.txt"
# NON-EMPTY rule for 4a too (Jim caught it): on an empty company both checks
# below are trivially 0 and read as "checked and clean" — a vacuous PASS, the
# same trap the 4b/4c guards close. Gate on population: no CLI session in the
# window → NOTHING TO SCAN, and no tool_invocations → the UNMAPPED check has
# nothing to judge.
n_cli=$(printf '%s' "$(wc -l < "$OUT/s0.sessions.txt")" | tr -d ' ')
n_ti=$(sql "select count(*) from tool_invocations where company_id = :'company' and created_at >= :'run_start'")
if [ "${n_ti:-0}" -eq 0 ]; then
  verdict SKIP "builtin audit rows canonical, no UNMAPPED_BUILTIN" "NOTHING TO SCAN: 0 tool_invocations in the window"
else
  um=$(sql "select count(*) filter (where decision_reason like 'UNMAPPED_BUILTIN%') || '|' || count(*) filter (where result_summary like 'builtin allowed%' and tool_name not in ('terminal.run','fs.read','fs.edit','fs.write','fs.search')) from tool_invocations where company_id = :'company' and created_at >= :'run_start'")
  [ "$um" = "0|0" ] && verdict PASS "builtin audit rows canonical, no UNMAPPED_BUILTIN" "$um" || verdict FAIL "builtin audit rows canonical, no UNMAPPED_BUILTIN" "$um"
fi
if [ "${n_cli:-0}" -eq 0 ]; then
  verdict SKIP "no CLI session without any audited tool or Family-B effect" "NOTHING TO SCAN: 0 CLI sessions in the window"
else
  orph=$(sql "select count(*) from agent_sessions s where s.company_id = :'company' and s.started_at >= :'run_start' \
     and exists (select 1 from llm_calls l where l.agent_session_id = s.id and l.context_telemetry->>'runtime'='cli') \
     and not exists (select 1 from tool_invocations ti where ti.agent_session_id = s.id) \
     and not exists (select 1 from events e where e.company_id = s.company_id and e.agent_id = s.agent_id and e.occurred_at between s.started_at and coalesce(s.ended_at, now()) \
          and e.type in ('task.created','task.delegated','task.status.changed','agent.help.requested','review.requested','agent.escalated','decision.recorded','agent.message.sent'))")
  [ "$orph" = "0" ] && verdict PASS "no CLI session without any audited tool or Family-B effect" "0" || verdict FAIL "sessions with neither audit rows nor Family-B events (work did not progress?)" "$orph"
fi

say "== 4b bypass guard: transcript tool_use vs audit rows (per CLI session)"
# NON-EMPTY rule (Oscar's vacuum guard): iterate EVERY CLI session (from S0),
# not just the transcripts that happen to exist. A session whose transcript was
# NOT captured (missed by watch, reaped before the first tick, tmpfs gone) has
# nothing to compare — that is a coverage GAP, reported NOTHING-TO-SCAN, NEVER a
# silent PASS. "no bypass found" and "nothing was scanned" are different verdicts.
BUILTINS='Bash|Read|Edit|MultiEdit|Write|NotebookEdit|Glob|Grep'
FAMILY_B='create_task|delegate_task|update_task_status|request_review|request_help|escalate|record_decision|complete_task|send_message'
while IFS='|' read -r sid aid tid status ended; do
  [ -n "$sid" ] || continue
  f="$OUT/$sid.tooluse.txt"
  if [ ! -s "$f" ]; then
    verdict SKIP "4b $sid" "NOTHING TO SCAN: session transcript not captured — 4b cannot vouch for this session (run watch tighter / confirm the container lived long enough)"
    continue
  fi
  tu_builtin=$(grep -E " ($BUILTINS)$" "$f" | awk '{s+=$1} END{print s+0}')
  tu_gateway=$(grep -E ' mcp__' "$f" | grep -Ev "__($FAMILY_B)$" | awk '{s+=$1} END{print s+0}')
  tu_disallowed=$(grep -E ' (WebFetch|WebSearch|Agent|Workflow)$' "$f" | awk '{s+=$1} END{print s+0}')
  row=$(grep "^$sid|" "$OUT/4a.rows.txt" || true)
  rows_builtin=$(printf '%s' "$row" | cut -d'|' -f4); rows_gateway=$(printf '%s' "$row" | cut -d'|' -f5); denied=$(printf '%s' "$row" | cut -d'|' -f6)
  if [ "$tu_builtin" -eq $(( ${rows_builtin:-0} + ${denied:-0} )) ] && [ "$tu_gateway" -eq "${rows_gateway:-0}" ] && [ "$tu_disallowed" -eq 0 ]; then
    verdict PASS "4b $sid" "builtin tool_use=$tu_builtin rows=$rows_builtin(+$denied denied), gateway tool_use=$tu_gateway rows=$rows_gateway, disallowed=0"
  else
    verdict FAIL "4b $sid" "builtin tool_use=$tu_builtin vs rows=$rows_builtin(+$denied), gateway $tu_gateway vs $rows_gateway, disallowed=$tu_disallowed"
  fi
done < "$OUT/s0.sessions.txt"

say "== 4d metering"
# T52: coalesce the sums so a 0-row window yields "0|0|0|0" (not "0|0||"), and
# guard on the row count — an empty window is a coverage GAP (NOTHING-TO-SCAN),
# never a vacuous PASS on "0 orphans" / "0 inconsistent" over an empty set.
d1=$(sql "select count(*) || '|' || count(*) filter (where agent_session_id is null) || '|' || coalesce(sum(tokens_in),0) || '|' || coalesce(sum(tokens_out),0) from llm_calls where company_id = :'company' and created_at >= :'run_start' and context_telemetry->>'runtime'='cli'")
say "  llm_calls(cli): rows|orphan|tokens_in|tokens_out = $d1"
if [ "$(printf '%s' "$d1" | cut -d'|' -f1)" = "0" ]; then
  verdict SKIP "4d metering" "NOTHING TO SCAN: no CLI llm_calls rows in window (no session produced metered traffic)"
else
  [ "$(printf '%s' "$d1" | cut -d'|' -f2)" = "0" ] && verdict PASS "every CLI llm_calls row is bound to an agent session" "$d1" || verdict FAIL "orphan CLI llm_calls rows" "$d1"
  incons=$(sql "select count(*) from (select s.id, (s.steps_count = count(l.*) and s.tokens_in = coalesce(sum(l.tokens_in),0) and s.tokens_out = coalesce(sum(l.tokens_out),0)) as ok \
     from agent_sessions s join llm_calls l on l.agent_session_id = s.id and l.context_telemetry->>'runtime'='cli' \
    where s.company_id = :'company' and s.started_at >= :'run_start' group by s.id) x where not ok")
  [ "$incons" = "0" ] && verdict PASS "agent_sessions roll-up == Σ llm_calls and steps_count == request count" "0 inconsistent" || verdict FAIL "session roll-up inconsistent" "$incons session(s)"
fi
say "  note: cost_cents is 0 for CLI rows BY DESIGN (claude-cli pricing = T5 open card); metering is token-based"
if [ -n "${ACOS_BROKER_SECRET:-}" ]; then
  curl -s -m 5 -H "authorization: Bearer $ACOS_BROKER_SECRET" "$BROKER_URL/internal/v1/sessions" > "$OUT/broker.sessions.json" \
    && node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);let live=0;for(const s of j.sessions){if(!s.revokedAt)live++;console.log("  broker",s.sessionId,s.agentId,"req="+s.requestCount,"in="+s.totals.inputTokens,"out="+s.totals.outputTokens,s.revokedAt?"revoked":"LIVE")}console.log("  broker live sessions:",live)})' < "$OUT/broker.sessions.json"
  say "  compare req/in/out with steps_count/tokens_in/tokens_out above (S0); after the run: 0 LIVE"
else
  verdict SKIP "broker session list" "ACOS_BROKER_SECRET not set"
fi

say "== 4e INV-2 container env + INV-2 prompt (per CLI session)"
# Same NON-EMPTY rule as 4b: iterate EVERY CLI session; a session whose environ
# was not captured is NOTHING-TO-SCAN, never a silent PASS.
while IFS='|' read -r sid aid tid status ended; do
  [ -n "$sid" ] || continue
  f="$OUT/$sid.environ.txt"
  if [ ! -s "$f" ]; then
    verdict SKIP "4e $sid" "NOTHING TO SCAN: session process env not captured (session not live at any snapshot tick)"
  else
    leaks=$(grep -Ec "$SECRET_RE" "$f" "$OUT/$sid.configenv.json" 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')
    tok=$(grep -c '^ANTHROPIC_AUTH_TOKEN=acos-sess-' "$f")
    if [ "$leaks" -eq 0 ] && [ "$tok" -eq 1 ]; then verdict PASS "4e $sid" "brokered acos-sess token only; 0 credential patterns (environ + Config.Env)"
    else verdict FAIL "4e $sid" "leak patterns=$leaks brokered-token=$tok"; fi
  fi
  # INV-2 prompt side: the captured ACOS_PROMPT (CLI brief) carries no credential pattern
  pf="$OUT/$sid.prompt.txt"
  if [ -s "$pf" ]; then
    phits=$(grep -Ec "$SECRET_RE" "$pf")
    [ "$phits" -eq 0 ] && verdict PASS "INV-2 prompt $sid" "CLI brief carries no token/PAT pattern ($(wc -c < "$pf") bytes)" \
      || verdict FAIL "INV-2 prompt $sid" "$phits credential pattern(s) in the CLI brief"
  else
    verdict SKIP "INV-2 prompt $sid" "NOTHING TO SCAN: ACOS_PROMPT not captured (session not live at any snapshot tick)"
  fi
done < "$OUT/s0.sessions.txt"

say "== 4c INV-2 content scan (server-side surfaces; CLI prompts are never stored server-side)"
sql "with pat as (select '(INTERNAL_API_TOKEN=|ACOS_BROKER_SECRET=|CLAUDE_CODE_OAUTH_TOKEN=|sk-ant-[A-Za-z0-9_-]{8,}|acos_pat_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})' as re) \
 select 'tool_invocations.input', count(*) filter (where input::text ~ pat.re), count(*) from tool_invocations, pat where company_id=:'company' and created_at>=:'run_start' \
 union all select 'agent_steps', count(*) filter (where action::text ~ pat.re or observation::text ~ pat.re), count(*) from agent_steps, pat where company_id=:'company' and created_at>=:'run_start' \
 union all select 'messages', count(*) filter (where body ~ pat.re), count(*) from messages, pat where company_id=:'company' and created_at>=:'run_start' \
 union all select 'events.payload', count(*) filter (where payload::text ~ pat.re), count(*) from events, pat where company_id=:'company' and occurred_at>=:'run_start' \
 union all select 'artifacts', count(*) filter (where coalesce(content_md,'') ~ pat.re), count(*) from artifacts, pat where company_id=:'company' and created_at>=:'run_start'" | tee "$OUT/4c.scan.txt"
# A failed query writes nothing, and "no rows" summed to 0 hits — i.e. a broken
# scan reported "no credential pattern found". Require the five expected surface
# rows before believing a zero.
rows=$(grep -c '|' "$OUT/4c.scan.txt" 2>/dev/null || echo 0)
hits=$(awk -F'|' '{s+=$2} END{print s+0}' "$OUT/4c.scan.txt")
# "0 hits" over an EMPTY population is not a clean bill of health, it is an
# unrun test. Count the rows that were actually scanned and say so.
scanned=$(awk -F'|' '{s+=$3} END{print s+0}' "$OUT/4c.scan.txt")
if [ "$rows" -lt 5 ]; then verdict FAIL "INV-2 content scan did not run" "only $rows surface row(s) returned — the query errored; a zero here would be meaningless"
elif [ "$scanned" = "0" ]; then verdict SKIP "INV-2 content scan had nothing to scan" "5 surfaces queried, 0 rows in the window — NOTHING TO SCAN, not a clean result"
elif [ "$hits" = "0" ]; then verdict PASS "no credential pattern in DB surfaces" "0 hits across $scanned scanned row(s) on $rows surfaces"
else verdict FAIL "credential pattern hits in DB surfaces" "$hits"; fi

say ""; say "runtime evidence: $FAILS FAIL(s); artifacts in $OUT"
exit $([ "$FAILS" -eq 0 ] && echo 0 || echo 2)
