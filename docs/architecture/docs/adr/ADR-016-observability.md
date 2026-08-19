# ADR-016: Observability — pino + OpenTelemetry, Optional Grafana Stack Profile, Domain Metrics in Postgres

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

The brief demands OTel-based traces/metrics/logs across agents, tasks, workflows, events, queues,
memory retrieval, LLM calls, tool calls, cost, latency, and retries (_BRIEF §9). Forces:

- **Two audiences, two kinds of "observability".** The **Founder** watches the company through
  in-app views (Agent Monitor, Costs, Events, Reports) — that is *domain* data and must come from
  Postgres, not a metrics backend. The **operator/developer** (often the same person, sometimes
  Claude Code debugging) needs infrastructure telemetry: traces across
  server → Temporal → workers → sandbox-manager, queue lag, error rates.
- **Self-hosted, resource-bounded.** Baseline 8 cores/16GB shared with Postgres, Temporal, NATS,
  and up to 30 workspace containers. A full telemetry stack can easily consume 2–4GB — it cannot
  be mandatory.
- **Causality tracing.** A single Founder objective fans out across CEO → CTO → EM → developer
  workflows, LLM calls, and sandbox commands; correlation/causation ids exist on events
  (_DECISIONS §9), and traces must stitch the same story across processes.
- **No SaaS dependency.** Telemetry must not require external services (offline profile).

## Options considered

### Option A: Full ELK/EFK stack (Elasticsearch, Logstash/Fluentd, Kibana)

- **Description.** Ship logs (and APM data via Elastic APM) into Elasticsearch.
- **Pros.** Powerful ad-hoc log search; mature dashboards; one vendor stack for logs+APM.
- **Cons.** Elasticsearch alone wants multiple GB of heap — a third or more of our baseline
  host for log search on a single-operator system. Operational care (index lifecycle, shard
  health) is disproportionate. Weaker fit for traces/metrics than the OTel-native path.
- **Rejected because** resource and ops weight; log search needs at our scale are served by Loki
  (optional) or even `docker logs` + pino filtering.

### Option B: SaaS-only APM (Datadog, Honeycomb, New Relic)

- **Description.** Instrument with vendor SDKs or OTel and export to a hosted APM.
- **Pros.** Zero self-hosted footprint; best-in-class UX; someone else runs the backend.
- **Cons.** Violates the self-hosted requirement outright: telemetry (including prompts/paths in
  spans) leaves the Founder's infrastructure; offline profile breaks; per-host pricing is absurd
  for a one-server product. Vendor SDKs would also couple instrumentation to a vendor.
- **Rejected as the answer because** self-hosted requirement; note OTel neutrality means a user
  *may* point the collector at a SaaS voluntarily.

### Option C: Nothing beyond logs (pino only, add tooling "later")

- **Description.** Structured logs to stdout; no traces or metrics until proven necessary.
- **Pros.** Zero footprint; simplest start.
- **Cons.** Retrofitting trace propagation across five processes, Temporal workflows, NATS
  consumers, and HTTP hops after the fact is the expensive part — the instrumentation seams must
  exist from day one even if no backend is attached. Debugging cross-process agent behavior with
  logs alone means hand-correlating ids.
- **Rejected because** instrumentation must be built in early; the *backends* are what can be
  optional, not the instrumentation.

### Option D: pino + OTel instrumentation, optional Grafana-stack compose profile (chosen)

- **Description.** Always-on structured logging and OTel SDK instrumentation; an optional compose
  profile runs otel-collector + Prometheus + Grafana + Loki + Tempo for those who want it.
- **Pros.** Vendor-neutral; zero mandatory footprint beyond the SDKs; full stack one flag away;
  domain dashboards stay in the product where they belong.
- **Cons.** Two dashboards worlds (in-app vs Grafana) must be kept from overlapping confusingly;
  OTel SDK/instrumentation churn in the JS ecosystem needs version pinning.

## Decision

Per _DECISIONS §1:

- **Logging:** **pino** structured JSON to stdout in every process, with canonical fields
  (`company_id`, `agent_id`, `task_id`, `workflow_id`, `trace_id`, `event_id` where applicable);
  Docker captures streams; no log files inside containers (except terminal session logs, which
  are product data, not logs — _DECISIONS §16).
- **Traces/metrics:** **OpenTelemetry SDK** in server, workers, and sandbox-manager. Context
  propagates via W3C traceparent over HTTP, Temporal interceptors (workflow/activity spans), and
  NATS headers; event `correlation_id` is attached as a span attribute to join domain causality
  with traces. Key spans: agent step, LLM call, tool invocation, gateway decision, consolidation
  stages, outbox relay publish, sandbox exec. Metrics: queue/relay lag, workflow latencies,
  LLM/tool error rates, WS connections.
- **Optional profile:** `docker compose --profile observability up` adds otel-collector,
  Prometheus, Grafana, Loki, Tempo with provisioned dashboards (`infrastructure/grafana`). The
  default profile exports nothing (OTLP endpoint unset → no-op), and the product is fully
  functional without it.
- **Domain observability is product, not telemetry:** Agent Monitor, Costs, Events timeline, and
  Reports read domain tables (`agent_sessions`, `llm_calls`, `cost_entries`, `events`) from
  Postgres. In-app views never depend on Prometheus/Grafana — a Founder question ("what did this
  cost?") must be answerable on a bare install.

## Consequences

**Positive.**
- Day-one cross-process debugging: one trace follows objective → delegation → agent steps → tool
  → sandbox exec; indispensable while building the agent loop.
- Bare installs stay lean (SDK overhead only); enthusiasts get a full stack with one flag; any
  OTel-compatible backend (self-hosted or SaaS) works unchanged.
- Clean separation: product analytics (Founder) from Postgres; infra telemetry (operator) from
  OTel — neither masquerades as the other.

**Negative / accepted tradeoffs.**
- Without the profile enabled, historical infra telemetry is absent when a problem is first
  noticed; accepted — domain tables (llm_calls, tool_invocations, events, agent_steps) preserve
  the domain-level history that matters most for post-hoc analysis.
- The observability profile roughly doubles infra container count; that is exactly why it is
  optional.
- JS OTel instrumentation maturity varies (Fastify/undici/NATS); pinned versions and a smoke test
  in CI (Testcontainers) guard against silent breakage.

**Revisit triggers.**
- Recurring production issues on bare installs that domain tables + logs cannot diagnose → ship a
  minimal always-on collector with short retention.
- Observability profile resource use >1.5GB steady-state → slim to a single-binary backend
  (e.g. Grafana Alloy / VictoriaMetrics single).
- Fleet deployments (Phase 3) → centralized telemetry architecture gets its own ADR.

## References

- _BRIEF.md §9 (observability, reliability), §8 (Agent Monitor, Events, Costs views)
- _DECISIONS.md §1 (observability row), §9 (correlation ids), §18 (costs), §22 row 016
- ADR-005 (Temporal), ADR-006 (event bus), ADR-018 (compose profiles)
