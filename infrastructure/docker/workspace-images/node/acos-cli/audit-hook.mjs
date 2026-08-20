// INV-3 (S3) inside a live Claude Code session — ADR-022 "wrap" route, T30 §9.
//
// Claude Code PreToolUse hook: runs BEFORE every built-in tool the CLI wants to
// execute inside the workspace (Bash/Read/Edit/Write/Glob/Grep/…). It asks the
// Tool Gateway's builtin audit+policy endpoint, which writes the
// `tool_invocations` row and answers allow/deny (name+argument translation is
// the GATEWAY's job — we send Claude Code's raw tool name and raw input so the
// mapping lives in exactly one place). FAIL-CLOSED: unreachable gateway, non-2xx,
// allow!==true, or requiresApproval → the tool does not run. There is no flag to
// turn the deny into a warning; a session without a gateway is not a session.
//
// Protocol (Claude Code hooks): JSON on stdin; exit 0 = allow; JSON on stdout
// with hookSpecificOutput.permissionDecision = "deny" (+ exit 0) = blocked with
// the reason shown to the model.
//
// Env (injected by the runtime at session start, see run-session.sh):
//   ACOS_GATEWAY_URL     server origin the container can reach, e.g. http://server:3000 (via egress proxy)
//   ACOS_GATEWAY_TOKEN   per-session bearer minted by the control plane (T30 §1.1)
//   ACOS_AUDIT_PATH      default /internal/v1/tool-invocations/builtin
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

function bounded(input) {
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

const path = process.env.ACOS_AUDIT_PATH || "/internal/v1/tool-invocations/builtin";
const body = {
  tool: event.tool_name ?? "unknown",
  input: bounded(event.tool_input),
  // forensics only — the gateway derives identity from the bearer, never from the body
  cliSessionId: event.session_id ?? null,
  cwd: event.cwd ?? null,
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

if (res.status === 409) deny("acos audit hook: this task is closed — stop working and end the session");
if (res.status < 200 || res.status >= 300) {
  const msg = typeof res.body === "object" && res.body ? res.body.message || res.body.reason || res.body.code || JSON.stringify(res.body) : String(res.body);
  deny(`acos audit hook: Tool Gateway refused the audit (HTTP ${res.status}: ${msg}) — fail-closed (INV-3)`);
}
if (!res.body || typeof res.body !== "object") deny("acos audit hook: empty gateway answer — fail-closed (INV-3)");
if (res.body.requiresApproval === true) {
  deny(`acos audit hook: this action needs ${res.body.approver ?? "human"} approval — use the acos escalate tool instead of running it directly`);
}
if (res.body.allow !== true) {
  deny(`acos audit hook: denied by Tool Gateway${res.body.reason ? ` — ${res.body.reason}` : ""}`);
}
process.exit(0); // allowed — the tool_invocations row exists before the tool runs
