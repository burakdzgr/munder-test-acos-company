# ADR-022: Manager self-assignment — a manager may keep a slice of its own decomposition

Status: Accepted · Date: 2026-08-20 · Deciders: Founder + implementation agent

## Context

The Founder watched a real hive session and named the gap precisely:

> "sana görev verdim, sen Dwight ve Oscar'a iş böldün ama burayı ben halledeceğim dedin. Aynısı
> ACOS'ta da olmalı."

In ACOS a lead or CEO decomposes a task and delegates **every** child downward. It never keeps one
for itself, so the small/critical/context-heavy slice — the one a human manager would obviously
just do — either travels down to someone with less context or bounces back as a help request.

The mechanism was **half built**, which is why the gap survived months of runs:

- `packages/db/src/delegation.ts` — `mayDelegate()` opens with
  `if (managerAgentId === toAgentId) return { ok: true }; // self-assignment of own subtask`.
  The permission layer has always allowed it.
- But `scoreDelegateCandidates()` scored **only the manager's active direct reports**, so the
  manager was never in the candidate set and `resolveDelegateTarget()` could never return it.
- And the action prompt (`workers/agent-worker/src/activities/agent-task.ts`) told the model to use
  `CONTEXT_SENTINEL_UUID` for `toAgentId` and to *not* impose a concrete agent — so a live model had
  no way to express the intent either.

Permission without a path is not a capability. Nothing in the golden path asserted "a manager took
and closed a subtask itself", so nothing failed.

The binding constraint is **INV-10**: assignment has one deterministic owner, the Scheduler. Any fix
that lets an LLM hand work to whomever it likes would trade a missing feature for a broken
invariant — and would also reopen the bypass that TASK 12 closed (a CEO forcing an unrelated agent
onto a task to dodge capability matching).

## Decision

**A manager may take on a subtask of its own decomposition. The Scheduler remains the deterministic
owner of assignment; the manager is added to the candidate pool it was missing from, and an explicit
self-choice is expressed with a dedicated sentinel that still passes every existing gate.**

Four parts:

1. **Candidate pool.** `scoreDelegateCandidates()` now returns the manager's active direct reports
   **plus the manager itself**, scored by the identical formula (skill match, capability hits,
   project familiarity, success rate, memory affinity, −1.0 × workload) and filtered by the same
   `requiredCapabilities` rule. No special weight, no bonus, no penalty: self wins only when it
   genuinely ranks first.

2. **Explicit intent.** `SELF_SENTINEL_UUID = 00000000-0000-4000-8000-00000000005e` (in
   `packages/llm`, next to `CONTEXT_SENTINEL_UUID`) may be used as `delegate_task.toAgentId` and
   means "I take this subtask myself". The prompt names it as a legitimate option, so the choice is
   reachable by a live model rather than only by the scorer.

3. **Capacity.** Self-taken work goes through the unchanged `capacityCheck()`, so it counts against
   the manager's **own** WIP cap (`WIP_LIMIT_BY_ROLE` — executive 8, manager 5, lead 3). A full
   manager gets `{ok:false, reason:"WIP_LIMIT", candidates:[…]}` and is pushed back to delegating.

4. **Empty pool still means "staff the team".** A manager with **zero** active direct reports is not
   its own candidate. The empty pool keeps producing `NO_ELIGIBLE_DELEGATE` with the "hire the team
   first" hint that drives `agent.hire` — otherwise an unstaffed CEO would quietly absorb every
   subtask and the company would never be built.

## Consequences

1. **INV-10 holds.** The Scheduler still decides every assignment it is asked to decide; the change
   is to the *membership* of the set it ranks, not to who ranks it. The explicit sentinel is the
   same class of input as the already-supported `@Name` mention — a stated preference that is then
   validated by the reporting-line rule and the capacity model, both untouched.

2. **The TASK 12 capability override does not apply to self.** An explicitly named *other* agent
   who fails the `requiredCapabilities` filter is still replaced by the Scheduler's pick — that rule
   exists so a CEO cannot force work onto an unrelated agent. Taking responsibility for a subtask
   you authored is not that bypass, and a manager's own unit/position rarely spells a capability
   ("Ürün Yöneticisi" never ILIKEs "frontend"), so applying the filter to self would silently defeat
   the decision. The guard against hoarding is the WIP cap, not the capability filter.

3. **Hoarding is bounded by three independent things**, in order of how often each will bite: the
   manager's currently running parent task already counts as load (−1.0) in its own score, so it
   starts every ranking one full point behind an idle report; the WIP cap refuses the assignment
   outright once the manager is full; and with no reports at all the manager is not a candidate.

4. **Timing in a live run.** The self-assigned child does **not** start immediately: the
   one-live-session-per-agent gate sees the manager already running its parent turn, so the child
   stays `ASSIGNED` and is started by the `agent.session.ended` drain when that turn closes (the
   30-minute stuck sweep is the backstop). This is the correct order — the manager finishes
   decomposing before it starts building — but any assertion about self-taken work must be made
   after the manager's session ends, not right after the delegate step.

5. **`resolveDelegateTarget` became capacity-aware.** It now skips candidates that fail the capacity
   check and falls through to the next one, returning the top permitted candidate only when
   *everyone* is full (so the caller still gets the informative `WIP_LIMIT` result with
   alternatives). Without this, adding a frequently-busy candidate to the pool would have turned
   routine "this one is busy" cases into failed delegations.

## Alternatives considered

- **Let the model name any agent id directly.** Rejected: it hands assignment to the LLM and breaks
  INV-10, and it reopens the TASK 12 bypass.
- **Self-assignment as a separate action type** (`take_task`). Rejected: it would duplicate the
  grooming → permission → capacity → assign chain that `delegateTask` already owns, and give a
  second writer for the same transition. The sentinel reuses the one path.
- **A dedicated "manager reserve" WIP budget** so self-taken work does not consume the delegation
  cap. Rejected as unneeded policy invention: the role cap already expresses "how much this person
  can hold", and a separate budget would be exactly the hoarding lever the Founder warned about.
- **Always include self, even with no reports.** Rejected: it silently replaces the staffing path
  (`agent.hire`) that the E2 wizard depends on.

## Proof

- `packages/db/test/integration/manager-self-assignment.int.test.ts` — the manager is in its own
  pool; a WIP-full top candidate no longer drops the delegation; explicit self-assignment really
  writes the task onto the manager; a full manager is refused with `WIP_LIMIT` + alternatives; a
  manager with no reports is not its own candidate.
- `workers/agent-worker/test/integration/manager-self-assignment.int.test.ts` — the sentinel
  resolves to the acting agent; the capability override does not rewrite an explicit self-choice;
  the `CONTEXT_SENTINEL_UUID` path still resolves to a report.
- Golden path (Jim, T29 companion assert): "a manager self-took **and closed** at least one
  subtask" — a task whose `owner_agent_id` equals its parent's `owner_agent_id`, reaching `DONE`.
