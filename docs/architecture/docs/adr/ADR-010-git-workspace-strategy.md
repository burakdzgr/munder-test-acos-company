# ADR-010: Git Workspace Strategy — Server-Side Bare Repo + Per-Task Worktree Volumes + PR-Entity Review

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

Multiple agents work the same codebase concurrently: the engineering workflow mandates per-task
isolated workspaces, own branches, commits, tests, and independent review before merge, with a
defined merge-conflict and locking strategy (_BRIEF §6). Forces:

- **Concurrency.** 5–30 active agents; several may implement tasks in one project simultaneously.
  Isolation must be at the task level, and "no developer approves their own work" requires
  reviewer access to the exact task branch.
- **Offline/local-first.** The system must function with no external git host: git and filesystem
  are MVP integrations; GitHub is optional (_DECISIONS §0 A7). The review flow therefore cannot
  depend on GitHub PRs.
- **Import intake.** Existing local projects are copied into the platform's own repo storage and
  analyzed (_BRIEF §6, _DECISIONS §13).
- **Sandbox fit.** Workspaces are container volumes provisioned by sandbox-manager (ADR-009);
  disk and provisioning time per task matter at tens of concurrent tasks.
- **Auditability.** Every branch, commit, review verdict, and merge must be a domain event/entity
  — the digital twin and skill-evidence pipeline consume them.

## Options considered

### Option A: Shared working directory per project

- **Description.** One checkout per project; agents take turns (or file locks) editing it.
- **Pros.** Minimal disk; no merge machinery; simplest possible mental model.
- **Cons.** Serializes the team or invites chaos: concurrent edits collide at the filesystem
  level, tests interfere, a broken state blocks everyone, and "independent review of an isolated
  change" is impossible because changes interleave. Contradicts the brief's explicit per-task
  isolated workspaces requirement.
- **Rejected because** it cannot support concurrent multi-agent work or isolated review.

### Option B: Full clone per task

- **Description.** Every task gets a complete `git clone` of the repository into its volume.
- **Pros.** Total isolation including `.git`; conceptually simple; no shared object store.
- **Cons.** Disk and time scale with repo size × concurrent tasks — a 2GB repo with 15 parallel
  tasks is 30GB and minutes of cloning; object duplication buys nothing over worktrees backed by
  one object store. Fetch/push traffic between clones and origin adds latency to every operation.
- **Rejected because** disk/time cost with zero isolation benefit over worktrees at our scale
  (worktrees share objects but have fully independent working trees and index).

### Option C: GitHub (or Gitea/GitLab) as the collaboration backbone

- **Description.** Push task branches to a hosted forge; use its PRs, reviews, and merge queue.
- **Pros.** Battle-tested review UX; humans can participate naturally; CI integrations for free.
  Self-hosting Gitea would keep it local.
- **Cons.** GitHub-only violates offline/local-first — the platform must work with no external
  services. Embedding Gitea adds a whole platform (users, auth, its own DB) whose PR state would
  duplicate our domain (`reviews` table, review events feed skills/memory — source-of-truth
  concern). Review verdicts must be Temporal signals into agent workflows; wiring a forge's
  webhooks in as the primary path adds fragility for no MVP gain.
- **Rejected as backbone because** offline requirement and state ownership; GitHub remains an
  **optional mirror/integration** (push branches, mirror PRs) via the integration module
  (ADR-017).

### Option D: Server-side bare repo + per-task worktree volumes + PR entity (chosen)

- **Description.** Canonical origin is a bare repo at `/data/repos/<project_id>.git`;
  sandbox-manager provisions a task-specific worktree volume on branch
  `task/<task-number>-<slug>`; review happens against our own `reviews` (PR) entity; merges land
  in the bare repo.
- **Pros.** Fully offline; cheap isolation (shared objects, independent trees); every git fact is
  observable by the platform; review flow is domain-native and signals workflows directly.
- **Cons.** We implement merge/rebase orchestration and diff serving ourselves; worktree registry
  requires cleanup discipline; no human-friendly forge UI in MVP (the SPA renders diffs).

## Decision

Per _DECISIONS §13:

- Each project has a **server-side bare repository** `/data/repos/<project_id>.git` — the sole
  origin. Imported projects are copied into it during intake.
- For each coding task, sandbox-manager creates a **git worktree volume** cloned from the bare
  repo on branch `task/<task-number>-<slug>`, mounted into that task's workspace container.
  Workspace lifecycle: provisioning → ready → in_use ⇄ idle → {merged, discarded, failed} →
  destroyed (_DECISIONS §19).
- **Review flow is a domain entity:** IN_PROGRESS→REVIEW creates a `reviews` row (our PR); a
  *different* agent with reviewer capability reviews the diff; verdict enters the owner's workflow
  as a `reviewVerdict` signal; QA gate follows; a lead agent merges via fast-forward/squash into
  `main` in the bare repo.
- **Conflicts:** merge conflicts are resolved by rebasing the task branch in the owner's own
  workspace (never in the bare repo); repeated failure escalates via the normal chain.
- **Soft locking:** `workspace_locks` records file paths per active task; parallel tasks touching
  the same paths get warnings (not blocks) at planning and pre-merge time.
- All git operations execute as execution-worker activities through sandbox-manager; emitted
  events (`workspace.*`, review events) feed the timeline, office, and skill evidence.

## Consequences

**Positive.**
- Fully offline engineering loop; the MVP proof (implement → test → independent review → merge)
  runs with zero external services.
- Task isolation with minimal disk: object store shared per project, working trees per task.
- Review verdicts, merges, and conflicts are first-class events — usable as skill evidence and
  learning candidates, and visible in the office twin.

**Negative / accepted tradeoffs.**
- We own merge orchestration edge cases (dirty worktrees, force-push protection, orphaned
  worktrees after crashes); mitigated by the workspace state machine and a reconciliation sweep
  that prunes stale worktrees/volumes.
- Soft locks warn rather than prevent overlapping edits — occasional rebase pain is accepted in
  exchange for not serializing the team; delegation planning uses lock data to route tasks apart.
- No forge-grade UI at MVP; diff/review UI in the SPA must be adequate for agent + Founder needs.

**Revisit triggers.**
- Conflict-driven rework exceeds ~10% of merges in practice → strengthen planning-time lock
  avoidance or introduce a merge-queue with rebase-and-retest automation.
- Human developers join the workflow (Phase 3) → revisit optional self-hosted forge integration
  as a first-class mirror.
- Monorepo-scale projects (multi-GB, >50 concurrent tasks) → evaluate partial clone/sparse
  worktrees.

## References

- _BRIEF.md §6 (projects & engineering, git execution model)
- _DECISIONS.md §13 (sandboxing & git), §19 (workspace state machine), §22 row 010
- ADR-009 (sandbox), ADR-017 (optional GitHub integration)
