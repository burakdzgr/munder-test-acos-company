// ACOS MCP stdio↔HTTP bridge (fallback transport). The Tool Gateway speaks
// streamable-HTTP MCP at `mcpUrl` (T30 contract §1: JSON-RPC 2.0 over POST).
// The claude CLI normally talks to it directly (`type: "http"` in mcp.json);
// this shim exists for the case where the CLI's own HTTP client cannot use the
// workspace's egress proxy — it forwards every JSON-RPC message unchanged over
// the proxy-aware client and writes the reply back. It holds NO tool logic and
// no identity beyond the session bearer: it cannot widen anything.
//
// Env: ACOS_MCP_URL (e.g. http://server:3000/mcp/v1), ACOS_GATEWAY_TOKEN (session token)
import { requestJson } from "./proxy-http.mjs";

const url = process.env.ACOS_MCP_URL;
const token = process.env.ACOS_GATEWAY_TOKEN;
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const diag = (msg, meta) => process.stderr.write(JSON.stringify({ shim: msg, ...(meta ?? {}) }) + "\n");

if (!url || !token) {
  diag("ACOS_MCP_URL/ACOS_GATEWAY_TOKEN missing — gateway unreachable, every call will error");
}

async function forward(msg) {
  const isNotification = msg.id === undefined || msg.id === null;
  if (!url || !token) {
    if (!isNotification) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "ACOS gateway not configured for this session" } });
    return;
  }
  try {
    const res = await requestJson("POST", url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" },
      body: msg,
      timeoutMs: Number(process.env.ACOS_MCP_CALL_TIMEOUT_MS || 180_000),
    });
    if (isNotification) return; // 202 / no body expected
    if (res.status >= 200 && res.status < 300 && res.body && typeof res.body === "object") {
      out(res.body);
      return;
    }
    const code = res.status === 401 ? -32001 : res.status === 409 ? -32002 : -32000;
    const detail = typeof res.body === "object" && res.body ? res.body.message || res.body.code || JSON.stringify(res.body) : String(res.body);
    out({ jsonrpc: "2.0", id: msg.id, error: { code, message: `gateway HTTP ${res.status}: ${detail}` } });
  } catch (err) {
    if (!isNotification) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `gateway unreachable: ${err.message}` } });
    diag("forward failed", { method: msg.method, error: err.message });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    void forward(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
