# ADR-004: Agent Orchestration — Our Own Agent Loop on Temporal, No Agent Framework in Core

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

This is the most consequential decision in the system. The product is an operating system for
autonomous AI companies: persistent agent employees whose identity, memory, skills, relationships,
and performance history are fully decoupled from any LLM (_BRIEF §2.4), operating inside a real
corporate hierarchy with delegation, review, escalation, and an approval engine. The spec is
emphatic (its section 29, condensed in _BRIEF §2.6): **the domain core owns everything; third-party
agent frameworks may only ever be replaceable adapters — never the source of truth.**

Hard requirements the orchestration layer must satisfy:

- **Durability.** Agent work survives app restart, host restart, worker crash, LLM timeout, network
  outage (_BRIEF §2.9). Never request→LLM→response.
- **Our state, our schema.** Task state machine, delegation limits, autonomy matrix, budget guards,
  loop detection (_DECISIONS §7–§8, §12) are domain policies that must execute against Postgres
  state — not framework-internal graph state.
- **TypeScript.** The whole stack is TS (ADR-002); a Python-only core would split the codebase.
- **Signals.** Agents receive messages, review verdicts, approval verdicts, manager directives as
  asynchronous signals into long-running executions (_DECISIONS §8, §14).
- **Replaceability.** Anything third-party in the agent path must be swappable without touching
  domain state.

## Options considered

### Option A: CrewAI (and similarly MetaGPT) as the agent core

- **Description.** CrewAI: role-based multi-agent framework (crews, tasks, process types);
  MetaGPT: SOP-driven software-company simulation with predefined roles. Both genuinely pioneered
  multi-agent role patterns and would give us working delegation out of the box.
- **Pros.** Fast start; battle-tested prompt patterns for role play and hand-offs; MetaGPT in
  particular encodes a software-company workflow close to our MVP proof; active communities.
- **Cons / disqualifiers.** Both **own the orchestration**: crew/team state, task hand-offs, and
  memory live inside the framework's runtime — precisely the source-of-truth violation the spec
  forbids. Their "memory" is not our consolidation pipeline; their "tasks" are not our task engine
  with state machines, budgets, and approval gates. Durability is process-bound (a crash loses the
  crew run). Both are Python-first, splitting the stack. Our org is a dynamic graph with typed
  edges, not a static crew definition.
- **Rejected because** adopting them as core inverts ownership: the domain would mirror framework
  state instead of the framework serving domain state. As a thin adapter they add little once we
  own the loop.

### Option B: LangGraph as the agent core

- **Description.** Graph-based agent runtime with checkpointing (Postgres checkpointer),
  interrupts, human-in-the-loop, and a JS/TS port. The strongest candidate: its state-machine
  model and checkpointing are genuinely closer to our needs than any crew framework.
- **Pros.** Explicit graph/state model; resumable via checkpoints; interrupts map loosely to our
  approval waits; large ecosystem.
- **Cons / disqualifiers.** Checkpointing is **snapshot-based resumption, not durable execution**:
  no deterministic replay, no activity-level retry semantics, no heartbeats, no signal delivery
  guarantees comparable to Temporal — the crash matrix in _BRIEF §2.9 is exactly what Temporal is
  built for and LangGraph is not. The TS port trails the Python library in features and stability
  (TS support is secondary for the vendor). Its checkpoint store would become a second copy of
  agent progress alongside our `agent_steps` — again split ownership. And once Temporal is in the
  stack for consolidation/intake/pipelines anyway (ADR-005), LangGraph would be a second, weaker
  orchestrator to operate.
- **Rejected because** durability guarantees are materially weaker than Temporal's, TS is not its
  first-class target, and it would still hold agent-loop state outside the domain.

### Option C: OpenHands (formerly OpenDevin) as the agent execution core

- **Description.** Agent platform focused on autonomous software development: sandboxed runtime,
  browsing, code execution, strong SWE-bench results.
- **Pros.** Best-in-class coding-agent harness; real sandbox integration; could plausibly power
  our developer agents' inner loop.
- **Cons / disqualifiers.** Scope is coding agents, not a company OS: no org hierarchy, no
  delegation engine, no memory scopes, no approval/authority model — 80% of our domain is out of
  its scope. Python service with its own runtime assumptions; embedding it wholesale would create
  a second execution plane competing with our sandbox-manager and Tool Gateway (violating S1/S3
  invariants).
- **Rejected because** coding-only scope; at most an inspiration for workspace tooling, never the
  orchestrator.

### Option D: Own agent loop as a Temporal workflow (chosen)

- **Description.** `agentTaskWorkflow(agentId, taskId)` — one workflow per active task assignment;
  the loop (Working Set → LLM call → parse `AgentAction` → execute → guards) written by us as
  workflow code with activities; all state in Postgres.
- **Pros.** Total ownership of state and policy; Temporal-grade durability (replay, retries,
  signals, `continueAsNew`); TypeScript SDK is first-class; frameworks remain optional adapters.
- **Cons.** We build and maintain prompt patterns, action parsing, and delegation logic that
  frameworks give for free; Temporal's determinism constraints impose discipline (all IO in
  activities).

## Decision

**No third-party agent framework in the core.** The agent runtime is our own loop implemented as
the Temporal workflow `agentTaskWorkflow(agentId, taskId)` per _DECISIONS §8:

- One workflow per **active task assignment**; idle agents have no running workflow — the employee
  exists in Postgres, workflows are their working hours.
- Per step: build Working Set (activity) → LLM call via ModelRouter (activity) → parse the strict
  Zod `AgentAction` union → execute the action (activity, tools via Tool Gateway only) → append to
  `agent_steps` → run guards (budget, deadline, step cap, loop detector, ping-pong detector,
  delegation depth) → continue/wait/finish.
- External stimuli arrive only as Temporal signals: `messageReceived`, `dependencyResolved`,
  `reviewVerdict`, `approvalVerdict`, `managerDirective`, `cancel`.
- If an agent framework is ever used (e.g. a specialized coding harness), it runs **inside an
  activity as a replaceable adapter**, receives context from and returns results to our domain,
  and holds no persistent state of its own.

## Consequences

**Positive.**
- The spec's ownership rule is structurally guaranteed: there is no framework state to drift from
  Postgres. Swapping models or adapters never changes who "Alex" is.
- Durability, retries, and signal semantics are inherited from Temporal rather than reimplemented.
- The Zod `AgentAction` union makes every possible agent behavior enumerable, testable, and
  auditable — the Tool Gateway and office digital twin both key off it.

**Negative / accepted tradeoffs.**
- We forgo framework-provided conveniences (ready-made ReAct prompts, tool-calling glue); this is
  deliberate, ongoing engineering cost.
- Temporal determinism rules constrain workflow code style; developer onboarding cost accepted.
- Innovation in agent frameworks must be tracked and selectively ported rather than inherited.

**Revisit triggers.**
- A framework emerges offering Temporal-grade durability, first-class TS, and externalized state
  (bring-your-own store) — re-evaluate as an adapter for the inner step loop only.
- Our loop's quality measurably lags framework baselines on the MVP proof scenario (e.g. task
  completion rate on the reference project) — port specific techniques, not the framework.
- Maintaining prompt/loop code exceeds ~30% of ongoing engineering effort.

## References

- _BRIEF.md §2.4, §2.6, §2.9 (ownership, durability), §11 (MVP proof)
- _DECISIONS.md §6 (agent model), §8 (agent runtime), §12 (Tool Gateway), §22 row 004
- ADR-005 (Temporal), ADR-014 (authorization), ADR-015 (ModelRouter)
