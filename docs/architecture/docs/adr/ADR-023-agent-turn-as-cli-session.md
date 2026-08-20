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

## INV-3 for CLI agents: an explicit amendment, not an exception

**INV-3 (S3) as written:** "All tool executions pass the Tool Gateway. No bypass path exists in
code; every invocation has a `tool_invocations` audit row."

**Settled position (god, 2026-08-20, Founder informed):** the **sandbox is the security boundary**.
A CLI agent's built-in `Read`/`Write`/`Bash` run inside its own workspace container and do **not**
pass the Tool Gateway — by design. Organisational decisions (`create_task`, `delegate_task`,
`agent.hire`, `complete_task`, …) continue to go through ACOS over MCP and stay fully
gateway-audited. Audit and cost visibility for the rest **move to the session level**: broker
per-session metering → session-scoped `llm_calls`, plus the company session cap.

**State it plainly, because it is a real change:** for CLI-run agents the sandbox boundary and
session-level metering **replace** the per-tool ledger as the audit control. This is a deliberate
narrowing of INV-3's guarantee for one class of agent, decided by the Founder's authority — not a
discovery that INV-3 was never meant literally. Recorded this way so a future reviewer sees a
decision, not a drift.

Consequences that must be tracked rather than assumed away:

- **INV-3's own enforcement text needs scoping.** `18 §13` lists S3 enforcement as "eslint boundary
  rule + sandbox-manager rejects exec without valid dispatch token — CI lint + negative integration
  test". That mechanism and its test remain correct for the worker-driven path; they simply do not
  cover a CLI's in-container child processes. Unless the S3 row is scoped to say so, the invariant
  list and the shipped system will contradict each other, and the next reviewer will read the
  contradiction as a bug.
- **INV-7 (S7) coverage narrows.** S7 requires a full audit log for "R2+ tool invocations". A CLI
  agent performing R2-class work through its built-ins produces no `tool_invocations` row, so for
  that class the S7 record becomes session-scoped rather than per-operation.
- **INV-5 (S5) loses a checkpoint.** Risky tool calls triggered by untrusted external content are
  today detectable at the Gateway per invocation. For CLI agents that per-call checkpoint is gone;
  what remains is the sandbox boundary and whatever the session-level signals can show.

**Net effect on implementation:** Kevin's fail-closed per-operation `PreToolUse` audit hook is
**not required** and is dropped. That is a simplification of the runtime, and the argument for it is
sound — the container still bounds everything the CLI can reach, and org actions remain audited.
What is genuinely lost is per-operation forensics inside the sandbox; the ADR records that as the
price rather than pretending it is free.

**Prior record.** `PROGRESS.md` L158 records that the Munder raw-CLI-with-builtin-tools path was
rejected under INV-3. This ADR supersedes that rejection with the boundary argument above, and
cites it so the earlier decision reads as deliberately revisited rather than overlooked.

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
- **Let the CLI use its built-in tools freely, with no boundary argument.** That was the shape
  rejected under INV-3 in PROGRESS.md L158. What makes the current design acceptable is not that
  the concern went away but that the sandbox boundary + session-level metering are named as the
  replacement audit control — see the INV-3 amendment above.
