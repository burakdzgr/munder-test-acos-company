# 01 — Product Scope

Status: v1.0 — Implementation-ready

## 1. Formal system definition

**AI Agent Company OS** is a self-hosted platform on which a human Founder operates one or more
autonomous AI companies. Each company is a persistent organization of AI agent employees arranged
in a real management hierarchy that receives business objectives, decomposes them, executes them
with sandboxed tools, communicates internally, learns from outcomes, and escalates only genuine
business-authority decisions to the Founder.

Formally, the system is a tuple of:

- a **domain core** (companies, agents, organization graph, tasks, projects, memory, skills,
  channels, approvals, policies, budgets, events) persisted in PostgreSQL and owned entirely by
  our code (`_BRIEF.md` rule 6);
- an **agent runtime** that turns each active task assignment into a durable Temporal workflow
  (08-AGENT-RUNTIME.md);
- an **execution plane** of sandboxed workspace containers reached only through the Tool Gateway
  and sandbox-manager (02-SYSTEM-CONTEXT.md §3, 17-TOOL-GATEWAY.md);
- a **command-center frontend** whose every rendered fact derives from persisted domain events
  (23-VIRTUAL-OFFICE.md, 24-FRONTEND-ARCHITECTURE.md).

### 1.1 Actors

| Actor | Description | Interface |
|---|---|---|
| **Founder** | The human owner-operator. Sets objectives, approves Founder-level decisions, watches the company work. The ONLY human user in MVP (A1). Terminal node of every escalation chain; a virtual org node, never an `agents` row. | apps/web SPA; REST API via PAT |
| **Agent employees** | Persistent AI employees: identity, employee number, role, seniority, skills, memory, relationships, performance history — all decoupled from any LLM. They plan, code, review, test, communicate, learn, escalate. | Agent runtime (Temporal workflows); tools via Tool Gateway |
| **The platform** | Non-agent system machinery: outbox relay, consolidation workflows, Office Projector, budget circuit breakers, schedulers. Acts as event `actor.kind = system`. | Internal |

Phase 3 adds additional human users (co-founders, human employees) via OIDC — see 31-PHASE-3.md.

### 1.2 What the product IS

- An **operating system for companies**: org chart, HR (hire/pause/offboard), task OS, projects,
  internal comms, approvals, budgets, reports.
- A **durable multi-agent runtime**: agent work survives restarts of app, host, worker, and
  provider outages (rule 9).
- A **learning organization**: memory consolidation, evidence-based skills, career progression
  (12-MEMORY-ARCHITECTURE.md, 13-SKILL-AND-LEARNING-SYSTEM.md).
- A **command center with a digital twin**: office, terminals, timelines, observatories rendering
  only real events (rule 8).
- **Self-hosted and local-first**: one `docker compose up`; no mandatory SaaS dependencies beyond
  LLM APIs (A3 allows a degraded Ollama-only profile).
- **Multi-company from day one** (rule 11).

### 1.3 What the product IS NOT

- **Not a chatbot.** The Founder states objectives and reads reports/approvals; there is no
  "chat with the AI" as the primary interaction model.
- **Not a framework wrapper.** No CrewAI/LangGraph/MetaGPT/OpenHands in the core (ADR-004);
  third-party agent tech may only ever appear as a replaceable adapter.
- **Not a virtual-office game.** The office renders real events; there is no random ambient
  animation, no simulated activity, ever.
- **Not an AI coding assistant.** Engineering is one department of a whole company; the unit of
  value is an operating organization, not autocomplete.
- **Not a bag of prompts.** Behavior lives in state machines, policies, schemas, and workflows;
  prompts are assembled artifacts of `packages/llm`, not the architecture.
- **Not a consciousness simulator** — see §7 Non-goals.

## 2. Core user experience flows

The Founder's end-to-end journey (each step maps to concrete screens in
24-FRONTEND-ARCHITECTURE.md and APIs in 21-API-DESIGN.md):

1. **Install & start.** `git clone && cp .env.example .env && docker compose up` → first-run wizard
   creates the Founder user (Argon2id password, optional TOTP) and platform model providers.
2. **Create company.** Name, currency (A4), output language (A5), default budgets and autonomy
   defaults. Emits `company.created`.
3. **Build the organization.** Create org units (departments/teams), define positions (title,
   seniority track, default role), wire typed edges. Org chart view (Cytoscape.js) reflects the
   graph live. Emits `org.unit.created`, `org.edge.created`.
4. **Hire agents.** Pick position, name, avatar, persona, seniority, autonomy level, model bindings
   (or accept company profile defaults). Agent appears in the office at their department area.
   Emits `agent.hired` (05-AGENT-LIFECYCLE.md).
5. **Create or import projects.** Greenfield: objective + constraints → project `proposed`.
   Import: local path or URL → bare repo copy → `projectIntakeWorkflow` → Intake Report → automatic
   routing to CTO/architect/leads (14-PROJECT-RUNTIME.md). Founder supplies only business goal,
   desired outcome, constraints.
6. **Set objectives.** Founder writes an objective ("Analyze this project and implement feature X")
   against a company or project. This creates a `tasks` row with `kind=goal`, owner = CEO agent,
   and emits `task.created`. From here the hierarchy takes over.
7. **Watch and decide.** Founder observes the Office (digital twin), Tasks board, Agent monitors,
   Terminals, Memory Observatory, Event timeline, Cost dashboards — and acts only in the Approval
   Center and on executive reports.

### 2.1 The command-center views (binding set, `_BRIEF.md` §8)

| View | Founder sees | Primary data source |
|---|---|---|
| Office | Digital-twin office; avatars act on real events only | Office Projector instructions over `/ws` |
| Tasks | Boards/DAG per project & department, state machine live | `tasks` + `task.status.changed` |
| Agents | Monitor cards: status, current task, model, runtime, token/tool usage | `agent_sessions` + presence events |
| Projects | Portfolio, intake reports, environments, deployments (P3) | `projects` module |
| Memory | Observatory: graph/timeline/list/search/cluster + provenance | `memories` + relations/evidence |
| Organization | Org chart, typed edges, positions, escalation chains | `org_edges` (Cytoscape) |
| Skills | Per-agent skill levels, evidence, career progression | `agent_skills` + `skill_evidence` |
| Communication | Channels, DMs, task threads, review requests, escalations | `channels`/`messages` |
| Terminals | Live sandbox PTY streams, scrollback replay | NATS frames + ring buffer |
| Approvals | Approval Center: structured briefs, verdicts | `approvals` |
| Events | Global company timeline, filterable, gap-free | `events` table replay |
| Reports | Executive reports, weekly summaries | report artifacts |
| Costs | Spend by company/department/team/agent/project/task | `cost_entries` rollups |
| Settings | Company config, model profiles, budgets, integrations, policies | respective modules |

## 3. The real-company management model

The organization behaves like a real company (rule 2):

- **Reporting lines are the law.** `org_edges(kind=reports_to)` forms a forest per company
  (cycle-checked on write). Delegation flows down; escalation walks up. Example chain:
  Frontend Dev → Frontend Lead → Backend Lead → Engineering Manager → CTO → CEO → Founder.
- **Managers manage.** Decompose goals into initiatives/epics/tasks, delegate along `manages`
  edges, balance capacity, resolve blockers, monitor quality, coordinate cross-team. The CEO never
  assigns routine coding tasks directly to developers (07-TASK-ENGINE.md delegation engine).
- **Escalation-chain rule (canonical):** an agent facing a problem MUST exhaust, in order:
  (1) own knowledge → (2) agent memory → (3) project memory → (4) company memory → (5) peers
  (`collaborates_with`) → (6) specialists (skill lookup) → (7) team lead → (8) manager →
  (9) executive → (10) Founder. Each hop is a real recorded action (`request_help`, `escalate`)
  producing messages and events; skipping levels is rejected by the runtime guard in
  08-AGENT-RUNTIME.md and re-routed to the next unexhausted level. The Founder is the last level,
  reached only for Founder-level topics (§5) or when the full chain has failed.
- **No self-approval.** No developer approves their own work; reviewer must be a different agent
  with reviewer capability (task state machine permissions, `_DECISIONS.md` §7).

## 4. Autonomy-first principle

### 4.1 The "never interrupt the Founder for X" list (binding)

The Founder is NEVER interrupted for:

1. Implementation details (naming, libraries within policy, code structure).
2. Reversible technical decisions (anything undoable by revert/rollback, risk ≤ R1).
3. Debugging and troubleshooting of any kind.
4. Content ideas, drafts, creative direction within brand policy.
5. Task allocation, scheduling, prioritization within existing objectives.
6. Routine interpersonal/priority conflicts between agents.
7. Infrastructure hiccups (retries, provider failover, flaky tests, transient outages).
8. Routine architecture problems (Architecture Guardian files refactoring tasks itself,
   15-ENGINEERING-DEPARTMENT.md).
9. Anything a manager/executive in the chain is empowered to decide under the autonomy matrix
   (06-AUTONOMY-AND-ESCALATION.md).

Enforcement is structural, not aspirational: `escalate`-to-Founder actions are validated against
the Founder-level topic list; out-of-scope escalations are converted into `request_help` to the
next chain level, and the offending pattern is recorded as a failure-memory candidate.

### 4.2 Resolution order

The ten-step order in §3 is evaluated by the agent runtime before any `escalate` action is
accepted: the Working Set records which levels were consulted (memory retrievals, help requests,
manager directives), and the guard requires evidence of prior levels before allowing an upward hop.

### 4.3 Founder-level topics (always escalate, never decide autonomously)

Payments and banking; legal commitments; new paid vendors; major pricing decisions; large financial
commitments beyond pre-approved budget lines; destructive production actions; security incidents;
regulatory issues; physical-world actions; credentials only the Founder holds. These map to
platform-hard-coded policy (`_DECISIONS.md` §12, security invariant S6) — not tenant-editable, and
always `require_approval` regardless of autonomy level (A8).

## 5. Founder-escalation content contract

Every escalation that reaches the Founder is a structured brief — never raw agent chat (rule 3).
The Approval/Escalation entity carries exactly these fields (19-APPROVAL-ENGINE.md;
`approvals.request_md` structured sections):

| Field | Content |
|---|---|
| `title` | One line, decision-focused |
| `request` | The specific decision or authority being requested |
| `reason` | Why this reached the Founder (which chain levels were exhausted and why) |
| `attempted` | What was already tried (with refs to tasks/events) |
| `options` | 2+ options considered, each with tradeoffs |
| `recommendation` | The chain's recommended option, with the endorsing executive |
| `risk` | Risk class + concrete downside scenarios |
| `cost` | Estimated cost in company currency (minor units) |
| `impact` | Business impact of approve/reject/delay |
| `urgency` | `low|normal|high|critical` [WRITER-DECISION: enumeration values] |
| `deadline` | When a decision is needed and what happens on expiry |

The Approval Center renders these with verdicts **APPROVE / REJECT / REQUEST EXECUTIVE REVIEW**
(`needs_review` loops back down the endorsement chain). Verdicts signal waiting workflows
(`approvalVerdict` signal, 08-AGENT-RUNTIME.md).

## 6. Critical success criteria

From `_BRIEF.md` §11 (the 25-step demo in 29-MVP-PLAN.md §3 is the executable form) and the
Founder specification's acceptance section (§83 of the original spec):

1. Local start with `docker compose up`; no cloud dependency except LLM APIs.
2. Founder can create a company, build an org, and hire agents with avatars and reporting lines
   entirely through the UI.
3. Founder can create/import a project; import produces an Intake Report and auto-routed tasks
   without Founder orchestration.
4. A single Founder objective flows CEO → CTO → EM → tasks → developers with zero Founder
   involvement in decomposition or assignment.
5. Developers work in isolated per-task workspaces with real branches; their real terminal output
   is streamed live to the UI (never simulated).
6. Inter-agent communication is real, persisted, and visibly drives the office digital twin.
7. Code is implemented, tests actually run, and an independent agent reviews before merge.
8. Failures become learning candidates; consolidation stores memories with provenance visible in
   the Memory Observatory; skill evidence updates from outcomes.
9. The project completes with a CEO executive report to the Founder.
10. **Zero routine technical questions reach the Founder** during the entire flow — the Approval
    Center contains only genuine Founder-level items.
11. Kill any worker or restart the host mid-run: all agent work resumes without loss (rule 9).
12. Two companies on one installation share nothing: agents, memory, tasks, events, secrets,
    budgets fully isolated (rule 11).

Phase 2 success adds the marketing loop (30-PHASE-2.md §9); Phase 3 success adds multi-human and
hardening targets (31-PHASE-3.md).

## 7. Explicit non-goals

- **No consciousness imitation, no emotional simulation** (rule 12). Agents are functional
  professionals: no moods, feelings, relationships-as-drama, or personality theatrics. `persona`
  is a short professional bio for prompt grounding only. Relationship edges
  (`collaborates_with` strength) are computed collaboration statistics, not emotions.
- **No general AGI ambitions.** The system orchestrates bounded, tool-using, policy-governed work.
- **No platform monetization design** (A10).
- **No physical-world actuation.** Physical actions are Founder-level by definition (§4.3).
- **No mobile app, no SaaS multi-tenant hosting** in scope; self-hosted single-tenant-per-install.
- **No Kubernetes requirement for MVP** (ADR-018).

## 8. Scale assumptions

Binding envelope from `_BRIEF.md` §10:

| Dimension | Design target |
|---|---|
| Companies per installation | 1–10 |
| Agents per company | 10–100 |
| Concurrently active agents | 5–30 |
| Tasks | thousands (lifetime) |
| Events | millions (lifetime, append-only) |
| Memories | large collections (100k+ rows/company) |
| Hardware baseline | 8+ cores, 16+ GB RAM, Linux + Docker (A2) |

Consequences taken in this package: single Postgres suffices (ADR-003); idle agents consume no
workflow resources (08-AGENT-RUNTIME.md); per-company event sequences keep replay cheap
(22-REALTIME-ARCHITECTURE.md); the 10× scaling path (read replicas, NATS clustering, worker pools)
is designed but deferred to 31-PHASE-3.md — no gold-plating in MVP.
