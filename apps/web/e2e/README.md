# The MVP demo master suite (`mvp-demo`)

29-MVP-PLAN.md §3 numbers the `_BRIEF.md` §11 flow into 25 executable steps.
This directory IS `mvp-demo.spec.ts` — the 25 steps live as ordered scenario
files (recorded naming: scenario files instead of one monolith; the repo's
numbering starts at 02 because step 1 is the boot itself). The whole suite
runs against a clean `docker compose up` in CI (`e2e-smoke` per PR, `nightly`
on a clean boot + live-LLM lane).

| Demo step(s) | Proof |
|---|---|
| 1 — local start, wizard reachable | CI boots the stack `--wait` + health probes before any spec |
| 2–3 — create company, build org | `02-company-and-org.spec.ts` |
| 4–5 — hire agents, reporting lines | `03-hire-agents.spec.ts` (escalation chain via API) |
| 6–7 — import project, intake report | `10-projects.spec.ts` (greenfield); imported-repo path in `workers/agent-worker` intake integration suite (Docker-gated) |
| 8–12 — objective → CEO → CTO → EM → tasks | `08-objective-to-tasks.spec.ts` |
| 13 — isolated workspaces | `09-terminals.spec.ts` (provisioning path) + T38/T40 integration suites |
| 14 — inter-agent communication | `07-communication.spec.ts` + step-14 assertions in `08` |
| 15 — visible in office | `05-office-live.spec.ts` + step-15 assertion in `08` |
| 16 — real terminals | `09-terminals.spec.ts` (live xterm + ring replay) |
| 17–18 — code + tests in workspace | Tool-dispatch integration suite (real `npm test` in a hardened container, T40) |
| 19 — independent review | Review-flow integration suite (changes_requested → rework → QA → merge, T43) |
| 20–21 — failures → learning → Observatory | `11-learning-and-memory.spec.ts` (REAL chain: task.failed → NATS → consolidation) |
| 22 — skill evidence + recompute | Skills integration suite (T47) + SKILLS view |
| 23–24 — project completes, CEO report | `12-costs-reports.spec.ts` + executive-report integration suite (T49) |
| 25 — zero routine Founder questions | step-25 assertions in `08` and `14-r2-isolation.spec.ts` |
| **R1** — worker kill mid-run | `13-r1-worker-kill.spec.ts` (compose-level) + worker-kill-resume integration suite |
| **R2** — two-company isolation | `14-r2-isolation.spec.ts` (API + SQL probes) |

Also part of the T50 hardening gate: the 55-case injection corpus
(`packages/tools/src/taint.test.ts`) + gateway flagging integration tests, the
out-of-scope guards (`apps/server/test/scope.test.ts`, eslint bans,
`scripts/check-deps.ts`), and the perf budgets (`RUN_PERF=1` retrieval suite,
p95 < 250ms @ 100k memories — nightly lane).
