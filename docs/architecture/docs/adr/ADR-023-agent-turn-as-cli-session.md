# ADR-023: The Agent Turn Is a Live Claude Code CLI Session, With the Tool Gateway Exposed as MCP

Status: Accepted · Date: 2026-08-20 · Deciders: Founder (authorizing), god (dispatch), Jim (author),
Oscar (control-plane), CLI-runtime engineer (runtime/PTY)

> **This ADR amends ADR-004.** ADR-004 rejected third-party agent frameworks in the agent path and
> INV-20 forbids them "ever — without revising ADR-004/006/018 first". This is that revision. Read
> both together: ADR-004's *reasoning* still holds and is what constrains the design below.

## Context

The Founder watched a live run of the Terminal tab and said, in substance: *this is not a live
session*. The observation was correct and the cause is architectural, not a defect.

Today an agent turn is: `callModelActivity` → OpenAI-compatible HTTP call (today via the
claude-cli bridge on the host) → the model returns a **structured JSON action** (`create_task`,
`delegate_task`, `use_tool`, `complete_task`, …) → the worker executes it → observation → repeat.
The PTY the UI shows is a shell into the workspace container — the machine the agent's commands run
on, not the agent's own session. So the "session" a human sees is a rendered step feed, never a
terminal.

The Founder's decision: **every agent turn — CEO, lead, engineer alike — must BE a Claude Code CLI
session**, the same thing a human sees when driving Claude Code directly, permission banner
included. The model must stop being called "like an API".

## Decision

1. **An agent turn runs as a real `claude` CLI process** inside the agent's workspace container.
   No new channel: `claude` replaces `/bin/sh` as the `Cmd` of the existing docker-exec TTY seam
   (`services/sandbox-manager/src/docker.ts` `openShell`), so the same `terminal_sessions` frame log,
   ring buffer, `term.<id>` NATS subject and WS topic carry it (22 §5.2). The human watches the real
   session, banner included; **CLI exit = session end**.
2. **Planning agents get a session workspace too.** CEO and leads have no worktree today, which is
   precisely why they have no PTY. They receive a lightweight workspace with the project repo
   mounted read-only.
3. **The Tool Gateway is exposed to the CLI as an MCP server.** Every ACOS action —
   `create_task`, `delegate_task`, `agent.hire`, `complete_task`, `request_help`,
   `request_review`, `update_task_status` — becomes an MCP tool. The control plane (approvals,
   staffing, roll-up, reviewer independence) therefore sits **on top of** the CLI session, not
   beside it.
4. **Identity is brokered, never mounted.** The container credential is a **revocable per-session
   capability token minted by ACOS**; the subscription credential is held only by the broker process
   and **never enters a workspace container**. Concretely (proven on the host by Kevin, T31): `claude`
   honours `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`; the broker swaps the per-session capability
   token for the host credential (plus the `oauth-2025-04-20` beta) and upstream answers 200; usage is
   metered from the SSE stream, which is what makes session-level `llm_calls` possible. The container
   receives ONLY `{ANTHROPIC_BASE_URL=http://host.docker.internal:<broker-port>,
   ANTHROPIC_AUTH_TOKEN=<opaque revocable session token>}`.
5. **Concurrency is capped per company.** One CLI process per active agent turn; the Scheduler
   enforces a company-scoped ceiling on simultaneous live sessions.

## Why the identity decision is not a detail

The design note originally proposed mounting the host credential read-only into the container. That
would have **violated INV-2 (S2): "Agents never receive raw secrets — tools inject credentials
server-side; no secret material ever appears in an assembled prompt."** A container the agent can
run arbitrary code in is not a place a subscription credential can live. The broker/proxy model was
chosen instead and is the only option compatible with S2. Recorded here because the rejected option
looked convenient and will look convenient again.

## INV-3 holds as written — the PreToolUse hook is the mechanism

**INV-3 (S3):** "All tool executions pass the Tool Gateway. No bypass path exists in code; every
invocation has a `tool_invocations` audit row."

A stock Claude Code CLI carries its own `Bash`/`Read`/`Edit`/`Write`/`Glob`/`Grep` tools, and left
alone they would execute inside the container with no audit row — that is the concern this ADR had
to answer before anything shipped.

**Answered, and built (Kevin, T31):** a **`PreToolUse` hook**, baked read-only into the
`acos/workspace-node` image, routes every builtin call to the Tool Gateway **audit + policy**
endpoint *before* execution and **fails closed**. Every operation therefore still yields a
`tool_invocations` row, and the Gateway can **deny** it — proven in practice by blocking a
`Read /etc/passwd`. `WebFetch`/`WebSearch`/`Agent` and friends are disabled outright via
`--disallowedTools`; ACOS organisational actions arrive only through the MCP gateway.

So INV-3 is **preserved per-operation**, not narrowed: the CLI's in-container children are covered
by the same gateway that covers the worker-driven path. `18 §13`'s S3 mechanism list should name the
hook alongside the eslint boundary rule and the sandbox-manager dispatch-token check.

**Trust assumption, stated plainly:** the hook runs at the same uid as the CLI inside the sandbox.
It is an *enforcement and audit* seam within a boundary that is still the container (INV-8/S8) —
the hook is not itself the containment.

**Prior record.** `PROGRESS.md` L158 records that the Munder raw-CLI-with-builtin-tools path was
rejected under INV-3. That rejection was correct on its own terms — raw builtins with no seam do
violate INV-3. This ADR supersedes it because the seam now exists, and cites it so the earlier
decision reads as deliberately revisited rather than overlooked.

**Consequently INV-5 (S5) and INV-7 (S7) are unaffected.** The per-call checkpoint for risky calls
triggered by untrusted content is the hook; the R2+ audit record is the `tool_invocations` rows.
Session-level metering (broker → session-scoped `llm_calls`) is *added* for cost visibility, not a
replacement for the per-operation ledger.

## Why MCP-on-top does not weaken the skeleton (control-plane argument, Oscar, T30)

Implemented on `t30-mcp-tool-gateway`; each point below is asserted by a test, not aspirational
(`apps/server/test/integration/mcp-gateway.int.test.ts`, `packages/db/test/integration/session-gate.int.test.ts`).

1. **INV-10 — the Scheduler still owns assignment.** The only delegation surface exposed to a CLI
   accepts `"scheduler"` or `"self"`, never a concrete agent id. A session has no path to name a
   target.
2. **INV-14 — reviewer ≠ author.** `request_review` runs the same reviewer election; the CLI cannot
   nominate its own reviewer.
3. **INV-13 — one status writer.** This is why the organisational verbs are *not* yet served over
   MCP: serving them means **moving** the worker's action dispatch to a shared home, not
   re-implementing it in `apps/server`, which would create a second writer for task state.
   Extract, don't duplicate.
4. **Approvals.** `require_approval` is a first-class outcome, not an error: the tool does not
   execute until a verdict lands, and R3/founder-category tools behave exactly as before.
5. **Identity.** Derived from a per-session token bound to (company, agent, task, session) — never
   from tool arguments. No tool takes an `agentId`/`companyId`/`taskId` parameter; a call whose
   arguments carry another agent's id still audits as the token's agent.
6. **S2 — secrets.** Credentials resolve server-side at dispatch and never cross into the
   container; `INTERNAL_API_TOKEN` never enters a container at all, and a session token cannot mint
   another token.
7. **S5 — taint.** `outputFlagged` rides the result envelope, so a CLI session's derived calls carry
   the taint bit exactly as the worker loop's fence does.
8. **INV-3 / S3 — preserved in both directions.** MCP tool calls go through `ToolGateway.invoke` as
   usual. The CLI's built-in tools are decided and audited through a new **audit-only mode**: the
   gateway writes the decision and the `tool_invocations` row but does **not** execute — execution
   stays in the sandbox, since executing again would double the side effect. Fail-closed on
   unmapped built-ins.

## Concurrency and cost, concretely

**Concurrency.** N agents means N live CLI processes, so the bridge's de-facto 3-parallel ceiling
disappears. It is replaced by an explicit company-scoped cap
(`MAX_LIVE_SESSIONS_PER_COMPANY`, default **3** — today's effective parallelism, so enabling the CLI
path cannot make the host worse than it already is). **One** gate serves every start path, rework
re-entry included; a start path outside the cap would make the cap meaningless. Over the cap nothing
fails: the task stays ASSIGNED and the session-ended drain releases company-wide capacity by
priority/age.

**Cost.** Session-level metering still matters even with the per-operation ledger intact, because
`llm_calls` is empty for planning/intake-path calls today (only `callModelActivity` writes rows).
That gap is **pre-existing, not caused by this decision** — but this decision makes it load-bearing,
so closing it belongs to this work.

## Other invariants touched

- **INV-9 (agent identity ⊥ model).** A CLI session is a model runtime. `agent_model_bindings`
  stays the authority for which runtime an agent uses; nothing about identity, memory, skills or
  history may move into the CLI.
- **INV-17 (execution plane holds zero domain state).** The MCP server is the Tool Gateway HTTP
  API, never a direct database path from the container.
- **INV-19 (runaway guards always on) — OPEN RISK, not yet solved.** Nothing bounds a looping CLI
  session today; the guards listed below must be built as part of this work. Recorded as an open
  risk deliberately: this host was taken down once already (2026-08-20) by unbounded growth, and
  "we will add limits later" is how that happens again. This is the second real cost. Today the worker sees every
  step and can apply step-cap, loop detector, ping-pong detector and budget guards *between* steps.
  A CLI session runs its own loop, so those guards no longer observe each step. The guards must be
  re-established at the session boundary (wall-clock and token ceiling per session, plus MCP-call
  rate/pattern checks); otherwise a looping session is invisible until it is expensive.
- **INV-16 (a single agent failure is never a company failure).** A crashed CLI process must fail
  the turn, not the company; existing crash-handler and drain paths apply.
- **INV-10 / ADR-004 (domain core owns all state).** Unchanged and non-negotiable: Postgres remains
  the single source of truth. The CLI holds nothing. This is the reason the MCP seam matters — it
  is what keeps ADR-004's core claim true while the agent loop itself moves.

## Consequences

**Gained.** The human sees the real session — the original request. Coding agents get genuine file
editing and command execution from a runtime built for it. The permission banner and interaction
model humans already understand carry over.

**Paid.**
- Per-step guards become per-session guards (INV-19 above).
- Cost/observability shifts: `llm_calls` accounting moves to session level. Note this table is
  *already* incomplete — planning/intake-path calls log but do not persist rows (only
  `callModelActivity` writes them), so this work must close that gap rather than inherit it.
- Load profile changes: a five-agent company means five live CLI processes, not three queued HTTP
  calls. The host has already been taken down once by unbounded stack growth (2026-08-20: Docker
  engine death at 20 GB free / 149 GB vhdx). The company-scoped cap is not optional.
- ADR-004's blanket "no agent framework in the agent path" no longer holds literally; its
  *substance* is preserved by the constraints above.

## Rejected alternatives

- **Keep API-style calls, restyle the step feed to look like a terminal.** Cosmetic; the Founder
  asked for the session, not a skin of one.
- **Run the CLI on the host with the worktree mounted.** Credential handling gets easier, sandbox
  isolation (INV-1/S1, INV-8/S8) gets worse. Rejected: isolation is the harder guarantee to regain.
- **Mount the subscription credential into the container.** Violates INV-2. See above.
- **Let the CLI use its built-in tools freely, unaudited.** That is the shape rejected under INV-3
  in PROGRESS.md L158, and it stays rejected. What makes the current design acceptable is the
  PreToolUse hook: the ops are audited and deniable, so the invariant holds rather than bends.
