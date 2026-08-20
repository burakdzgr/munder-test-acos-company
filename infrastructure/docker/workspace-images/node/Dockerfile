# acos/workspace-node — default coding-workspace image (15 §3.1, T38).
# Runs under the S8 hardened HostConfig: read-only rootfs, every capability
# dropped, noexec /tmp; the task worktree volume mounts rw at /work. Git is
# baked in because every coding task commits from its own worktree.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# E4/T31 (ADR-022): the agent turn IS a Claude Code CLI session running in this
# container. Pinned; the npm package ships the native linux binary. Autoupdate is
# off (rootfs is read-only anyway). The ACOS kit (settings, MCP shim, INV-3 audit
# hook, session entry) is root-owned + read-only: uid 1000 can run it, not edit it.
ARG CLAUDE_CODE_VERSION=2.1.237
ENV DISABLE_AUTOUPDATER=1
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"   && claude --version   && npm cache clean --force
COPY --chmod=0755 acos-cli/run-session.sh /opt/acos/cli/run-session.sh
COPY --chmod=0644 acos-cli/settings.json acos-cli/mcp.json acos-cli/proxy-http.mjs acos-cli/audit-hook.mjs acos-cli/mcp-shim.mjs acos-cli/stop-hook.mjs /opt/acos/cli/

# unprivileged inside an already-hardened container; uid 1000 = node
USER node

# safe.directory: the worktree volume is provisioned by a helper container
# whose uid may differ from the workspace user
RUN git config --global safe.directory /work

CMD ["/bin/sh", "-c", "while true; do sleep 3600; done"]
