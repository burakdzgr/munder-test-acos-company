# AI AGENT COMPANY OS — Requirements Brief (Condensed, Binding)

This file condenses the Founder's 86-section specification. Every architecture document MUST satisfy it.
Canonical technical decisions live in `_DECISIONS.md` — that file wins on any conflict of naming or technology.

## 1. Product definition

A self-hosted / local-first **operating system for autonomous AI companies**. A user (the "Founder")
installs the platform on their own infrastructure, creates one or more Companies, builds an
organizational structure (departments, teams, executives, leads, engineers, marketers…), and hires
**persistent AI agent employees** into it. The organization then operates autonomously: it takes
Founder objectives, decomposes them through a real management hierarchy, executes work with tools
in sandboxes, communicates internally, learns from outcomes, and only escalates genuine
business-authority decisions to the Founder.

It is explicitly NOT: a chatbot, a CrewAI/LangGraph wrapper, a virtual-office game, an AI coding
assistant, or a bag of prompts.

## 2. Non-negotiable domain rules

1. **Autonomy first.** Founder is never interrupted for implementation details, reversible technical
   decisions, debugging, content ideas, task allocation, routine conflicts, or infra hiccups.
   Resolution order before any Founder escalation: own knowledge → agent memory → project memory →
   company memory → peers → specialists → team lead → manager → executive → Founder.
2. **Real corporate hierarchy.** Escalation follows reporting lines (e.g. Frontend Dev → Frontend
   Lead → Backend Lead → Engineering Manager → CTO → CEO → Founder). Founder is the LAST level.
3. **Founder escalations are structured briefs** (title, request, reason, what was attempted,
   options considered, recommendation, risk, cost, impact, urgency, deadline) — never raw agent chat.
   Founder-level topics: payments, banking, legal, new paid vendors, major pricing, large financial
   commitments, destructive production actions, security incidents, regulatory issues, physical-world
   actions, credentials only the Founder holds.
4. **Agent = persistent employee.** Identity (name, employee number, role, skills, memory,
   relationships, performance history) is fully decoupled from the underlying LLM. Swapping the model
   never changes who "Alex" is.
5. **Dynamic organization graph**, not a hardcoded tree. Typed edges: reports_to, manages, member_of,
   leads, mentors, collaborates_with.
6. **Domain core owns everything** (companies, agents, org, tasks, memory, skills, permissions,
   projects, events, policies, approvals). Third-party agent frameworks may only ever be replaceable
   adapters — never the source of truth. (Decision: we build the agent loop ourselves; see _DECISIONS.)
7. **Control plane vs execution plane** are explicitly separated. Execution (sandboxes, terminals,
   git, browsers, media) never holds domain state.
8. **Event-driven.** All significant behavior emits persisted, versioned, schema'd events. The UI
   digital twin renders ONLY real events — no fake animation.
9. **Durable execution.** Agent work survives app restart, host restart, worker crash, LLM timeout,
   network outage. Never "HTTP request → one LLM call → response".
10. **Safety rails.** Tool gateway validates agent/permission/company/project/risk/budget/policy
    before every tool execution. Least privilege. Sandboxed execution. Loop/runaway protection
    (max delegation depth, budgets, deadlines, retry limits, loop detection).
11. **Multi-company tenancy from day one** — isolation of agents, memory, projects, tasks, secrets,
    budgets, events per company.
12. **No consciousness imitation, no emotional simulation.** Functional professional agents only.

## 3. Memory (a core subsystem, not a feature)

- Three isolated primary scopes: **Company Memory, Project Memory, Agent Memory**.
- Memory types (minimum): semantic, episodic, procedural, decision, failure, experiment,
  relationship, artifact.
- Hybrid storage: relational for structured relations, vectors only where semantic retrieval helps.
- **Consolidation pipeline:** raw event → candidate extraction → importance scoring → scope
  detection → dedupe/similarity → contradiction detection → evidence analysis → confidence →
  classify → persist/merge/discard.
- **Overlearning prevention & promotion:** single incidents stay agent/project-scoped; repeated
  evidence promotes agent memory → project knowledge → company procedure.
- Memory records carry: source, evidence, scope, confidence, importance, created_at, last_verified,
  expiration, entities, relationships, version history.
- Frontend **Memory Observatory**: graph/timeline/list/search/cluster views over real stored
  memories, with filters (scope, agent, project, type, importance, confidence, time) and provenance
  inspection (why it exists, who created it, evidence, usage, related memories).

## 4. Skills, learning, careers

- Skills are first-class entities. Per-agent: level, experience, confidence, success/failure
  evidence, last used, assessment history. **Evidence-based growth only** — no "+10 XP" gamification.
  Evidence sources: successful implementations, accepted reviews, production results, peer/manager
  evaluations, experiment results, failure reduction, repeated application.
- Career ladder (Junior → Mid → Senior → Staff → Lead → Expert) driven by demonstrated competency;
  managers assign development objectives, mentoring, learning tasks, and recommend promotion.
- Engineering learning loop: work → validation → failure/success → reflection → memory candidate →
  consolidation → future retrieval. Marketing learning loop: publish → metrics → analysis →
  hypothesis → strategy adjustment → next content improves.

## 5. Work model

- **Task OS:** persistent tasks with full metadata (owner, department, priority, dependencies DAG,
  success criteria, risk, budget, approvals, artifacts, reviews, cost). Hierarchy:
  GOAL → INITIATIVE → EPIC → TASK → SUBTASK.
- Explicit task state machine with allowed transitions and per-role transition permissions.
- **Delegation engine:** managers decompose, delegate, balance capacity, resolve blockers, monitor
  quality, coordinate cross-team. CEO never assigns routine coding tasks directly to developers.
- **Communication system:** persistent DMs, team/department/project channels, task threads, review
  requests, escalations — stored independently of any LLM context.
- **Approval engine:** centralized Approval Center for the Founder with structured requests and
  APPROVE / REJECT / REQUEST EXECUTIVE REVIEW.
- **Autonomy model:** configurable levels (L0 observe … Founder authority) combined dynamically with
  action risk class, reversibility, cost vs budget, policy, and resource scope — not static levels alone.

## 6. Projects & engineering

- Project is a first-class entity (objective, repository, stakeholders, architecture, team, tasks,
  memory namespace, environments, integrations, deployments, analytics, experiments, docs, decisions).
- **Import existing local project** is critical: PROJECT INTAKE analyzes git, languages, frameworks,
  deps, structure, DB, APIs, tests, CI/CD, docs, security, debt, quality → INTAKE REPORT → automatic
  routing to CTO/architect/leads (and CPO/CMO when relevant). Founder only supplies business goal,
  desired outcome, constraints.
- Greenfield projects flow CEO → CPO → Architect → EM → Devs → QA → DevOps → CMO without Founder
  orchestration.
- Engineering workflow: requirement → technical design → decomposition → implementation → unit test
  → code review → architecture review → QA → security → CI → merge → deploy → monitor. No developer
  approves their own work.
- **Git execution model:** per-task isolated workspaces (worktrees inside containers), own branch,
  commits, tests, review; defined merge-conflict and locking strategy.
- **Architecture Guardian:** enforces module boundaries, dependency rules, ADRs, conventions;
  monitors complexity, cycles, duplication, drift, debt, coverage, security smells; proactively
  files refactoring tasks. Never escalates routine architecture problems to Founder.

## 7. Marketing & product (Phase 2 emphasis)

- Full marketing org (CMO, strategy/growth/SEO/social/content/creative/performance/CRM/brand/
  analytics/competitor-intel), platform-specialized social teams (Instagram strategist, Reels
  producer, copywriter, community, analytics).
- Reels production pipeline: research → audience → opportunity → concept → hook → script →
  storyboard → assets → generation → editing → voiceover → subtitles → branding → music → CTA →
  QA → publish → analytics → learning. Asset library with metadata + semantic search.
- Generic **Experiment Engine** (hypothesis, baseline, variant, metrics, sample size, result,
  confidence, decision, learning → memory).
- Product/UX agents monitor analytics, funnels, drop-off, support, retention, competitors and
  proactively drive fixes through the org.

## 8. Frontend product

- Feels like a **company command center**, not a chatbot. Views: Office, Tasks, Agents, Projects,
  Memory, Organization, Skills, Communication, Terminals, Approvals, Events, Reports, Costs, Settings.
- **Virtual office = digital twin.** Avatars in department areas; movement/interaction driven 1:1 by
  real backend events (e.g. agent.message.sent → avatar walks to recipient). No random animation.
- **Agent monitor** cards (status: IDLE/THINKING/WORKING/WAITING/COMMUNICATING/REVIEWING/TESTING/
  LEARNING/BLOCKED/ESCALATING/OFFLINE, current task, model, runtime, token/tool usage).
- **Real terminal observability:** stream actual sandbox terminal output (npm test etc.), secure,
  never simulated.
- Global company event timeline from persisted events. Live via WebSocket with reconnect/replay.

## 9. Operations

- Model provider abstraction (Anthropic, OpenAI, OpenRouter, Ollama, vLLM) with task-based routing
  on capability, cost, latency, privacy, risk.
- Cost tracking by company/department/team/agent/project/task (tokens, APIs, compute, tools, media).
- Production-grade security: secrets, sandboxing, fs isolation, network policy, audit log, RBAC/ABAC,
  tenant isolation, prompt-injection defenses, malicious-repo handling, external-content trust
  boundaries.
- Observability: OTel-based traces/metrics/logs for agents, tasks, workflows, events, queues, memory
  retrieval, LLM calls, tool calls, cost, latency, retries.
- Reliability: retries, timeouts, idempotency, circuit breakers, DLQs, heartbeats, stuck-agent
  detection; protection against infinite delegation/message loops/deadlock/starvation.
- Local-first: `git clone && cp .env.example .env && docker compose up` starts everything.
  Production: single server first, scalable workers later; no Kubernetes requirement for MVP.

## 10. Scale assumptions

1–10 companies per installation; 10–100 agents per company; 5–30 concurrently active agents;
thousands of tasks; millions of events over time; large memory collections. Design a scaling path
beyond this but do not gold-plate for it.

## 11. MVP proof (must be supported by the architecture)

Local start → create company → build org → hire agents (avatars, reporting lines) → create/import
project → Founder objective "Analyze this project and implement feature X" → CEO → CTO → EM →
tasks → developers in isolated workspaces → real inter-agent communication (visible in office) →
real terminals → code implemented → tests run → independent review → failures become learning
candidates → consolidation stores memory → skill evidence updates → project completes → CEO
executive report → zero routine technical questions to Founder.

Phase 2 adds the autonomous marketing org and its full learning loop.
