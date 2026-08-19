# ADR-001: Repository Strategy — pnpm + Turborepo Monorepo

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

AI AGENT COMPANY OS is a single product with many deployable units: a control-plane monolith
(`apps/server`), a React SPA (`apps/web`), two Temporal workers, a sandbox-manager service, and
eight shared packages (`domain`, `db`, `events`, `contracts`, `llm`, `tools`, `config`, `ui`)
(_DECISIONS §2–§3). Several forces push hard on repository structure:

- **One language everywhere.** The entire stack is TypeScript (ADR-002). Domain types, Zod event
  schemas, tool definitions, and API contracts must be shared verbatim between server, workers, and
  frontend — the event catalog in `packages/events` is consumed by the outbox relay, JetStream
  consumers, the WebSocket gateway, and the SPA's digital-twin renderer.
- **Strict dependency rule.** `packages/domain` must depend on nothing internal; apps and workers
  must never depend on each other (_DECISIONS §3). This rule needs mechanical enforcement, which
  requires all code to be visible to one linter/CI run.
- **Local-first install.** `git clone && cp .env.example .env && docker compose up` must start
  everything (_BRIEF §9). One repository is the only structure that makes this a one-clone story.
- **Scale.** 1–10 companies per installation, a small team (initially one Founder plus Claude Code
  as implementer). Coordination overhead must be near zero; atomic cross-cutting changes (e.g. a
  new event type touching schema, relay, consumer, and UI) should be one commit and one PR.

## Options considered

### Option A: Polyrepo (repo per deployable unit + published shared packages)

- **Description.** Separate repositories for server, web, workers, sandbox-manager; shared code
  published as versioned npm packages (private registry or git dependencies).
- **Pros.** Independent release cadence; smaller clones; clear ownership boundaries if teams ever
  split; CI per repo is simple.
- **Cons.** Every cross-cutting change (new event, new tool schema, contract change) becomes a
  multi-repo dance: publish `events@x.y`, bump five consumers, keep versions in lockstep. Type
  drift between producer and consumer becomes possible — fatal for a system whose UI must render
  only real, schema'd events. The one-command local install would need a meta-repo or submodules.
- **Rejected because** coordination cost dwarfs any benefit at this team size; the product is one
  system with one version, not a federation of services with independent lifecycles.

### Option B: Nx monorepo

- **Description.** Nx workspace with generators, project graph, computation caching, and
  distributed task execution.
- **Pros.** Mature task graph and caching; module-boundary lint rules built in (which we do want);
  strong plugin ecosystem; remote cache options.
- **Cons.** Heavier conceptual and configuration surface: executors, generators, plugin versions
  tracked against framework versions, an opinionated project layout. Much of Nx's value (very large
  repos, many teams, distributed CI) does not apply at our scale. The boundary rules it provides are
  reproducible with `eslint-plugin-boundaries`.
- **Rejected because** it is the heavier tool for the same outcome; "prefer boring, minimal infra"
  (_DECISIONS §1) applies to build tooling too.

### Option C: pnpm workspaces + Turborepo (chosen)

- **Description.** pnpm for workspace linking and strict node_modules; Turborepo for the task graph
  (`build`, `test`, `lint`, `typecheck`) with local caching; layout exactly as _DECISIONS §3.
- **Pros.** Minimal configuration (`pnpm-workspace.yaml` + `turbo.json`); workspace protocol gives
  always-in-sync internal packages with zero publishing; pnpm's strictness prevents phantom
  dependencies; Turborepo caching keeps CI fast enough at this repo size.
- **Cons.** No built-in module-boundary enforcement (solved with eslint boundaries in CI); no code
  generators (not needed — Claude Code writes the code); remote caching optional/paid (local cache
  suffices here).

## Decision

The project is a single monorepo, `agent-company-os/`, managed with **pnpm workspaces +
Turborepo**, laid out exactly as _DECISIONS §3: `apps/` (server, web), `workers/` (agent-worker,
execution-worker), `services/` (sandbox-manager), `packages/` (domain, db, events, contracts, llm,
tools, config, ui), `infrastructure/` (docker, grafana), `docs/`.

Bounding rules:

- The **dependency rule is enforced mechanically**: `eslint-plugin-boundaries` configuration in the
  repo root, run in CI; violations fail the build. `domain` imports nothing internal; `db`,
  `events`, `tools`, `llm`, `contracts` may import `domain`; apps/workers/services import packages,
  never each other; `web` imports only `contracts` and `ui`.
- Internal packages use `workspace:*` — nothing is ever published to a registry.
- One version for the whole product; releases are tagged monorepo commits; Docker images for all
  deployable units are built from the same commit.
- Turborepo pipelines: `typecheck` and `lint` gate everything; `test` uses Vitest with
  Testcontainers where infra is needed (ADR-016 covers observability of CI, not here).

## Consequences

**Positive.**
- Atomic cross-cutting changes: adding an event type edits `packages/events`, the emitter, the
  consumer, and the UI in one commit — the compiler catches every missed consumer.
- The `docker compose up` promise holds: one clone contains everything including compose files.
- Boundary enforcement makes the modular monolith (ADR-002) honest — module boundaries survive
  because CI fails when they are crossed.

**Negative / accepted tradeoffs.**
- One large repo means CI runs the full graph on every PR; acceptable with Turbo caching at this
  size, and we accept slower CI over version-drift risk.
- No independent versioning of components; a hotfix to `sandbox-manager` ships the whole tag. Fine
  for a self-hosted product delivered as a compose file.
- Turborepo lock-in is shallow (it only orchestrates npm scripts) — migration cost to Nx or plain
  pnpm scripts is low if ever needed.

**Revisit triggers.**
- Repo exceeds ~500k LOC or full CI exceeds ~20 minutes with caching — evaluate Nx or remote
  caching.
- A second independent team needs its own release cadence for a component (Phase 3 marketplace of
  tool adapters could be such a case).
- A non-TypeScript component becomes necessary (would weaken the shared-types rationale).

## References

- _DECISIONS.md §1 (stack), §3 (monorepo layout, dependency rule), §22 row 001
- _BRIEF.md §9 (local-first install)
- ADR-002 (core backend stack), ADR-011 (frontend), ADR-019 (ORM — `packages/db`)
