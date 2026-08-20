// INV-3 (S3) inside a live Claude Code session — ADR-022 "wrap" route.
//
// Claude Code PreToolUse hook: runs BEFORE every built-in tool the CLI wants to
// execute inside the workspace (Bash/Read/Edit/Write/Glob/Grep/…). It reports
// the call to the Tool Gateway's builtin-audit endpoint, which writes the
// `tool_invocations` row and answers allow/deny. FAIL-CLOSED: if the gateway is
// unreachable, errors, or says no, the tool does not run. There is no flag to
// turn the deny into a warning; a session without a gateway is not a session.
//
// Protocol (Claude Code hooks): JSON on stdin; exit 0 = allow; JSON on stdout
// with hookSpecificOutput.permissionDecision = "deny" (+ exit 0) = blocked with
// the reason shown to the model; exit 2 = blocked with stderr as the reason.
//
// Env (injected by the runtime at session start, see run-session.sh):
//   ACOS_GATEWAY_URL     e.g. http://server:3000  (via egress proxy)
//   ACOS_GATEWAY_TOKEN   per-session bearer minted by the control plane
//   ACOS_AUDIT_PATH      default /internal/v1/agent-sessions/builtin-audit
import { requestJson } from "./proxy-http.mjs";

const MAX_INPUT_BYTES = 64 * 1024; // the gateway stores a bounded copy; the CLI keeps the rest

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    }),
  );
  process.exit(0);
}

function truncate(input) {
  const s = JSON.stringify(input ?? {});
  if (Buffer.byteLength(s) <= MAX_INPUT_BYTES) return input ?? {};
  return { _truncated: true, preview: s.slice(0, MAX_INPUT_BYTES) };
}

const raw = await readStdin();
let event;
try {
  event = JSON.parse(raw || "{}");
} catch {
  deny("acos audit hook: unparseable hook payload");
}

const gateway = process.env.ACOS_GATEWAY_URL;
const token = process.env.ACOS_GATEWAY_TOKEN;
if (!gateway || !token) deny("acos audit hook: ACOS_GATEWAY_URL/ACOS_GATEWAY_TOKEN missing — builtin tools are disabled without the Tool Gateway (INV-3)");

const path = process.env.ACOS_AUDIT_PATH || "/internal/v1/agent-sessions/builtin-audit";
const body = {
  cliSessionId: event.session_id ?? null,
  toolName: event.tool_name ?? "unknown",
  toolInput: truncate(event.tool_input),
  cwd: event.cwd ?? null,
  transcriptPath: event.transcript_path ?? null,
};

let res;
try {
  res = await requestJson("POST", new URL(path, gateway).href, {
    headers: { authorization: `Bearer ${token}` },
    body,
    timeoutMs: Number(process.env.ACOS_AUDIT_TIMEOUT_MS || 10_000),
  });
} catch (err) {
  deny(`acos audit hook: Tool Gateway unreachable (${err.message}) — fail-closed (INV-3)`);
}

if (res.status < 200 || res.status >= 300) {
  const msg = typeof res.body === "object" && res.body ? res.body.message || res.body.code || JSON.stringify(res.body) : String(res.body);
  deny(`acos audit hook: Tool Gateway refused the audit (HTTP ${res.status}: ${msg}) — fail-closed (INV-3)`);
}
if (!res.body || res.body.allow !== true) {
  deny(`acos audit hook: denied by Tool Gateway${res.body?.reason ? ` — ${res.body.reason}` : ""}`);
}
process.exit(0); // allowed — the tool_invocations row exists before the tool runs
