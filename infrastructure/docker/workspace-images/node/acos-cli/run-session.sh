#!/bin/sh
# ACOS agent session entry (ADR-022). Exec'd by sandbox-manager as THE process
# of the terminal_sessions PTY, so the human watches the real `claude` session.
#
# Contract (all injected by the runtime at exec time — nothing is read from disk
# except the read-only kit in /opt/acos/cli):
#   ANTHROPIC_BASE_URL    identity broker (host-side); ANTHROPIC_AUTH_TOKEN per-session capability token
#   ACOS_GATEWAY_URL / ACOS_GATEWAY_TOKEN   Tool Gateway (MCP shim + audit hook + stop hook)
#   ACOS_MODEL            optional model override (e.g. sonnet|opus|haiku|claude-…)
#   ACOS_PROMPT           initial prompt = the task brief (the runtime assembles it)
#   ACOS_PROMPT_FILE      alternative: path (inside the container) holding the brief
#   ACOS_SESSION_MODE     interactive (default, live TUI in the PTY) | print (non-TUI, for tests)
#   ACOS_EXTRA_ARGS       optional extra CLI args (space-separated, trusted — runtime-owned)
#
# Security posture is NOT configurable from here: settings + mcp config are the
# baked read-only files, --strict-mcp-config pins the MCP set, the PreToolUse
# hook audits every builtin (INV-3), and the only credential present is the
# revocable session token (INV-2).
set -eu

KIT=/opt/acos/cli
: "${HOME:=/home/node}"
export HOME
mkdir -p "$HOME/.claude"

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

PROMPT="${ACOS_PROMPT:-}"
if [ -z "$PROMPT" ] && [ -n "${ACOS_PROMPT_FILE:-}" ] && [ -f "$ACOS_PROMPT_FILE" ]; then
  PROMPT=$(cat "$ACOS_PROMPT_FILE")
fi

set -- \
  --settings "$KIT/settings.json" \
  --mcp-config "$KIT/mcp.json" \
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
