#!/bin/sh
# ACOS agent session entry (ADR-022). Exec'd by sandbox-manager as THE process
# of the terminal_sessions PTY, so the human watches the real `claude` session.
#
# Contract (all injected by the runtime at exec time — nothing is read from disk
# except the read-only kit in /opt/acos/cli):
#   ANTHROPIC_BASE_URL    identity broker (host-side); ANTHROPIC_AUTH_TOKEN per-session capability token
#   ACOS_MCP_URL          Tool Gateway MCP endpoint the container can reach (T30 §1.1 mcpUrl, e.g. http://server:3000/mcp/v1)
#   ACOS_GATEWAY_TOKEN    per-session MCP bearer (T30 §1.1 sessionToken) — also used by the audit hook
#   ACOS_GATEWAY_URL      server origin for the audit hook (derived from ACOS_MCP_URL when unset)
#   ACOS_MCP_TRANSPORT    http (default: the CLI talks to the gateway directly) | stdio-bridge (via mcp-shim.mjs, proxy-aware)
#   ACOS_MODEL            optional model override (e.g. sonnet|opus|haiku|claude-…)
#   ACOS_PROMPT           initial prompt = the task brief (the runtime assembles it)
#   ACOS_PROMPT_FILE      alternative: path (inside the container) holding the brief
#   ACOS_SESSION_MODE     interactive (default, live TUI in the PTY) | print (non-TUI, for tests)
#   ACOS_EXTRA_ARGS       optional extra CLI args (space-separated, trusted — runtime-owned)
#
# Security posture is NOT configurable from here: settings are the baked
# read-only file, --strict-mcp-config pins the MCP set to the ACOS gateway, the
# PreToolUse hook audits every builtin (INV-3), and the only credentials present
# are the revocable session tokens (INV-2). INTERNAL_API_TOKEN never enters here.
set -eu

KIT=/opt/acos/cli
: "${HOME:=/home/node}"
export HOME
mkdir -p "$HOME/.claude" "$HOME/.acos"
# sandbox-manager endAgentSession escalates to SIGTERM on this pid; `exec`
# below keeps it — the CLI becomes this very process.
echo $$ > "$HOME/.acos/session.pid"

# Pre-accept the one-time interactive dialogs that would otherwise park the PTY:
# onboarding/theme, the bypass-permissions acknowledgement and the cwd trust
# prompt. This file lives on the per-session tmpfs HOME — it vanishes with it.
if [ ! -f "$HOME/.claude.json" ]; then
  CWD_JSON=$(pwd | sed 's/"/\\"/g')
  cat > "$HOME/.claude.json" <<EOF
{
  "hasCompletedOnboarding": true,
  "theme": "dark",
  "bypassPermissionsModeAccepted": true,
  "hasAcknowledgedCostThreshold": true,
  "projects": { "${CWD_JSON}": { "hasTrustDialogAccepted": true, "hasCompletedProjectOnboarding": true } }
}
EOF
fi

if [ -z "${ANTHROPIC_BASE_URL:-}" ] || [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  echo "acos-run-session: ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN missing — no brokered identity, refusing to start" >&2
  exit 64
fi
case "${ANTHROPIC_AUTH_TOKEN}" in
  acos-sess-*) ;;
  *) echo "acos-run-session: ANTHROPIC_AUTH_TOKEN is not a broker session token — refusing (INV-2: raw credentials never enter the container)" >&2; exit 65 ;;
esac
if [ -n "${INTERNAL_API_TOKEN:-}" ]; then
  echo "acos-run-session: INTERNAL_API_TOKEN present in the container environment — refusing (T30 §1.1: the skeleton key never enters an agent container)" >&2
  exit 66
fi

# Tool Gateway wiring (T30 §1.2): per-session mcp.json with the minted bearer.
# Written to the per-session tmpfs HOME, never to the kit.
if [ -n "${ACOS_MCP_URL:-}" ] && [ -n "${ACOS_GATEWAY_TOKEN:-}" ]; then
  if [ -z "${ACOS_GATEWAY_URL:-}" ]; then
    ACOS_GATEWAY_URL=$(printf '%s' "$ACOS_MCP_URL" | sed -E 's#^(https?://[^/]+).*#\1#')
    export ACOS_GATEWAY_URL
  fi
  if [ "${ACOS_MCP_TRANSPORT:-http}" = "stdio-bridge" ]; then
    cat > "$HOME/.acos/mcp.json" <<EOF
{ "mcpServers": { "acos": { "type": "stdio", "command": "node", "args": ["$KIT/mcp-shim.mjs"] } } }
EOF
  else
    cat > "$HOME/.acos/mcp.json" <<EOF
{ "mcpServers": { "acos": { "type": "http", "url": "${ACOS_MCP_URL}", "headers": { "Authorization": "Bearer ${ACOS_GATEWAY_TOKEN}" } } } }
EOF
  fi
  MCP_CONFIG="$HOME/.acos/mcp.json"
else
  echo "acos-run-session: WARNING — ACOS_MCP_URL/ACOS_GATEWAY_TOKEN missing: no Tool Gateway, every builtin will be denied by the audit hook and no company verbs exist" >&2
  MCP_CONFIG="$KIT/mcp.json"
fi

PROMPT="${ACOS_PROMPT:-}"
if [ -z "$PROMPT" ] && [ -n "${ACOS_PROMPT_FILE:-}" ] && [ -f "$ACOS_PROMPT_FILE" ]; then
  PROMPT=$(cat "$ACOS_PROMPT_FILE")
fi

set -- \
  --settings "$KIT/settings.json" \
  --mcp-config "$MCP_CONFIG" \
  --strict-mcp-config \
  --permission-mode bypassPermissions \
  --disallowedTools "WebFetch,WebSearch,Agent,Workflow,EnterWorktree,ExitWorktree,CronCreate,CronDelete,CronList,ScheduleWakeup,RemoteTrigger,PushNotification"

if [ -n "${ACOS_MODEL:-}" ]; then set -- "$@" --model "$ACOS_MODEL"; fi
# shellcheck disable=SC2086
if [ -n "${ACOS_EXTRA_ARGS:-}" ]; then set -- "$@" ${ACOS_EXTRA_ARGS}; fi

if [ "${ACOS_SESSION_MODE:-interactive}" = "print" ]; then
  set -- -p --verbose --output-format stream-json "$@"
fi

export DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null || true

if [ -n "$PROMPT" ]; then
  exec claude "$@" -- "$PROMPT"
else
  exec claude "$@"
fi
