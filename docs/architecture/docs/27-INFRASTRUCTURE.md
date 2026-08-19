# 27 — Infrastructure & Deployment

Status: v1.0 — Implementation-ready

Local-first per the brief §9: `git clone && cp .env.example .env && docker compose up` starts a
complete working system. Same compose file runs the production single server (ADR-018); scale-out
is a Phase 3 topology change, not a rewrite. Topology and container list are binding from
_DECISIONS.md §1–2.

---

## 1. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Docker Engine + Compose plugin | 27+ / Compose v2.29+ | Compose profiles + `develop.watch` required |
| Node.js | 22 LTS | Only for dev-mode B (§4) and running scripts on host |
| pnpm | 9.x | via `corepack enable` |
| Hardware | 8+ cores, 16+ GB RAM, 100+ GB SSD | _DECISIONS §0 A2 baseline |
| OS | Linux x86_64/arm64 (macOS for dev) | Production: Linux only |

## 2. `docker compose up` — what starts

Compose files live in `infrastructure/docker/`: `compose.yaml` (base), `compose.dev.yaml`
(watch/hot-reload overrides), `compose.prod.yaml` (TLS, restart policies, resource limits).

| Service | Image | Ports (dev) | Role |
|---|---|---|---|
| `postgres` | pgvector/pgvector:pg16 | 5432 | Sole database (app schema + separate `temporal` DB) |
| `nats` | nats:2.10 (JetStream on) | 4222 | Event distribution, terminal frames |
| `temporal` | temporalio/auto-setup | 7233 | Durable workflows (own schema in same PG instance) |
| `temporal-ui` | temporalio/ui | 8080 | Workflow inspection |
| `server` | acos/server (apps/server) | 3000 | Control plane: REST, /ws, outbox relay, Tool Gateway |
| `web` | acos/web (apps/web) | 5173 | React SPA (dev: Vite; prod: static via Caddy) |
| `agent-worker` | acos/agent-worker | — | Agent loop, delegation, memory, intake workflows |
| `execution-worker` | acos/execution-worker | — | Sandboxed tool activities |
| `sandbox-manager` | acos/sandbox-manager | 3010 (internal) | ONLY holder of `/var/run/docker.sock`; privileged |
| `egress-proxy` | acos/egress-proxy (squid-based) | 3128 (internal net) | Workspace allowlist egress (§12) |
| *profile: observability* | otel-collector, prometheus, grafana(3001), loki, tempo | | 25-OBSERVABILITY.md §3 |

Boot ordering via healthchecks: postgres → (migrations, §7) → temporal + nats → server →
workers → web. First boot of `server` runs migrations then optionally the seed (§5).

## 3. Dev-mode conveniences — two supported modes

**Mode A — everything in compose (default, zero host deps beyond Docker):**
`docker compose -f compose.yaml -f compose.dev.yaml up`. Dev images mount nothing; instead
Compose **`develop.watch`** syncs source into containers (`sync` for `src/**`, `rebuild` on
lockfile/Dockerfile change). `server`/workers run `tsx watch`; `web` runs Vite dev server. Slower
feedback (~1–3s sync) but perfectly reproducible.

**Mode B — apps on host, infra in compose (fast inner loop):**
`docker compose up postgres nats temporal temporal-ui sandbox-manager egress-proxy` then
`pnpm turbo dev` on the host runs `server`, `web`, `agent-worker`, `execution-worker` with native
hot reload, pointing at the infra containers via `.env` (`localhost` ports). sandbox-manager
**always runs in Docker** even in Mode B (it needs the socket and its network position next to
workspace containers). `.env.example` ships with Mode-B-compatible defaults
(`DATABASE_URL=postgres://acos:acos@localhost:5432/acos`, etc.); Mode A overrides hostnames via
compose environment (service DNS names). Both modes are CI-tested (32-TESTING-STRATEGY.md §10
smoke boots Mode A).

## 4. Seed script

`pnpm seed` (also auto-run on first boot when `SEED_DEMO=true`, default true in dev, false in
prod). Idempotent (keyed on company slug). Creates demo company **"Acme Technologies"**:

- Founder user (`founder@acme.local` / printed generated password), company settings (USD).
- Org: Engineering department → Backend team, Frontend team; positions (CEO, CTO, Engineering
  Manager, Backend Lead, Backend Engineer, Frontend Engineer, QA/Reviewer).
- 8 agents (CEO, CTO, Engineering Manager, Backend Lead, 2 Backend Engineers, 1 Frontend
  Engineer, 1 QA/Reviewer) with names/avatars/personas, `reports_to` forest
  (Dev→Lead→EM→CTO→CEO), model bindings from `.env` provider keys (falls back to Ollama profile
  if no keys).
- One greenfield sample project + a small importable fixture repo under
  `infrastructure/docker/fixtures/sample-repo` for exercising intake.
- Default budgets (company daily 5,000¢ hard), default tool permissions per position, default
  model profiles. This seed is exactly the starting state of the 25-step MVP demo
  (29-MVP-PLAN.md).

## 5. Volumes layout

All persistent state under a single root (bind mount `${DATA_DIR:-./data}` in dev; named volumes
or a dedicated disk in prod):

| Path | Contents | Owner service |
|---|---|---|
| `/data/postgres` | PG cluster (app + temporal DBs) | postgres |
| `/data/repos` | Bare git repos `<project_id>.git` | server (git ops via execution path) |
| `/data/workspaces` | Per-task worktree volumes | sandbox-manager |
| `/data/terminals` | Terminal session logs (7d retention) | sandbox-manager |
| `/data/assets` | Artifacts, avatars, (Phase 2 media) | server |

## 6. Backup strategy

**[WRITER-DECISION — schedule defaults]**
- **Postgres:** nightly `pg_dump -Fc` of the app DB + temporal DB at 03:00 local via a `backup`
  sidecar container (alpine + cron), to `/data/backups/`, retaining 7 daily + 4 weekly. Restore
  runbook: stop app services → `pg_restore` → start (documented in the ops README).
- **Volume snapshots:** `/data/repos` and `/data/assets` are rsync-snapshotted with the same
  schedule (hardlink rotation). `/data/workspaces` and `/data/terminals` are **excluded** —
  reconstructible/ephemeral (worktrees re-clone from bare repos; Temporal replays in-flight
  work). If the host offers filesystem/ZFS/cloud-disk snapshots, snapshot the whole `/data`
  instead; consistency note: take PG dump first or snapshot while PG is running only on
  crash-consistent storage (PG recovers via WAL).
- Off-host copy is the operator's responsibility; `.env` supports `BACKUP_S3_URL` for optional
  rclone push.

## 7. Upgrade procedure

1. `git pull && docker compose build` (or pull tagged images).
2. `docker compose up -d` — on boot, `server` runs `drizzle-kit migrate` **guarded by a Postgres
   advisory lock** (`pg_advisory_lock(0xAC05)`): exactly one instance migrates; others wait, then
   start. Workers wait for the server health endpoint (which asserts schema version match from a
   `schema_migrations` check) before polling task queues — old-schema workers never touch a new
   schema.
3. Migrations are forward-only and additive-first (expand → migrate data → contract in a later
   release). Temporal server upgrades follow Temporal's own auto-setup migration.
4. Rollback = restore backup + previous image tag (documented; forward-fix preferred).

## 8. Production single-server topology

Same compose + `compose.prod.yaml`: `restart: unless-stopped`, resource limits, TLS, no dev
mounts, `SEED_DEMO=false`, observability profile recommended-on.

**[WRITER-DECISION] TLS/reverse proxy: Caddy** (over Traefik) — automatic Let's Encrypt with a
2-line config, static-file serving for `apps/web` build output, WebSocket pass-through by
default; Traefik's dynamic service discovery adds no value for a fixed 2-route topology.

```
# infrastructure/docker/Caddyfile
{$APP_BASE_URL} {
    encode zstd gzip
    handle /api/* { reverse_proxy server:3000 }
    handle /ws    { reverse_proxy server:3000 }
    handle        { root * /srv/web  file_server  try_files {path} /index.html }
}
```

Domain config: set `APP_BASE_URL=https://os.example.com` in `.env`; DNS A record to the host; Caddy
provisions certs (or `internal` CA for LAN-only installs — the office/terminal UI requires a
secure context, so even LAN installs get TLS).

**Resource sizing — 30 concurrently active agents** (scale assumptions, brief §10):

| Service | CPU (cores) | RAM | Notes |
|---|---|---|---|
| postgres | 2 | 4 GB | incl. pgvector HNSW; `shared_buffers=1GB` |
| temporal + UI | 1 | 1.5 GB | modest at ≤30 workflows active |
| nats | 0.5 | 512 MB | JetStream file store on /data |
| server | 1 | 1 GB | REST + WS + relay + gateway |
| agent-worker | 1 | 1 GB | LLM-bound, mostly waiting on IO |
| execution-worker | 0.5 | 512 MB | thin dispatcher |
| sandbox-manager + caddy + egress-proxy | 0.5 | 512 MB | |
| workspace containers | ~8 (burst) | ~12 GB (burst) | ~6 concurrent coding workspaces × 2CPU/4GB, capped by §11 + global `MAX_WORKSPACES=8` |
| observability profile | 1 | 2 GB | optional |
| **Host recommendation** | **16 cores** | **32 GB** | 8c/16GB minimum runs ~10 active agents |

## 9. Deployment diagrams

**MVP — single server:**

```mermaid
flowchart TB
    subgraph host [Single Linux host — docker compose]
        caddy[Caddy TLS] --> server[apps/server]
        caddy --> webfiles[web static]
        subgraph cp [Control plane]
            server --- pg[(Postgres 16 + pgvector)]
            server --- nats[NATS JetStream]
            aw[agent-worker] --- temporal[Temporal] --- pg
            aw --- pg
        end
        subgraph ep [Execution plane]
            ew[execution-worker] --> sm[sandbox-manager]
            sm -.docker socket.- dockerd[(dockerd)]
            sm --> ws1[workspace: coding]
            sm --> ws2[workspace: analysis]
            ws1 --> eg[egress-proxy allowlist]
        end
        ew --- temporal
        sm --- nats
        obs["observability profile — otel-col / prom / grafana / loki / tempo"]:::opt
    end
    founder((Founder browser)) -->|HTTPS + WSS| caddy
    aw -->|HTTPS| llm[(LLM providers)]
    classDef opt stroke-dasharray: 5 5
```

**Phase 3 — distributed:**

```mermaid
flowchart TB
    subgraph core [Core VM]
        caddy2[Caddy] --> srv[server x2]
        srv --- pgp[(PG primary)]
        pgp --> pgr[(PG replica — reads/DR)]
        tmp[Temporal] --- pgp
    end
    subgraph natsc [NATS cluster — 3 nodes]
        n1[nats-1] --- n2[nats-2] --- n3[nats-3]
    end
    subgraph wvm [Worker VMs xN]
        aw2[agent-worker] --- tmp
        ew2[execution-worker] --- tmp
    end
    subgraph sbp [Remote sandbox pool VMs]
        sm2[sandbox-manager] --> wsn[workspace containers + gVisor]
        sm2 --> eg2[egress-proxy]
    end
    srv --- natsc
    ew2 --> sm2
    sm2 --- natsc
    founder2((Browsers)) --> caddy2
```

Scale-out path (no code change, config only): (1) move workers to their own VMs — Temporal task
queues already decouple them; (2) NATS → 3-node cluster (URL list change); (3) PG streaming
replica for reads/DR; (4) remote sandbox pool — execution-worker already talks to sandbox-manager
over HTTP, so its address becomes a pool endpoint; gVisor runtime enabled (_DECISIONS §1);
(5) second `server` behind Caddy (outbox relay stays single via advisory-lock leader election).
K8s only if fleet demands (ADR-018).

## 10. Security hardening checklist (host)

- [ ] Dedicated non-root user in `docker` group only for deploy; SSH keys only, no password auth.
- [ ] UFW/nftables: inbound 443/80 (Caddy) + SSH only; all other service ports bound to
      `127.0.0.1`/compose-internal networks (compose files already do this in prod overlay).
- [ ] Docker: userns-remap where compatible; `no-new-privileges` default; live-restore on.
- [ ] Workspace network `acos-workspaces` is `internal: true`; only route out is egress-proxy
      (S8). sandbox-manager is the only privileged container (S1).
- [ ] `/data` on encrypted disk (LUKS) if host is not physically controlled; backups encrypted.
- [ ] Unattended security updates for the host OS; Docker pinned to a tested minor.
- [ ] `.env` chmod 600; `MASTER_KEY` (secrets envelope, _DECISIONS §1) in OS keyring or
      injected at boot, never committed.
- [ ] Audit `audit_log` retention & ship off-host with backups (S7).
- [ ] Temporal UI and Grafana behind Caddy basic-auth or not exposed (default: internal only).
- [ ] Regularly rebuild workspace images (patched base layers); pin digests.

## 11. Workspace resource limits (from _DECISIONS §13, concrete)

| Level | CPU | RAM | pids | Disk quota | Network |
|---|---|---|---|---|---|
| `analysis` | 1 | 1 GB | 256 | 2 GB (ro mount + 512MB scratch) | **none** (no interface beyond loopback) |
| `coding` | 2 | 4 GB | 512 | 10 GB | egress-proxy allowlist (registries only) |
| `testing` | 4 | 8 GB | 1024 | 20 GB | proxy allowlist + linked service containers |
| `deploy` (P3) / `browser`,`media` (P2) | per adapter | | | | defined with the feature |

Enforced by sandbox-manager at container create (`HostConfig`: NanoCpus, Memory, PidsLimit,
storage-opt where the driver supports it; else volume-size checks in the GC job). All levels:
dropped capabilities, `no-new-privileges`, read-only root fs with tmpfs `/tmp`, no host mounts
beyond the worktree volume (S8).

## 12. Egress proxy config example

`infrastructure/docker/egress-proxy/squid.conf` (allowlist model; per-workspace additions come
from project settings via a generated include):

```
http_port 3128
acl workspaces src 172.30.0.0/16          # acos-workspaces network
acl allowed_dst dstdomain .npmjs.org .yarnpkg.com .pypi.org .pythonhosted.org
acl allowed_dst dstdomain .crates.io .golang.org .githubusercontent.com github.com
acl CONNECT method CONNECT
http_access allow workspaces allowed_dst
http_access deny all                       # default deny, logged
access_log stdio:/dev/stdout               # scraped to Loki; denials alertable
```

Workspaces get `HTTP_PROXY/HTTPS_PROXY=http://egress-proxy:3128` env and no default route
(internal network) — proxy bypass is impossible, not just discouraged. Denied domains emit a
`workspace.egress.denied` event (policy-flag input for 34-THREAT-MODEL.md injection detection).

## 13. `.env.example` — canonical keys

Parsed and validated by `packages/config` (Zod) at boot; missing/invalid keys fail fast with a
readable error listing every problem (never a stack trace).

```bash
# Core
NODE_ENV=development
APP_BASE_URL=http://localhost:3000   # prod: https://os.example.com
WEB_PORT=5173
SERVER_PORT=3000
DATA_DIR=./data
LOG_LEVEL=info
SEED_DEMO=true

# Datastores (Mode-B host defaults; compose overrides hostnames)
DATABASE_URL=postgres://acos:acos@localhost:5432/acos
NATS_URL=nats://localhost:4222
TEMPORAL_ADDRESS=localhost:7233
TEMPORAL_NAMESPACE=acos

# Security
MASTER_KEY=                      # 32-byte base64; generated by `pnpm ops keygen` on first run
SESSION_SECRET=                  # cookie signing
ARGON2_MEMORY_KIB=65536
INTERNAL_API_TOKEN=              # shared bearer for internal HTTP (Tool Gateway, sandbox-manager)

# LLM providers (any subset; none ⇒ Ollama offline profile)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
OLLAMA_BASE_URL=http://localhost:11434
VLLM_BASE_URL=

# Embeddings
EMBEDDINGS_PROVIDER=openai       # openai | ollama
EMBEDDINGS_MODEL=text-embedding-3-small

# Execution plane
SANDBOX_MANAGER_URL=http://localhost:3010
MAX_WORKSPACES=8
DOCKER_SOCK=/var/run/docker.sock # mounted ONLY into sandbox-manager
EGRESS_PROXY_URL=http://egress-proxy:3128

# Budgets / safety defaults
DEFAULT_COMPANY_DAILY_BUDGET_CENTS=5000

# Observability (profile only)
OTEL_EXPORTER_OTLP_ENDPOINT=     # empty ⇒ no-op exporter
GRAFANA_ADMIN_PASSWORD=

# Backups
BACKUP_S3_URL=                   # optional rclone target
```

## 14. First-boot walkthrough & ops CLI

Expected first `docker compose up` sequence (≈2–4 min on the baseline box): postgres healthy →
server migrates (advisory lock) → seeds Acme → temporal/nats healthy → workers register task
queues → web serves → log line `ACOS ready — http://localhost:5173 (founder@acme.local /
<printed password>)`. Health endpoints: `GET /api/health` (server, aggregates dependency checks),
`GET /healthz` on each worker/sandbox-manager (used by compose healthchecks and the
`acos_heartbeat_timestamp` metric).

Operator CLI `pnpm ops <cmd>` (runs against the live stack via API/PG):

| Command | Purpose |
|---|---|
| `ops keygen` | Generate `MASTER_KEY` |
| `ops backup now` / `ops restore <file>` | Manual backup / guided restore (§6) |
| `ops replay-dead-events --consumer X` | DLQ replay (33-FAILURE-MODES.md §2.17) |
| `ops workspace gc` / `ops workspace ls` | Force GC / inspect live workspaces |
| `ops seed` / `ops seed --reset-demo` | Idempotent seed / recreate Acme |
| `ops doctor` | Checks: disk, clock skew, provider reachability, schema version, socket perms |

## 15. Cross-references

- Compose service semantics: _DECISIONS §1–2; process responsibilities: 02-SYSTEM-CONTEXT.md
- Sandbox levels & git model: 14-PROJECT-RUNTIME.md; security invariants: 18-PERMISSIONS-AND-SECURITY.md
- Observability profile contents: 25-OBSERVABILITY.md §3
- Failure behavior of each component: 33-FAILURE-MODES.md
- Milestones using this setup: 29-MVP-PLAN.md
