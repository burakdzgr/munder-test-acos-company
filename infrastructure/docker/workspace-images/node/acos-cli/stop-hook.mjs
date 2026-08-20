// Claude Code Stop hook: fires when the assistant finishes a response (the
// CLI goes idle waiting for the next human turn). The runtime uses this as
// the "turn ended" signal: it tells the Tool Gateway the session is idle so the
// worker can decide to close the PTY session (task completed via MCP, or budget
// exhausted, or nothing left to do) instead of letting an idle `claude` sit in
// the container forever. Best-effort: a failure here never blocks the CLI.
//
// Env: ACOS_GATEWAY_URL, ACOS_GATEWAY_TOKEN, ACOS_TURN_ENDED_PATH
//   (default /internal/v1/agent-sessions/turn-ended)
import { requestJson } from "./proxy-http.mjs";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
let event = {};
try {
  event = JSON.parse(raw || "{}");
} catch {
  /* ignore */
}

const gateway = process.env.ACOS_GATEWAY_URL;
const token = process.env.ACOS_GATEWAY_TOKEN;
if (gateway && token) {
  const path = process.env.ACOS_TURN_ENDED_PATH || "/internal/v1/agent-sessions/turn-ended";
  try {
    await requestJson("POST", new URL(path, gateway).href, {
      headers: { authorization: `Bearer ${token}` },
      body: {
        cliSessionId: event.session_id ?? null,
        stopHookActive: Boolean(event.stop_hook_active),
        transcriptPath: event.transcript_path ?? null,
      },
      timeoutMs: 5_000,
    });
  } catch {
    /* best-effort */
  }
}
process.exit(0);
