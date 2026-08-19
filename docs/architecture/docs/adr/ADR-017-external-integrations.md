# ADR-017: External Integrations — Adapter Pattern in the Integration Module, MCP-Compatible Where Useful

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

Agents reach the outside world through tools: MVP integrations are git, GitHub (optional),
filesystem, terminal, database inspector, and web fetch/search; Phase 2 adds social platforms
(Instagram Graph API etc.), ads, analytics, and media generation APIs (_DECISIONS §0 A7). Forces:

- **Everything passes the Tool Gateway.** No integration may bypass permission grants, the policy
  engine, risk classification, budget checks, or audit (invariants S3, S5) — so integrations must
  present themselves as tools in `packages/tools` with Zod schemas, risk classes, touched scopes,
  and cost estimators (_DECISIONS §12).
- **Credentials never reach agents** (S2): adapters receive decrypted credentials server-side from
  the secrets store; prompts see capability names only.
- **External content is untrusted** (S5): fetched pages, repos, and analytics responses must be
  provenance-wrapped before entering prompts (prompt-injection defense).
- **Self-hosted:** no cloud automation dependency; integrations must work from the Founder's
  server, with egress through the allowlist proxy where sandbox-originated.
- **Extensibility:** Phase 3 envisions a marketplace of tool adapters; the MVP shape should not
  preclude third-party additions. MCP (Model Context Protocol) has become the de-facto standard
  for tool servers — a growing catalog we would be foolish to wall off, but equally must not let
  bypass the Gateway.

## Options considered

### Option A: Embedded n8n as the integration layer

- **Description.** Run n8n in compose; model integrations as n8n workflows the platform invokes.
- **Pros.** Hundreds of ready connectors; visual editing; credentials management included; already
  self-hostable.
- **Cons.** A whole second platform embedded in ours: its own DB, auth, execution engine, and UI.
  Integration state and credentials would live in n8n (source-of-truth and S2 violations); every
  call would leave our typed, risk-classed, audited tool path and re-enter as an opaque webhook.
  Debugging spans two systems. The Gateway's per-call decision (allow/deny/require_approval)
  cannot reach inside an n8n workflow's steps.
- **Rejected because** an extra platform with its own state and credential store cannot sit inside
  our security invariants.

### Option B: Zapier / Make (cloud automation)

- **Description.** Delegate integrations to cloud automation services via webhooks.
- **Pros.** Widest connector catalog; zero connector maintenance for us.
- **Cons.** Cloud dependency contradicts self-hosted/local-first; credentials live in a third
  party; per-task pricing; offline profile impossible; audit and risk classification of individual
  actions is out of our hands.
- **Rejected because** cloud-only — incompatible with the product's deployment model.

### Option C: Direct ad-hoc API calls from agent code

- **Description.** No integration layer: activities call external APIs directly where needed.
- **Pros.** No abstraction; fastest first integration.
- **Cons.** Scatters credentials handling, retries, rate limits, and risk classification across
  call sites; makes S3 unenforceable (bypass paths multiply); Phase 2's integration surge
  (social/ads/analytics) would harden the scatter into architecture.
- **Rejected because** it structurally erodes the Gateway invariant and audit completeness.

### Option D: Adapter pattern in an integration module + MCP compatibility (chosen)

- **Description.** One integration module in `apps/server` hosting typed adapters behind a common
  port; each adapter's operations are registered as tools; MCP servers mountable as a special
  adapter class whose tools are imported into the same registry.
- **Pros.** One choke point satisfying S2/S3/S5; typed and testable; MCP opens the ecosystem
  without forking the security model; marketplace-ready shape.
- **Cons.** Each first-party connector is our work; MCP tool schemas/risk classes need curation
  on import (they arrive without our risk metadata).

## Decision

External integrations live in a single **integration module** in `apps/server`, as **adapters
behind a common port**:

- **Adapter contract:** each adapter (git-remote/GitHub, web-fetch, web-search, db-inspector,
  Phase 2 social/ads/media) declares its operations as tool definitions in `packages/tools` —
  Zod input/output, risk class (R0–R3), touched scopes, cost estimator. Adapters implement
  execution only; **dispatch always comes from the Tool Gateway** after authorization
  (_DECISIONS §12): network tools via the egress allowlist, money/publish tools via integration
  adapters with R2/R3 classes.
- **Credentials:** adapters fetch decrypted credentials from the secrets store (libsodium
  envelope encryption) at execution time, server-side only; nothing credential-shaped enters
  prompts or sandboxes (S2).
- **Untrusted-content wrapping:** every adapter returning external content (web pages, repo
  files, API payloads) tags it with provenance markers; the prompt assembler renders these as
  untrusted blocks, and the policy engine flags risky tool calls directly induced by such content
  for elevated review (S5).
- **MCP compatibility where useful:** an `mcp-adapter` can mount external MCP servers
  (stdio/HTTP); their tools are imported into the tool registry **with operator-assigned risk
  class, scopes, and permission defaults required before activation** (no auto-trust), then flow
  through the identical Gateway path. Our own tools may optionally be exposed *as* an MCP server
  later; that is out of MVP scope.
- Retries/timeouts/rate limits are implemented per adapter with shared helpers; results and costs
  are recorded on `tool_invocations`/`cost_entries` like any tool.

## Consequences

**Positive.**
- One integration architecture serves MVP git/web tools and Phase 2's social/media surge without
  structural change — new integration = new adapter + tool definitions + permissions.
- Security invariants hold by construction: single dispatch path, server-side credentials,
  provenance-wrapped content, complete audit.
- MCP support future-proofs the catalog (community tool servers) and seeds the Phase 3
  marketplace, all inside our authorization model.

**Negative / accepted tradeoffs.**
- We write and maintain first-party connectors; accepted — MVP needs only a handful, and each is
  small behind the shared contract.
- MCP tools require manual risk/scope curation before use — deliberate friction; an unreviewed
  tool server must never gain Gateway trust automatically.
- The integration module lives in the control-plane monolith; heavy adapters (media generation)
  may later warrant extraction to a worker — the port makes that a move, not a redesign.

**Revisit triggers.**
- 20 adapters or one adapter dominating server resources → extract an integration-worker
  process.
- MCP standardizes risk/permission metadata → replace manual curation with verified import.
- Marketplace launch (Phase 3) → packaging/signing/sandboxing of third-party adapters gets its
  own ADR.

## References

- _BRIEF.md §2.10 (safety rails), §7 (Phase 2 integrations), §9 (security)
- _DECISIONS.md §0 A7, §12 (Tool Gateway), §20 (S2/S3/S5), §22 row 017
- ADR-009 (egress proxy), ADR-014 (authorization), ADR-015 (LLM adapters — same port philosophy)
