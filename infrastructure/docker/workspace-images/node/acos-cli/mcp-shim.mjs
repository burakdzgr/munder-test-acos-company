// ACOS MCP shim — a stdio MCP server the claude CLI spawns inside the
// workspace container. It holds NO logic of its own: `tools/list` is fetched
// from the Tool Gateway and `tools/call` is forwarded to it, so every ACOS
// action (create_task, delegate_task, agent_hire, complete_task, request_help,
// request_review, update_task_status, …) still runs through the gateway's
// policy/approval/audit path (ADR-022 §3, INV-3/INV-17). The control plane is
// not bypassed; it is the only thing this file can reach.
//
// Wire protocol: MCP over stdio — newline-delimited JSON-RPC 2.0 on
// stdin/stdout (stderr is free for diagnostics; the CLI shows it in debug).
//
// Env (runtime-injected): ACOS_GATEWAY_URL, ACOS_GATEWAY_TOKEN,
//   ACOS_MCP_TOOLS_PATH  (default /internal/v1/mcp/tools  → {tools:[{name,description,inputSchema}]})
//   ACOS_MCP_CALL_PATH   (default /internal/v1/mcp/call   ← {name,arguments} → {content:[...], isError?, turnEnded?})
// When Oscar's gateway ships a native streamable-HTTP MCP endpoint, mcp.json
// can point the CLI at it directly and this shim becomes unnecessary.
import { requestJson } from "./proxy-http.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const gateway = process.env.ACOS_GATEWAY_URL;
const token = process.env.ACOS_GATEWAY_TOKEN;
const toolsPath = process.env.ACOS_MCP_TOOLS_PATH || "/internal/v1/mcp/tools";
const callPath = process.env.ACOS_MCP_CALL_PATH || "/internal/v1/mcp/call";
const callTimeoutMs = Number(process.env.ACOS_MCP_CALL_TIMEOUT_MS || 120_000);

/** Frozen fallback (ADR-022 §3 list) used ONLY when the gateway has no tools endpoint yet. */
const FROZEN_TOOLS = [
  ["create_task", "Create a new ACOS task (subtask of your current task unless parentTaskId says otherwise)."],
  ["delegate_task", "Delegate a task to a direct report; the Scheduler picks the assignee unless toAgentId is given."],
  ["agent_hire", "Request a hire into your team (Founder approval is enforced by the control plane)."],
  ["complete_task", "Mark your current task complete with a result summary. Ends this session."],
  ["request_help", "Ask your manager for help/clarification on the current task. Ends this session turn."],
  ["request_review", "Submit the current task for review (reviewer != author is enforced)."],
  ["update_task_status", "Move the current task through its allowed state machine transitions."],
].map(([name, description]) => ({
  name,
  description,
  inputSchema: { type: "object", additionalProperties: true },
}));

const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const diag = (msg, meta) => process.stderr.write(JSON.stringify({ shim: msg, ...(meta ?? {}) }) + "\n");
const result = (id, r) => out({ jsonrpc: "2.0", id, result: r });
const rpcError = (id, code, message, data) => out({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

async function gatewayTools() {
  if (!gateway || !token) return FROZEN_TOOLS;
  try {
    const res = await requestJson("GET", new URL(toolsPath, gateway).href, {
      headers: { authorization: `Bearer ${token}` },
      timeoutMs: 15_000,
    });
    if (res.status === 200 && res.body && Array.isArray(res.body.tools)) return res.body.tools;
    diag("tools endpoint unavailable, using frozen list", { status: res.status });
  } catch (err) {
    diag("tools endpoint unreachable, using frozen list", { error: err.message });
  }
  return FROZEN_TOOLS;
}

async function gatewayCall(name, args) {
  if (!gateway || !token) {
    return { content: [{ type: "text", text: "ACOS gateway not configured for this session (ACOS_GATEWAY_URL/TOKEN missing)." }], isError: true };
  }
  const res = await requestJson("POST", new URL(callPath, gateway).href, {
    headers: { authorization: `Bearer ${token}` },
    body: { name, arguments: args ?? {} },
    timeoutMs: callTimeoutMs,
  });
  if (res.status >= 200 && res.status < 300 && res.body && typeof res.body === "object") {
    // Gateway may answer MCP-shaped {content,isError} or plain {ok,result,error}
    if (Array.isArray(res.body.content)) return res.body;
    const text = res.body.error ? String(res.body.error.message ?? res.body.error) : JSON.stringify(res.body.result ?? res.body);
    return { content: [{ type: "text", text }], isError: Boolean(res.body.error) || res.body.ok === false };
  }
  const msg = typeof res.body === "object" && res.body ? res.body.message || res.body.code || JSON.stringify(res.body) : String(res.body);
  return { content: [{ type: "text", text: `Tool Gateway refused ${name} (HTTP ${res.status}): ${msg}` }], isError: true };
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case "initialize":
        return result(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "acos-tool-gateway", version: "0.1.0" },
          instructions:
            "These tools are your ONLY way to act on the company (tasks, delegation, hiring, review, completion). " +
            "Call complete_task when your task is done; call request_help when blocked.",
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return; // no reply to notifications
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, { tools: await gatewayTools() });
      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string") return rpcError(id, -32602, "tools/call needs params.name");
        const r = await gatewayCall(name, params?.arguments);
        return result(id, { content: r.content, isError: Boolean(r.isError) });
      }
      case "resources/list":
        return result(id, { resources: [] });
      case "prompts/list":
        return result(id, { prompts: [] });
      default:
        if (isNotification) return;
        return rpcError(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    if (!isNotification) rpcError(id, -32000, `shim failure: ${err.message}`);
    diag("handler error", { method, error: err.message });
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
      rpcError(null, -32700, "parse error");
      continue;
    }
    void handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
