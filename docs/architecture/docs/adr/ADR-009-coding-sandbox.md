# ADR-009: Coding Sandbox — Docker Containers via sandbox-manager with Isolation Levels

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

Agents execute real work: shell commands, builds, tests, git operations, later browsers and media
tools. Domain rules demand sandboxed execution with least privilege, network policy, fs isolation,
and protection against malicious repos and prompt-injection-driven actions (_BRIEF §2.10, §9;
security invariants S1/S2/S8 in _DECISIONS §20). Forces:

- **Untrusted code by default.** Imported projects (PROJECT INTAKE) may contain hostile build
  scripts; agent-generated code is only as safe as its review. Execution must be contained.
- **Control/execution plane separation** (_BRIEF §2.7): sandboxes never hold domain state; only
  one component may touch the Docker socket (S1).
- **Real terminals.** The UI streams actual PTY output from sandboxes (_BRIEF §8) — the sandbox
  layer must support exec-with-PTY and frame streaming.
- **Self-hosted on stock Linux with Docker** (_DECISIONS §0 A2). No cloud sandboxing services; no
  GPU; no assumption of nested virtualization support.
- **Scale.** 5–30 concurrent agents → typically ≤30 concurrent workspace containers; creation
  latency of 1–3s is acceptable; per-container overhead matters more than cold-start μs.

## Options considered

### Option A: Host execution (process-level isolation only)

- **Description.** Run agent commands directly on the host (or worker container) under restricted
  users, with chroot/cgroup wrappers.
- **Pros.** Zero container overhead; instant startup; trivial file access.
- **Cons.** One `npm install` of a malicious dependency owns the host that also runs Postgres and
  all secrets. No credible network isolation. Violates S8 and the entire threat model around
  imported repos and prompt injection.
- **Rejected because** unsafe — flatly incompatible with the security invariants.

### Option B: MicroVM/hardened-runtime default (Firecracker or gVisor for all workspaces)

- **Description.** Every workspace is a Firecracker microVM or runs under gVisor (runsc).
- **Pros.** Kernel-level isolation strength; the correct default for hostile-multi-tenant SaaS;
  gVisor is a drop-in runtime class where supported.
- **Cons.** Firecracker demands KVM access, rootfs image plumbing, its own device/networking
  model — heavy engineering and host prerequisites that break "any Linux box with Docker". gVisor
  adds syscall-compat risk (build tools occasionally break) and perf overhead. Our tenant model is
  one Founder's own companies on their own hardware — the adversary is untrusted *code*, not
  hostile co-tenants, and containers with strict hardening are a proportionate boundary.
- **Rejected as default because** ops weight vs. threat model; **gVisor is the planned optional
  hardening in Phase 3** (a runtime-class switch in sandbox-manager, not a redesign).

### Option C: WebContainers / in-process JS sandboxes (vm2, isolated-vm)

- **Description.** Run code in browser-grade or V8-isolate sandboxes.
- **Pros.** Very fast startup; no Docker dependency; fine-grained API mediation.
- **Cons.** Server-side unfit for the workload: agents need real toolchains (npm, compilers, php,
  databases-under-test, arbitrary CLIs), real filesystems, and PTYs. WebContainers target the
  browser; V8 isolates only sandbox JS, not `npm test` spawning arbitrary binaries. vm2 is
  deprecated after escapes.
- **Rejected because** cannot host real polyglot toolchains; wrong layer entirely.

### Option D: Docker containers managed by a dedicated sandbox-manager (chosen)

- **Description.** Workspace containers from curated images (`acos/workspace-node`,
  `acos/workspace-php`, …) created/destroyed by `services/sandbox-manager` (dockerode), with an
  isolation-level matrix, git worktree volumes, and egress via an allowlist HTTP proxy.
- **Pros.** Works on any Docker host; proportionate isolation with hardening (no socket, dropped
  caps, resource limits); PTY exec + streaming is native; images encode toolchains reproducibly.
- **Cons.** Shared-kernel isolation (container escape is the residual risk); image maintenance
  burden; Docker socket ownership is a critical trust point.

## Decision

Sandboxing is **Docker containers, exclusively managed by `services/sandbox-manager`** — the ONLY
process with access to the Docker socket (invariant S1). Bounding rules per _DECISIONS §13, §20:

- **Isolation levels** define capability sets: `analysis` (read-only mount, no network), `coding`
  (rw worktree, egress proxy allowlisting package registries only), `testing` (coding + service
  containers), `deploy` (Phase 3), `browser`/`media` (Phase 2). CPU/mem/pids/disk limits per level.
- **Workspace containers** are hardened: no Docker socket, no host mounts beyond their task
  volume, dropped capabilities, non-root user, egress only via the allowlist proxy (S8). Secrets
  are never mounted — tools inject credentials server-side (S2).
- **Execution path:** execution-worker (Temporal activities) → sandbox-manager HTTP API →
  container exec with PTY → output frames to NATS ephemeral subjects + rolling log files. The
  execution-worker has no Docker access; the agent-worker has no sandbox access at all.
- sandbox-manager runs privileged and minimal (small Fastify service, no domain logic); everything
  else runs unprivileged.
- gVisor runtime class is an optional Phase 3 hardening flag per isolation level; API unchanged.

## Consequences

**Positive.**
- The MVP proof's "real terminals, never simulated" is native: PTY frames from actual containers.
- Blast radius of malicious code is a rate-limited, egress-filtered, capability-dropped container
  with one task's worktree — not the host, not other projects, not secrets.
- One privileged component to audit; the S1/S3 invariants are checkable in code review and CI
  (no other package may import dockerode or reach the socket).

**Negative / accepted tradeoffs.**
- Shared-kernel containers are weaker than microVMs; accepted for the self-hosted threat model,
  with gVisor as the planned upgrade path. Kernel patching discipline falls on the operator (ops
  docs cover unattended upgrades).
- Curated workspace images must track toolchain updates; accepted maintenance cost, bounded by
  supporting a small image set in MVP (node, php first).
- Container density (~30 concurrent) consumes host RAM; per-level limits and idle-workspace
  reaping keep this within the 16GB baseline.

**Revisit triggers.**
- Any container-escape class vulnerability relevant to our kernel/runtime configuration → pull
  gVisor forward from Phase 3.
- Multi-human/multi-tenant hosting of untrusted third parties (beyond one Founder) → microVM
  isolation becomes mandatory, reopening Option B.
- Workspace creation latency >5s p95 or density limits reached → image slimming, container
  pooling, or warm-standby workspaces.

## References

- _BRIEF.md §2.7, §2.10, §8 (terminals), §9 (security)
- _DECISIONS.md §2 (topology), §13 (sandboxing & git), §20 (invariants), §22 row 009
- ADR-010 (git workspaces), ADR-014 (Tool Gateway authorization), ADR-017 (integrations)
