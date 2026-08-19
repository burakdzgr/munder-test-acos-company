# ADR-014: Authorization Model — RBAC + Custom DB-Backed Policy Engine + Autonomy Matrix

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

Authorization here is two distinct problems. First, conventional platform RBAC: which humans (and
PATs) may administer companies, providers, settings. Second — the hard one — **agent action
authorization**: before every tool execution, the Tool Gateway must decide
`allow | deny | require_approval` from a rich context (_BRIEF §2.10, _DECISIONS §12):

- agent identity and permission grants (agent/position/unit-scoped, with constraints like path
  prefixes, repo lists, spend caps);
- the tool's **risk class** (R0 read → R3 irreversible/external-world) and touched scopes
  (fs, git, network, db, money, publish);
- the agent's **autonomy level** (L0–L5) combined dynamically with risk, reversibility,
  estimated cost vs. remaining budget, and tenant policies — explicitly *not* static levels alone
  (_BRIEF §5);
- platform-hard-coded Founder-only categories (payments, legal, credentials, destructive prod)
  that no tenant configuration may override (invariant S6);
- full auditability: every decision must be explainable and logged (`tool_invocations`).

Decisions are on the hot path of every agent step (tens/second peak) and must read live domain
state (budgets, task risk) transactionally.

## Options considered

### Option A: OPA/Rego (Open Policy Agent)

- **Description.** Externalize decisions to OPA; policies in Rego; app supplies input documents.
- **Pros.** Industry-standard policy-as-code; decoupled policy lifecycle; strong testing story
  and audit tooling.
- **Cons.** Wrong grain for us: decisions depend on live Postgres state (remaining budget, spend
  today, delegation depth) that would have to be shipped into every query or synced into OPA's
  data store — a consistency problem for exactly the numbers that must be exact. Rego is a new
  language outside our TS/Zod world (types unshared, harder for review). Another always-on
  service in compose. Tenant-editable policies would mean tenants writing Rego — unacceptable UX.
- **Rejected because** heavy and wrong-grained: our policies are dynamic, data-dependent domain
  logic, not static infrastructure policy.

### Option B: Casbin (embedded policy library)

- **Description.** Embeddable RBAC/ABAC engine with model files and policy storage adapters;
  has a Node port.
- **Pros.** In-process (no service); flexible model definitions; persistence adapters exist.
- **Cons.** Its matcher expressions cannot naturally express our decision function: budget
  arithmetic against live task/company spend, cost-estimator outputs, risk×autonomy matrices
  with team/department scope conditions, and mandatory approval short-circuits. We would end up
  computing everything in TS and using Casbin as a thin `eval` — inheriting its model-file DSL
  without gaining expressiveness.
- **Rejected because** insufficient expressiveness for cost/budget/risk context; it would be
  ceremony around logic we write anyway.

### Option C: Pure ACL / permission lists only

- **Description.** Flat grants: agent X may use tool Y (optionally with constraints); no risk or
  autonomy dimension.
- **Pros.** Trivial to implement, reason about, and display.
- **Cons.** Cannot express the autonomy model at all: the same agent may run a cheap R1 command
  freely but must get approval for an R3 destructive action; budget exhaustion must flip
  decisions dynamically; Founder-only categories need unconditional overrides. ACLs alone would
  push all of that into scattered if-statements.
- **Rejected because** no risk dimension — it fails the brief's autonomy model directly.

### Option D: RBAC + our own DB-backed policy engine (chosen)

- **Description.** Platform RBAC for humans; for agents, a deterministic TS decision function in
  `packages/domain` evaluating grants + policy rules stored in Postgres + the canonical autonomy
  matrix, invoked by the Tool Gateway.
- **Pros.** Exact fit to the decision model; transactional reads of live budgets; typed,
  unit-testable, explainable decisions; policies are domain data editable through our UI.
- **Cons.** We own correctness and every future policy feature; no external policy-audit
  ecosystem; discipline required to keep the engine the *only* decision path (invariant S3).

## Decision

Two-layer authorization, per _DECISIONS §1 and §12:

1. **Platform RBAC (humans/PATs):** roles (`owner`, `admin`, `member` per company; platform
   `admin`) checked at the API layer; governs administrative surfaces only.
2. **Agent action authorization — our policy engine:**
   - Pure decision function in `packages/domain`:
     `decide(agent, tool, args, context) → allow | deny | require_approval` — no IO inside;
     callers supply a context object (grants, budgets, spend, task risk, policy rules) loaded
     transactionally by the Tool Gateway module in `apps/server`.
   - Evaluation order: identity → permission grants (`tool_permissions` with constraints JSONB) →
     policy rules (DB-backed, tenant-editable within bounds) → **autonomy decision matrix**
     (canonical, _DECISIONS §12): allow iff `risk ≤ maxRisk(autonomy_level)` AND
     `est_cost ≤ remaining budget` AND no rule denies; R3 always `require_approval` absent an
     explicit standing grant.
   - **Founder-only categories are hard-coded platform policy** — evaluated first, not stored as
     tenant data, not overridable (S6).
   - Every evaluation writes a `tool_invocations` audit row including the matched rule/reason;
     `require_approval` outcomes create Approval Engine requests whose verdicts signal waiting
     workflows.
   - There is **no bypass path**: all tool execution flows through the Gateway (S3), enforced by
     package boundaries (only the Gateway imports the dispatcher).

## Consequences

**Positive.**
- The autonomy model of the brief is implemented literally and testably: the matrix is a pure
  function with table-driven tests covering every level × risk × budget branch.
- Decisions are explainable to the Founder ("denied: R2 exceeds L2 ceiling; rule #14") — critical
  for trusting autonomous operation.
- Budget/cost coupling is transactionally exact; a hard budget breach flips decisions on the very
  next step (circuit breaker, _DECISIONS §18).

**Negative / accepted tradeoffs.**
- A bespoke engine means bespoke bugs; mitigated by keeping it pure/deterministic, exhaustive
  Vitest property tests, and the audit log doubling as a regression corpus.
- Tenant policy expressiveness is bounded by what our rule schema supports; deliberate — tenants
  get safe knobs, not a language.
- Per-step Gateway round-trip (internal HTTP) adds latency (~ms); acceptable against LLM-call
  timescales.

**Revisit triggers.**
- Policy rule schema grows past ~10 condition types or tenants demand arbitrary logic →
  re-evaluate an embedded expression language (CEL) inside our engine, not OPA.
- Multi-human Phase 3 introduces human fine-grained permissions → extend RBAC toward ABAC using
  the same engine.
- A compliance requirement demands externally auditable policy-as-code → export our rules to a
  reviewable format before considering OPA.

## References

- _BRIEF.md §2.10 (safety rails), §5 (autonomy model)
- _DECISIONS.md §12 (Tool Gateway & permissions), §18 (budgets), §20 (S3/S6/S7), §22 row 014
- ADR-004 (agent loop), ADR-009 (sandbox dispatch), ADR-013 (human authN)
