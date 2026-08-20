# /opt/acos/cli — the in-container Claude Code kit (ADR-022, T31)

Baked read-only (root-owned) into `acos/workspace-node`. The workspace user
(uid 1000) can run it, never change it.

| File | Role |
|---|---|
| `run-session.sh` | Session entry. sandbox-manager execs this as the PTY's process with the runtime-injected env (broker URL + session token, gateway URL + token, model, prompt). Refuses to start without a brokered identity. |
| `settings.json` | `--settings`: permission split (bypass inside the box, deny list for tools that must not exist), PreToolUse audit hook, Stop hook, telemetry/autoupdate off. |
| `mcp.json` | `--mcp-config` + `--strict-mcp-config`: the ACOS Tool Gateway is the only MCP server. |
| `mcp-shim.mjs` | stdio MCP server → Tool Gateway HTTP (`tools/list` fetched, `tools/call` forwarded). No logic of its own. |
| `audit-hook.mjs` | INV-3: every builtin tool call is reported to the gateway **before** it runs; fail-closed. |
| `stop-hook.mjs` | "turn ended" signal to the gateway so the runtime can close idle sessions. Best-effort. |
| `proxy-http.mjs` | http JSON client that honours `HTTP_PROXY` (workspaces have no default route). |

Identity: the container holds **only** `ANTHROPIC_AUTH_TOKEN=acos-sess-…` (revocable,
budgeted) and `ANTHROPIC_BASE_URL=<identity-broker>`. The subscription credential
lives in `services/identity-broker` on the host (INV-2).
