# ADR-018: Deployment Architecture — Docker Compose Single Server, Scale-Out via Multi-VM Compose, K8s Only If Fleet Demands

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

The installation promise is explicit: `git clone && cp .env.example .env && docker compose up`
starts everything; production is single server first, scalable workers later, with no Kubernetes
requirement for MVP (_BRIEF §9). Forces:

- **Operator profile.** One Founder on their own Linux box (8+ cores/16+GB, _DECISIONS §0 A2) —
  not a platform team. Every operational concept added (orchestrator, service mesh, ingress)
  is a support burden and an adoption filter.
- **Fixed process topology.** Five app processes (server, web, agent-worker, execution-worker,
  sandbox-manager) plus postgres, nats, temporal(+ui), optional observability profile
  (_DECISIONS §1–§2). Only the Temporal workers are horizontally scalable by design; the server
  runs leader-elected singletons (outbox relay) and stateful WS connections.
- **Sandbox reality.** sandbox-manager needs the Docker socket and creates sibling workspace
  containers — trivially natural on a Docker host, awkward inside K8s (DinD/socket-mounting
  anti-patterns or a rearchitecture to pod-based sandboxes).
- **Scale ceiling.** 1–10 companies, 5–30 concurrent agents. The binding constraint is host
  resources (LLM concurrency, workspace containers), not request throughput.

## Options considered

### Option A: Kubernetes-first (k3s for small installs)

- **Description.** Helm charts as the primary artifact; k3s for single-node users.
- **Pros.** Industry-standard orchestration: self-healing, rolling updates, HPA, secret objects;
  a credible endpoint if the platform ever runs fleets; k3s tames the footprint somewhat.
- **Cons.** Even k3s brings CRDs, ingress, PV provisioning, and a failure-mode vocabulary that
  dwarfs the app for a single-node install; the `docker compose up` promise dies; sandbox
  provisioning must be redesigned around pods and container runtimes; Temporal/Postgres on K8s
  demand operators (more moving parts). All to orchestrate ~10 containers on one machine.
- **Rejected as default because** MVP overkill — cost is certain, benefit hypothetical at spec
  scale. Kept as the explicit *last* stage of the scaling path.

### Option B: Bare-metal systemd (no containers)

- **Description.** Install Node, Postgres, NATS, Temporal directly; systemd units per process.
- **Pros.** Minimal indirection; best raw performance; familiar to traditional sysadmins.
- **Cons.** Loses container isolation exactly where it is load-bearing: workspace sandboxing
  (ADR-009) presumes container boundaries; host-level installs turn "works on my machine" into
  the support matrix (distro × Node version × Postgres version); upgrades and rollback become
  artisanal. Reproducibility of the whole stack is the point of shipping images.
- **Rejected because** isolation loss and support-matrix explosion; Docker is already a hard
  requirement for sandboxing, so avoiding it elsewhere saves nothing.

### Option C: Docker Compose with a staged scaling path (chosen)

- **Description.** Compose is the canonical deployment artifact for MVP and small production;
  scaling proceeds by moving/replicating compose services across VMs; K8s only if a real fleet
  emerges.
- **Pros.** Honors the one-command promise; identical artifact for dev and prod; sandbox model is
  native; each scaling stage is an operational change, not a rearchitecture.
- **Cons.** No self-healing beyond restart policies; no rolling deploys (brief downtime on
  upgrade); multi-VM compose is manually coordinated (env files, network peering).

## Decision

**Docker Compose is the canonical deployment architecture**, with a three-stage scaling path:

- **Stage 1 — single server (MVP default):** one compose project: `postgres`, `nats`, `temporal`
  (+ own postgres schema), `temporal-ui`, `server`, `web`, `agent-worker`, `execution-worker`,
  `sandbox-manager`, optional `--profile observability` stack (_DECISIONS §1). `.env` is the only
  required configuration; named volumes for `/data` (repos, terminals, postgres). Upgrades:
  `git pull && docker compose pull && docker compose up -d` with automatic Drizzle migrations on
  server start (ADR-019); backups: pg_dump/pgBackRest + `/data` volume snapshots, documented.
- **Stage 2 — multi-VM compose (workers scale-out):** the same images, split: VM1 runs control
  plane + data (server, web, postgres, nats, temporal); VM2..N run `agent-worker`,
  `execution-worker`, `sandbox-manager` + workspaces, connected over a private network (WireGuard
  or cloud VPC). This works without code changes because workers talk only to
  Temporal/NATS/Postgres/server APIs, and sandbox capacity is the first real bottleneck.
- **Stage 3 — Kubernetes, only if fleet demands:** many installations to manage or elastic worker
  pools genuinely needed. Requires its own ADR (sandbox provisioning redesign, relay/WS gateway
  scaling) — explicitly out of MVP scope.
- Bounding rules: exactly one `server` instance in Stages 1–2 (leader-elected singletons and WS
  state assume it); `sandbox-manager` is host-local to its workers' Docker daemon; the SPA and
  API remain same-origin behind one reverse-proxy/TLS entry point (Caddy service or operator's
  own proxy), preserving cookie auth assumptions (ADR-013).

## Consequences

**Positive.**
- The adoption-critical promise is kept: clone → env → up → working company OS, on any Docker
  host, fully offline-capable.
- Dev/prod parity is total (same compose file, profiles differ), which keeps Claude Code's
  implementation loop and the Founder's runtime identical.
- The scaling path is incremental and honest: each stage is triggered by a measurable bottleneck
  and reuses all prior artifacts.

**Negative / accepted tradeoffs.**
- Upgrades incur brief downtime (no rolling deploys); acceptable — agents' work is durable
  (ADR-005), workflows resume after restart, so downtime costs minutes of progress, not
  correctness.
- Compose restart policies are the only self-healing; a wedged host needs a human. Accepted for
  a single-operator product; monitoring hooks (ADR-016) surface it.
- Multi-VM stage lacks orchestration conveniences (placement, secrets distribution); documented
  runbooks compensate until Stage 3.

**Revisit triggers.**
- Sandbox/worker capacity demands >3 worker VMs, or worker elasticity (scale-to-zero, burst)
  becomes economically significant → begin Stage 3 ADR.
- Managed/hosted offering of the platform → K8s (or equivalent) becomes the operator's problem,
  reopening orchestration choice.
- WS connection count or API load exceeds a single `server` instance → extract gateway/relay for
  horizontal server scaling (prerequisite to any Stage 3 work).

## References

- _BRIEF.md §9 (local-first, production path), §10 (scale)
- _DECISIONS.md §0 A2, §1 (infra containers), §2 (process topology), §22 row 018
- ADR-002 (topology), ADR-009 (sandbox/Docker socket), ADR-013 (same-origin), ADR-016 (profiles),
  ADR-019 (migrations on deploy)
