# 30 — Phase 2: The Autonomous Marketing Organization

Status: v1.0 — Implementation-ready

Phase 2 activates the marketing domain whose schema already shipped dark in MVP (`_DECISIONS.md`
§23, 16-MARKETING-DEPARTMENT.md). Goal: a marketing organization that autonomously runs the full
loop **publish → metrics → analysis → hypothesis → strategy adjustment → next content improves**
(`_BRIEF.md` §4), on real social platforms, with the same runtime, gateway, memory, and event
machinery as engineering — no new architectural primitives, only new tools, workflows, and views.

## 1. Marketing org structure (from `_BRIEF.md` §7)

Activation ships **org templates** (seed data in `packages/db`): one department, specialized
teams, positions with default skills and autonomy levels. Founder applies a template and adjusts.

```
Marketing Department (org_unit kind=department)
├── CMO (position: Chief Marketing Officer, reports_to CEO)
├── Strategy & Growth team — marketing strategist, growth analyst
├── SEO team — SEO specialist
├── Content team — content lead, copywriter(s)
├── Creative team — creative director, designer, Reels producer, video editor
├── Performance team — performance marketer (ads; gated, money-scope tools)
├── CRM team — CRM/lifecycle specialist
├── Brand team — brand manager
├── Analytics team — marketing analyst
├── Competitor-intel — competitor intelligence analyst
└── Social team (platform-specialized), e.g. Instagram pod:
    Instagram strategist, Reels producer, copywriter, community manager, analytics specialist
```

All are ordinary `agents` with `org_edges` — the delegation engine, escalation chains, autonomy
matrix, and skill system apply unchanged. CMO receives marketing goals from CEO exactly as CTO
receives engineering goals.

## 2. Social integrations — adapter design

Per ADR-017, integrations are adapters in the `integrations` module of `apps/server`, exposed to
agents ONLY as tools in `packages/tools` (risk classes enforced by the Tool Gateway).

Port (in `packages/domain`): `SocialChannelPort` with capabilities:
`publishPost`, `publishReel`, `schedulePost`, `getPostMetrics`, `getAccountMetrics`,
`listComments`, `replyToComment`, `deleteOwnPost`. Adapters implement a capability subset and
declare it (`supports()`); the first adapter is **Instagram Graph API** (A7; which platforms come
next is an open Founder-clarification item, `_DECISIONS.md` §0).

- **Credentials:** per-company `integration_connections` rows; OAuth tokens sealed with libsodium
  (S2 — agents never see tokens; adapters inject server-side). Connecting an account is a
  Founder-side UI flow in Settings.
- **Tool mapping & risk:** `social.publish_post`, `social.publish_reel` → **R3**
  (external-world) ⇒ `require_approval` unless a standing policy grant exists (e.g. Founder
  pre-approves publishing to a specific account within a monthly cap — the `_DECISIONS.md` §12 L5
  "limited R3 within pre-approved budget lines" case). `social.get_metrics`, `social.list_comments`
  → R0. `social.reply_comment` → R2 (brand risk). `ads.*` tools (Performance team) touch the
  `money` scope → always Founder-gated (A8).
- **Rate limits & retries:** adapter-level token buckets persisted in Postgres unlogged tables;
  429/5xx → Temporal activity retry with backoff; permanent failures emit
  `integration.call.failed` and surface as blockers, never Founder pings.
- **Ingestion:** each connection gets a scheduled Temporal workflow `analyticsIngestionWorkflow`
  (§5) — no inbound webhooks required (self-hosted friendliness); webhook receivers are an
  optional optimization behind the same adapter port.

## 3. Reels production pipeline as a Temporal workflow

The `_BRIEF.md` §7 pipeline (research → … → publish → analytics → learning) is implemented as
`reelsProductionWorkflow` — a Temporal workflow that **orchestrates stages, while each stage's
creative work is a normal task** executed by the owning agent via `agentTaskWorkflow`. The
pipeline workflow creates stage tasks, waits on their completion signals, enforces stage gates,
and carries the artifact chain. This keeps the org model honest: agents do work through the task
engine; the pipeline is coordination.

Stages (canonical order; stage names are workflow markers and task titles):

| # | Stage | Owner (default) | Gate to next |
|---|---|---|---|
| 1 | research | Instagram strategist | opportunity brief artifact |
| 2 | audience | strategist | audience definition |
| 3 | opportunity | strategist | scored opportunity ≥ threshold |
| 4 | concept | creative director | concept approved by CMO-chain |
| 5 | hook | copywriter | hook variants (≥3) |
| 6 | script | copywriter | script artifact |
| 7 | storyboard | Reels producer | storyboard artifact |
| 8 | assets | designer | asset refs in library (§6) |
| 9 | generation | Reels producer | media generated (§8) |
| 10 | editing | video editor | cut v1 |
| 11 | voiceover | producer | VO track (TTS adapter) |
| 12 | subtitles | producer | srt artifact |
| 13 | branding | brand manager | brand-check pass |
| 14 | music | producer | licensed/library track selected |
| 15 | cta | copywriter | CTA overlay final |
| 16 | qa | independent reviewer (≠ producer) | QA checklist pass |
| 17 | publish | community manager | Tool Gateway R3 path (approval/standing grant) |
| 18 | analytics | analytics specialist | metrics snapshots at T+1h/24h/72h/7d |
| 19 | learning | analytics specialist | experiment/learning memory candidates emitted |

Failures at any gate loop back as `CHANGES_REQUESTED` on the stage task (max 3 loops per stage,
then escalate to CMO — reuse of task-engine reassignment limits). Every stage emits
`pipeline.stage.completed` events; the Office and a pipeline Kanban view render real progress.
Media-heavy activities run on execution-worker in the `media` isolation level (`_DECISIONS.md`
§13) with heartbeats and idempotent re-generation keyed by artifact hash.

## 4. Experiment engine activation

Tables shipped in MVP; Phase 2 adds the engine + UI. `experiments`: id, company_id, project_id,
hypothesis, baseline_ref, variant_ref, primary_metric, secondary_metrics JSONB, sample_size_target,
status (`designed → baseline → running → analyzing → {adopted, rejected, inconclusive}` — §19
canonical), result JSONB, confidence, decision_note, learning_memory_id.
`experimentWorkflow` (agent-worker): register baseline → launch variant (often a pipeline run with
a controlled difference, e.g. hook A/B) → collect metrics via §5 until sample/window met → analyze
(deterministic stats first: two-proportion z-test for rate metrics [WRITER-DECISION]; LLM only for
narrative) → decision by owning strategist → **learning**: emit a `memory` candidate of type
`experiment` with evidence rows pointing at the metric snapshots, feeding the standard
consolidation pipeline (12-MEMORY-ARCHITECTURE.md). Adopted results update strategy documents
(project-scope procedural memory) — this is the mechanism by which "next content improves".

## 5. Analytics ingestion

`analyticsIngestionWorkflow` per integration connection (cron-style Temporal schedule, default
hourly): pull account + per-post metrics via adapter → upsert `metric_snapshots`
(id, company_id, connection_id, entity_kind (`post|reel|account|campaign`), entity_ref, metric,
value, captured_at) — append-only time series, deduped on (entity_ref, metric, captured_at bucket)
[WRITER-DECISION: `metric_snapshots` table name/shape]. Deltas that cross configured significance
thresholds emit `analytics.metric.updated` events, which wake the analytics specialist's inbox
workflow — analysts *react* to data, they don't poll. Cost of API calls lands in `cost_entries`
(kind=`api`).

## 6. Asset library

`assets`: id, company_id, project_id, kind (`image|video|audio|copy|template|brand_element`),
title, description, storage_ref (`/data/assets/<company_id>/<asset_id>` on a named volume),
mime, bytes, checksum, metadata JSONB (dimensions, duration, platform, campaign, tags[]),
embedding vector + embedding_model (semantic search over title+description+tags via pgvector,
same per-row dimension strategy as memories, ADR-020), created_by_agent_id, source
(`generated|uploaded|derived`), license_note, created_at.
Tools: `asset.search` (R0, semantic + filters), `asset.get`, `asset.store` (R1). The library view
adds gallery + semantic search to the frontend. Derived assets link via metadata
`derived_from_asset_id`, giving reuse provenance (which hook/beat/template produced results —
queryable by the learning loop).

## 7. Browser sandbox level

Phase 2 adds the `browser` isolation level (`_DECISIONS.md` §13): separate image
`acos/workspace-browser` (Playwright + Chromium), no worktree mount, egress through the allowlist
proxy with a per-task-approved domain list, screenshots/DOM extracts returned as artifacts. Used
by competitor-intel and research stages. All fetched content is untrusted: wrapped with provenance
markers in prompts, and instruction-following from it is policy-flagged (S5). Tool:
`browser.session` (R1; R2 if credentialed session).

## 8. Media generation adapters

`MediaGenerationPort` with purposes `image`, `video`, `tts`, `music` — external APIs only (A9, no
GPU assumed). Adapters configured per company in `model_profiles`-style rows
(`media_profiles`: purpose → provider+model+params+cost caps [WRITER-DECISION: `media_profiles`
table]). Every generation logs `cost_entries` (kind=`media`) and stores output into the asset
library with `source=generated` and full prompt/parameter metadata for reproducibility. Provider
choice is config, not architecture; default examples wired: OpenAI images, ElevenLabs TTS
[WRITER-DECISION: default media adapter set — replaceable per install].

## 9. Phase-2 acceptance demo

Executable as `apps/web/e2e/phase2-demo.spec.ts` (social adapter mocked at the HTTP boundary in
CI; live against a sandbox Instagram account manually):

1. Apply marketing org template; hire CMO + Instagram pod; connect Instagram account (Founder OAuth
   in Settings).
2. Founder objective to CEO: "Grow Instagram engagement for project P" → CEO → CMO → **strategy**
   document produced (project-scope procedural memory + tasks).
3. Strategy spawns a `reelsProductionWorkflow`; stages 1–16 complete autonomously with real
   artifacts in the asset library; office/pipeline views show real stage events.
4. **Publish**: R3 tool call → Approval Center brief (first time) → Founder approves + grants a
   standing policy for this account/cap → post published via adapter.
5. **Analytics**: ingestion workflow captures metric snapshots; `analytics.metric.updated` wakes
   the analytics specialist.
6. **Experiment**: strategist runs hook A/B via experiment engine on the next two Reels; workflow
   reaches `adopted` with confidence recorded.
7. **Learning**: experiment + analysis produce memory candidates; consolidation promotes a
   procedural "what works" memory to project scope; Observatory shows provenance to the metric
   evidence.
8. **Improved next content**: the next pipeline run's Working Set retrieves that memory (visible
   in the run's working-set inspection), concept/hook cite it, and the run completes publish
   without Founder interaction (standing grant). Assertion: zero routine marketing questions in
   the Approval Center after step 4.

## 10. Schema and event additions (all additive)

Dark-shipped MVP tables now activated: `experiments`, `assets`, marketing org templates. Newly
added (additive migrations): `integration_connections`, `metric_snapshots`, `media_profiles`,
`assets.derived_from_asset_id` metadata convention. New events registered in `packages/events`:
`pipeline.stage.completed`, `pipeline.stage.failed`, `marketing.content.published`,
`analytics.metric.updated`, `experiment.status.changed`, `experiment.adopted`,
`asset.created`, `integration.connected`, `integration.call.failed`
[WRITER-DECISION: Phase-2 event name additions, following `domain.entity.action` past-tense
convention]. All are versioned Zod schemas; consumers declare handled versions
(10-EVENT-ARCHITECTURE.md).

New tools registered in `packages/tools` (risk classes as in §2/§7/§8): `social.publish_post` (R3),
`social.publish_reel` (R3), `social.get_metrics` (R0), `social.list_comments` (R0),
`social.reply_comment` (R2), `ads.create_campaign` (R3, money), `asset.search` (R0),
`asset.get` (R0), `asset.store` (R1), `browser.session` (R1/R2), `media.generate` (R2, costed).

## 11. Phase-2 risks & mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Platform API instability (Instagram Graph API versioning, review processes) | Publish/ingest breakage | Adapter isolation behind `SocialChannelPort`; contract tests on recorded fixtures; capability flags let the org degrade (e.g. manual-publish task for the Founder as R3 fallback brief) |
| R3 standing grants drift into over-permission | Brand/spend risk | Grants are scoped (account, cap, expiry) policy rows; every use audited; monthly automatic expiry forces re-approval [WRITER-DECISION: standing grants expire after 30 days by default] |
| Media generation cost blowup | Budget burn | `media_profiles` cost caps + per-pipeline budget inherited from the goal task; circuit breaker (`budget.exceeded`) pauses pipelines like any agents |
| Metrics too sparse for experiments (low-follower accounts) | Inconclusive loop | Experiment engine requires sample-size targets up front; `inconclusive` is a first-class outcome that produces a memory candidate ("insufficient reach for hook A/B at N followers") instead of a false learning |
| Prompt injection via comments/competitor content | Policy-violating actions | S5: all ingested external text carries provenance markers; instruction-following from it is policy-flagged; risky tool calls triggered by external content require elevated review (18-PERMISSIONS-AND-SECURITY.md) |
| Pipeline stalls on creative-quality loops | Slow content velocity | Max 3 gate loops per stage then CMO escalation; CMO can lower gate thresholds by policy, never the Founder |

## 12. Milestones

| | Scope | Definition of Done |
|---|---|---|
| P2-M1 Foundations | Org templates, integration connections + Instagram adapter, tool defs + gateway wiring, asset library + storage + semantic search | Demo steps 1 pass; adapter contract tests green against recorded fixtures; R3 publish path verified to hard-require approval |
| P2-M2 Pipeline | `reelsProductionWorkflow` stages 1–17, media generation adapters, browser sandbox level, brand/QA gates | Steps 2–4 pass; stage-loop and escalation limits proven in tests; media costs tracked |
| P2-M3 Analytics & experiments | `analyticsIngestionWorkflow`, metric snapshots, experiment engine + UI, threshold events | Steps 5–6 pass; deterministic stats unit-tested; ingestion resilient to adapter outages (retry + `integration.call.failed`) |
| P2-M4 Learning loop closure | Experiment/analysis → memory candidates, strategy-doc updates, working-set retrieval proof, pipeline/asset/experiment frontend views | Steps 7–8 pass; full §9 suite green with mocked adapter; manual live run executed once end-to-end |

Phase 2 adds zero new core primitives: everything above composes the MVP's runtime, task engine,
gateway, events, and memory. That is the test of the architecture — and the reason marketing
activation is a phase, not a rewrite.
