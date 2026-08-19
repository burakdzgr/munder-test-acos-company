# acos/workspace-node — default coding-workspace image (15 §3.1, T38).
# Runs under the S8 hardened HostConfig: read-only rootfs, every capability
# dropped, noexec /tmp; the task worktree volume mounts rw at /work. Git is
# baked in because every coding task commits from its own worktree.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# unprivileged inside an already-hardened container; uid 1000 = node
USER node

# safe.directory: the worktree volume is provisioned by a helper container
# whose uid may differ from the workspace user
RUN git config --global safe.directory /work

CMD ["/bin/sh", "-c", "while true; do sleep 3600; done"]
