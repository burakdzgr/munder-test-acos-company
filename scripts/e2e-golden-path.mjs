// Golden-path E2E runner (T2, behavior-first).
//
// Drives the FULL company lifecycle through the public REST surface and maps
// where real behaviour diverges from the intended flow. Unlike the Playwright
// suite (UI assertions, `pnpm e2e`) this runner is a BEHAVIOUR PROBE: every
// stage has a goal, a bounded poll and a verdict — and a broken stage does NOT
// abort the run, it is recorded and the next stage is probed anyway, so one
// run yields an ordered break-point map instead of a single first failure.
//
//   node scripts/e2e-golden-path.mjs                     # ACOS_SERVER_URL
//   ACOS_SERVER_URL=http://localhost:13000 node scripts/e2e-golden-path.mjs
//   node scripts/e2e-golden-path.mjs --json out.json     # machine-readable map
//
// Stack: `node scripts/e2e-stack.mjs up` (ephemeral, LLM_MODE=scripted, server
// on :13000). NEVER point this at a live-LLM stack unless you mean to pay for
// it — the runner refuses the dev port unless `--allow-live` is passed.
import { writeFileSync } from "node:fs";

const BASE = process.env.ACOS_SERVER_URL ?? "http://localhost:13000";
const ALLOW_LIVE = process.argv.includes("--allow-live");
const JSON_OUT = (() => {
  const i = process.argv.indexOf("--json");
  return i >= 0 ? process.argv[i + 1] : null;
})();
// Poll budgets (ms). Generous: scripted mode is fast, Temporal workflow start
// and workspace container creation are not.
const T = {
  short: Number(process.env.ACOS_E2E_T_SHORT ?? 30_000),
  medium: Number(process.env.ACOS_E2E_T_MEDIUM ?? 90_000),
  long: Number(process.env.ACOS_E2E_T_LONG ?? 240_000),
};
const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
// LANE. `scripted` replays recorded fixtures — deterministic and free, but it
// can only prove the CONTROL PLANE: the recorded dev script is toolless by
// design (32 §6), so no commit/merge/memory can appear. `live` is the only
// lane that proves artifact production and costs real money.
const LANE = process.env.ACOS_E2E_LANE ?? "scripted";
// Fixture identity coupling — see bootstrapCeo().
const CEO_NAME = process.env.ACOS_E2E_CEO_NAME ?? (LANE === "scripted" ? "Aylin Vural" : "Golden Path CEO");

// ---------------------------------------------------------------- http ----
const cookies = {};
const cookieHeader = () =>
  Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

function absorb(response) {
  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0] ?? "";
    const idx = pair.indexOf("=");
    if (idx > 0) cookies[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
}

async function api(method, path, body) {
  const headers = { accept: "application/json" };
  if (Object.keys(cookies).length > 0) headers.cookie = cookieHeader();
  // CSRF double-submit (18 §2): the autologin cookie pair carries the token.
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && cookies.acos_csrf) {
    headers["x-csrf-token"] = cookies.acos_csrf;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  absorb(response);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, ok: response.ok, body: parsed };
}
const get = (path) => api("GET", path);
const post = (path, body) => api("POST", path, body);
const brief = (value) => JSON.stringify(value).slice(0, 200);
/**
 * The v1 list surface is NOT uniform: /tasks, /agents, /approvals and
 * /agent-sessions answer with a BARE ARRAY while /memories and /terminals
 * answer with `{items: [...]}`. Read both shapes rather than silently seeing
 * zero rows (that mis-read cost this runner a full pass).
 */
const list = (body) => (Array.isArray(body) ? body : (body?.items ?? []));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `probe` until it returns something truthy or the budget expires. */
async function until(probe, budgetMs, everyMs = 2000) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    let hit = null;
    try {
      hit = await probe();
    } catch {
      hit = null;
    }
    if (hit) return hit;
    if (Date.now() >= deadline) return null;
    await sleep(everyMs);
  }
}

// -------------------------------------------------------------- report ----
const stages = [];
const state = {};

async function stage(id, goal, fn) {
  const started = Date.now();
  process.stdout.write(`\n-- ${id} ... `);
  let outcome;
  try {
    outcome = await fn();
  } catch (error) {
    outcome = { verdict: "ERROR", observed: `runner threw: ${error?.message ?? error}`, where: "runner" };
  }
  const entry = {
    id,
    goal,
    verdict: outcome.verdict,
    observed: outcome.observed,
    where: outcome.where ?? null,
    ms: Date.now() - started,
  };
  stages.push(entry);
  console.log(`${entry.verdict} (${(entry.ms / 1000).toFixed(1)}s) - ${entry.observed}`);
  return entry;
}
const PASS = (observed) => ({ verdict: "PASS", observed });
const BREAK = (observed, where) => ({ verdict: "BREAK", observed, where });
const SKIP = (observed) => ({ verdict: "SKIP", observed });
/**
 * A stage the SCRIPTED lane structurally cannot satisfy (the recorded dev
 * script never touches a tool, so no artifact/commit/memory exists). Reported
 * as LANE, not BREAK: calling it a defect would be a false positive, and
 * calling it a pass would be the dishonesty AGENT-BRIEF §6 warns about.
 */
const LANE_LIMIT = (observed) => ({ verdict: "LANE", observed, where: "fixture:toolless (32 §6)" });

/**
 * The Founder's first hire: unit + position + agent, all through the public
 * API. A company is born without leadership ON PURPOSE (Founder decision,
 * 2026-08-19) — staffing the first executive is an explicit human act, so
 * this is the golden path's real step 02, not a workaround for a gap.
 */
async function bootstrapCeo() {
  const unit = await post(`/api/v1/companies/${state.companyId}/org/units`, {
    name: "Executive",
    slug: "executive",
    kind: "department",
  });
  if (!unit.ok) return { ok: false, detail: `org/units -> ${unit.status} ${brief(unit.body)}` };
  const position = await post(`/api/v1/companies/${state.companyId}/org/positions`, {
    title: "CEO",
    seniorityTrack: ["expert"],
    defaultRole: "executive",
  });
  if (!position.ok) return { ok: false, detail: `org/positions -> ${position.status} ${brief(position.body)}` };
  const agent = await post(`/api/v1/companies/${state.companyId}/agents`, {
    // The name is NOT cosmetic in the scripted lane: fixtures are matched on
    // (role, taskFixture, agentName) and the executive script is keyed to the
    // demo CEO. Any other name => ScriptLoadError => the session dies before
    // its first step. See LANE note at the top of the map.
    name: CEO_NAME,
    positionId: position.body.id,
    orgUnitId: unit.body.id,
    seniority: "expert",
    autonomyLevel: 3,
    persona: "Decisive CEO agent; delegates to executives, never to individual contributors.",
    leadsUnit: true,
    activate: true,
  });
  if (!agent.ok) return { ok: false, detail: `agents -> ${agent.status} ${brief(agent.body)}` };
  state.ceoAgentId = agent.body.id;
  state.ceoWasManual = true;
  return { ok: true, detail: `agent ${agent.body.id}` };
}

// ---------------------------------------------------------------- flow ----
async function main() {
  console.log(`golden-path runner -> ${BASE}  [lane=${LANE}]`);

  const health = await get("/api/health");
  if (!health.ok) {
    console.error(`server unreachable at ${BASE} (${health.status}) - start one with: node scripts/e2e-stack.mjs up`);
    process.exit(2);
  }
  // Guard: never spend real LLM money by accident.
  if (BASE.includes(":3000") && !ALLOW_LIVE) {
    console.error("refusing to drive the :3000 dev stack (live LLM keys). Use the ephemeral e2e stack, or pass --allow-live.");
    process.exit(2);
  }

  // Single-user mode mints the Founder session on a cookie-less GET (A11).
  const me = await get("/api/v1/auth/me");
  if (!me.ok || !cookies.acos_session) {
    console.error(`autologin did not mint a session (${me.status}) - AUTH_AUTOLOGIN off?`);
    process.exit(2);
  }

  await stage("01-company-create", "Founder creates a company", async () => {
    const slug = `gp-${STAMP}`;
    const created = await post("/api/v1/companies", { name: `Golden Path ${STAMP}`, slug, currency: "USD" });
    if (!created.ok) return BREAK(`POST /companies -> ${created.status} ${brief(created.body)}`, "server:companies");
    state.companyId = created.body.id;
    return PASS(`company ${slug} (${state.companyId})`);
  });

  // A company is born WITHOUT a CEO by design (Founder decision, 2026-08-19):
  // hiring the first executive is an explicit Founder action, not an automatic
  // bootstrap — an org the Founder never staffed should not invent its own
  // leadership. So this stage probes the Founder ACTION path, not an absence:
  // it passes when a CEO can actually be created through the public API and
  // the staffing engine then recognises it as the top executive.
  await stage("02-ceo-create", "Founder creates the CEO (explicit action, not auto-bootstrap)", async () => {
    if (!state.companyId) return SKIP("no company");
    const existing = await get(`/api/v1/companies/${state.companyId}/agents`);
    const already = list(existing.body).find((a) =>
      /ceo|chief executive/i.test(`${a.name} ${a.title ?? ""} ${a.positionTitle ?? ""}`),
    );
    if (already) {
      state.ceoAgentId = already.id;
      return PASS(`CEO ${already.name} already present`);
    }
    const hired = await bootstrapCeo();
    if (!hired.ok) return BREAK(`Founder could not create a CEO: ${hired.detail}`, "server:org/agents");
    // The point of the CEO is that planning can now find a top executive;
    // a hire the staffing engine cannot see would be a false pass.
    const visible = await until(async () => {
      const agents = await get(`/api/v1/companies/${state.companyId}/agents`);
      return list(agents.body).find((a) => a.id === state.ceoAgentId && a.status === "active") ?? null;
    }, T.short);
    if (!visible) return BREAK(`CEO created (${hired.detail}) but not active/visible on the roster`, "server:agents");
    return PASS(`Founder hired CEO ${visible.name} (unit+position+agent via API)`);
  });

  await stage("03-project-create-index", "greenfield project reaches READY with a SHA-bound CodeIndex", async () => {
    if (!state.companyId) return SKIP("no company");
    const created = await post(`/api/v1/companies/${state.companyId}/projects`, {
      name: "Golden Path App",
      objective: "Bir HTTP saglik ucu ve birim testi olan kucuk bir Node servisi kur.",
    });
    if (!created.ok) return BREAK(`POST /projects -> ${created.status} ${brief(created.body)}`, "server:projects");
    state.projectId = created.body.id;
    // READY is a WAYPOINT, not a resting state: creation carries the
    // objective, so the project can race straight through ready into
    // planning/executing. Accept "index built" and record what it settled on.
    const INDEXED = ["ready", "planning", "staffing_review", "waiting_for_founder", "executing"];
    const ready = await until(async () => {
      const project = await get(`/api/v1/companies/${state.companyId}/projects/${state.projectId}`);
      state.projectStatus = project.body?.status;
      state.indexState = project.body?.indexState;
      state.indexSha = project.body?.indexCommitSha;
      return INDEXED.includes(state.projectStatus) && state.indexState === "ready" ? project.body : null;
    }, T.long, 3000);
    if (!ready) {
      return BREAK(`stuck at status=${state.projectStatus} indexState=${state.indexState} after ${T.long / 1000}s`, "worker:projectIntakeWorkflow");
    }
    if (!ready.indexCommitSha) {
      return BREAK("READY reached but indexCommitSha is null - READY must be SHA-bound", "worker:codeIndex");
    }
    return PASS(`status=${ready.status}, index=${ready.indexState}@${String(ready.indexCommitSha).slice(0, 8)}`);
  });

  await stage("04-founder-goal", "Founder gives the goal -> project enters PLANNING", async () => {
    if (!state.projectId) return SKIP("no project");
    const goal = await post(`/api/v1/companies/${state.companyId}/projects/${state.projectId}/goal`, {
      objective: "Saglik ucunu /health olarak ekle, 200 ve status ok dondur, birim testini yaz.",
    });
    if (goal.status === 409) {
      // The create-time objective already started the cascade, so the
      // dedicated Founder-goal step is unreachable: the documented
      // "READY -> Founder gives the goal -> PLANNING" step cannot happen on a
      // project that self-advanced past READY.
      state.goalRejected = true;
      return BREAK(`POST /goal -> 409 (project already ${state.projectStatus}); the Founder-goal step is unreachable because creation auto-started planning`, "server:projects lifecycle");
    }
    if (!goal.ok) return BREAK(`POST /goal -> ${goal.status} ${brief(goal.body)}`, "server:projects/goal");
    if (goal.body?.started !== true) {
      return BREAK(`goal stored but started=false (state=${goal.body?.state}) - goalStarter not wired`, "server:main.ts goalStarter");
    }
    return PASS("planning started");
  });

  await stage("05-ceo-analyze-requirements", "CEO turns the goal into requirements + a task tree", async () => {
    if (!state.projectId) return SKIP("no project");
    const seen = await until(async () => {
      const tasks = await get(`/api/v1/companies/${state.companyId}/tasks?projectId=${state.projectId}`);
      const items = list(tasks.body);
      return items.length > 0 ? items : null;
    }, T.long, 3000);
    if (!seen) {
      const overview = await get(`/api/v1/companies/${state.companyId}/projects/${state.projectId}/overview`);
      return BREAK(`no tasks after ${T.long / 1000}s (project=${overview.body?.status ?? "?"}) - CEO decomposition never landed`, "worker:ceo planning");
    }
    state.taskCount1 = seen.length;
    return PASS(`${seen.length} task(s), kinds=${[...new Set(seen.map((t) => t.kind))].join(",")}`);
  });

  await stage("06-staffing-approval-requested", "missing staff becomes ONE batched Founder approval", async () => {
    if (!state.companyId) return SKIP("no company");
    const approval = await until(async () => {
      const pending = await get(`/api/v1/companies/${state.companyId}/approvals?status=pending`);
      const items = list(pending.body);
      return items.find((a) => /staff|hire|team|kadro|ekip|org/i.test(`${a.kind} ${a.title}`)) ?? null;
    }, T.medium, 3000);
    if (!approval) {
      const project = await get(`/api/v1/companies/${state.companyId}/projects/${state.projectId}`);
      const pending = await get(`/api/v1/companies/${state.companyId}/approvals?status=pending`);
      return BREAK(`no staffing approval after ${T.medium / 1000}s (project=${project.body?.status}, pending=${(list(pending.body)).length}) - gap analysis raised none`, "worker:staffing gap analysis");
    }
    state.approvalId = approval.id;
    return PASS(`approval ${approval.kind} "${approval.title}"`);
  });

  await stage("07-agent-factory-staffing", "approval -> Agent Factory wires team+position+agent+bindings", async () => {
    if (!state.approvalId) return SKIP("no staffing approval to approve");
    const before = await get(`/api/v1/companies/${state.companyId}/agents`);
    const beforeCount = (list(before.body)).length;
    const verdict = await post(`/api/v1/companies/${state.companyId}/approvals/${state.approvalId}/verdict`, { verdict: "approved" });
    if (!verdict.ok) return BREAK(`POST /verdict -> ${verdict.status} ${brief(verdict.body)}`, "server:approvals");
    const grown = await until(async () => {
      const after = await get(`/api/v1/companies/${state.companyId}/agents`);
      const items = list(after.body);
      return items.length > beforeCount ? items : null;
    }, T.medium, 3000);
    if (!grown) return BREAK(`approved but headcount stayed ${beforeCount} after ${T.medium / 1000}s - Agent Factory not triggered by the verdict`, "worker:agent factory");
    return PASS(`headcount ${beforeCount} -> ${grown.length}`);
  });

  await stage("08-scheduler-dispatch", "Scheduler assigns a task to a capable agent", async () => {
    if (!state.companyId) return SKIP("no company");
    const dispatched = await until(async () => {
      const tasks = await get(`/api/v1/companies/${state.companyId}/tasks?projectId=${state.projectId}`);
      const items = list(tasks.body);
      return items.find((t) => t.ownerAgentId && ["ASSIGNED", "IN_PROGRESS", "REVIEW", "QA", "DONE"].includes(t.status)) ?? null;
    }, T.long, 3000);
    if (!dispatched) {
      const tasks = await get(`/api/v1/companies/${state.companyId}/tasks?projectId=${state.projectId}`);
      const summary = (list(tasks.body)).map((t) => `${t.displayNumber}:${t.status}${t.ownerAgentId ? "" : "/unowned"}`).join(" ");
      return BREAK(`nothing dispatched after ${T.long / 1000}s - [${summary}]`, "server:scheduler");
    }
    state.workTaskId = dispatched.id;
    state.workTaskNumber = dispatched.displayNumber;
    return PASS(`${dispatched.displayNumber} -> agent ${dispatched.ownerAgentId} (${dispatched.status})`);
  });

  await stage("09-live-agent-session", "developer agent runs live on an isolated worktree", async () => {
    if (!state.workTaskId) return SKIP("nothing dispatched");
    const session = await until(async () => {
      const sessions = await get(`/api/v1/companies/${state.companyId}/agent-sessions`);
      const items = list(sessions.body);
      return (
        items.find((s) => s.taskId === state.workTaskId && ["starting", "running", "waiting"].includes(s.status)) ??
        items.find((s) => s.taskId === state.workTaskId) ??
        null
      );
    }, T.long, 3000);
    if (!session) return BREAK(`no agent session row for ${state.workTaskNumber} after ${T.long / 1000}s`, "worker:agentTaskWorkflow");
    state.sessionId = session.id;
    // POLL for the PTY, do not spot-check it: the session row appears the
    // moment the workflow starts, but the workspace and its terminal are only
    // created when the agent reaches its FIRST tool call — seconds in scripted
    // mode, minutes on a live provider. A single read here reported "no PTY"
    // while the live run demonstrably had one (A7, 2026-08-19).
    // The PTY is NOT bound to the dispatched task. `workTaskId` is what the
    // scheduler handed out (the goal); the worktree — and therefore the
    // terminal — is created for the LEAF delivery task the chain produces
    // several levels down (goal -> initiative -> epic -> task). Matching on
    // the dispatched id reported "NO PTY" on a run whose database held an
    // active terminal_sessions row on TASK-4 the whole time (2026-08-20).
    // The company is created by this run, so ANY terminal in it is ours;
    // prefer the exact task, accept any descendant.
    const pty = await until(async () => {
      const terminals = await get(`/api/v1/companies/${state.companyId}/terminals`);
      const items = list(terminals.body);
      return (
        items.find((t) => t.taskId === state.workTaskId) ??
        items.find((t) => t.taskId) ??
        null
      );
    }, LANE === "scripted" ? T.short : T.long, 5000);
    if (!pty) {
      const detail = `session ${session.status}/${session.currentActivity} but NO PTY terminal in the company - worktree work is not live/observable`;
      return LANE === "scripted" ? LANE_LIMIT(detail) : BREAK(detail, "sandbox-manager:terminal");
    }
    state.terminalId = pty.id;
    const on = pty.taskNumber ? `TASK-${pty.taskNumber}` : "task";
    return PASS(`session ${session.status} + PTY ${pty.id} on ${on} (${pty.branch ?? "no branch"})`);
  });

  // 07 §2: `goal` and `initiative` are CONTAINERS. They never carry review
  // rows — they close by ROLL-UP when their children finish. The gate used to
  // assert `reviews > 0` on the dispatched task, which is the goal, so it
  // could not pass even when the delivery chain worked end to end. Assert
  // against the reviewable descendant (epic/task/subtask) and check the goal
  // for the roll-up instead.
  await stage("10-review-and-close", "a reviewable descendant is reviewed + DONE, and the goal closes by roll-up", async () => {
    if (!state.projectId) return SKIP("no project");
    const REVIEWABLE = ["epic", "task", "subtask"];
    const reviewsOf = async (taskId) => {
      const response = await get(`/api/v1/companies/${state.companyId}/tasks/${taskId}/reviews`);
      return list(response.body);
    };
    const descendants = async () => {
      const tasks = await get(`/api/v1/companies/${state.companyId}/tasks?projectId=${state.projectId}`);
      return list(tasks.body).filter((task) => REVIEWABLE.includes(task.kind));
    };

    const delivered = await until(async () => {
      for (const task of await descendants()) {
        if (task.status !== "DONE") continue;
        const reviews = await reviewsOf(task.id);
        const approved = new Set(reviews.filter((r) => r.status === "approved").map((r) => r.kind));
        // 15 §2: code review AND QA both sign off before a leaf is done.
        if (approved.has("code") && approved.has("qa")) return { task, reviews };
      }
      return null;
    }, T.long, 3000);

    if (!delivered) {
      const seen = await descendants();
      const detail = await Promise.all(
        seen.map(async (task) => {
          const reviews = await reviewsOf(task.id);
          const kinds = reviews.map((r) => `${r.kind}:${r.status}`).join("/") || "no-reviews";
          return `${task.displayNumber}(${task.kind}) ${task.status} [${kinds}]`;
        }),
      );
      return BREAK(
        seen.length === 0
          ? `no reviewable descendant exists after ${T.long / 1000}s - the chain never reached a leaf`
          : `no descendant reached DONE with approved code+qa after ${T.long / 1000}s - ${detail.join(" · ")}`,
        "worker:review workflow",
      );
    }

    state.deliveredTaskNumber = delivered.task.displayNumber;
    state.reviewCount = delivered.reviews.length;

    // Roll-up: the container the Founder actually asked for must close itself.
    const goal = await until(async () => {
      const tasks = await get(`/api/v1/companies/${state.companyId}/tasks?projectId=${state.projectId}`);
      const container = list(tasks.body).find((task) => task.kind === "goal");
      state.goalStatus = container?.status;
      return container?.status === "DONE" ? container : null;
    }, T.medium, 3000);
    if (!goal) {
      return BREAK(
        `${state.deliveredTaskNumber} is DONE with approved code+qa, but the goal is still ${state.goalStatus} after ${T.medium / 1000}s - roll-up did not close the container`,
        "control-plane:container roll-up",
      );
    }
    return PASS(`${state.deliveredTaskNumber} DONE (${state.reviewCount} reviews, code+qa approved) -> goal DONE by roll-up`);
  });

  await stage("11-merge-and-codeindex", "merge moves HEAD and CodeIndex follows incrementally", async () => {
    if (!state.projectId) return SKIP("no project");
    const before = state.indexSha;
    const moved = await until(async () => {
      const project = await get(`/api/v1/companies/${state.companyId}/projects/${state.projectId}`);
      state.headSha = project.body?.headSha;
      state.indexSha2 = project.body?.indexCommitSha;
      return state.headSha && state.headSha !== before && state.indexSha2 === state.headSha ? project.body : null;
    }, T.medium, 3000);
    if (!moved) {
      const detail = `head=${String(state.headSha).slice(0, 8)} index=${String(state.indexSha2).slice(0, 8)} (was ${String(before).slice(0, 8)}) - merge/reindex did not converge`;
      return LANE === "scripted" ? LANE_LIMIT(detail) : BREAK(detail, "worker:merge+codeIndex");
    }
    return PASS(`head=index=${String(moved.headSha).slice(0, 8)}`);
  });

  await stage("12-memory-outcome", "task outcome consolidates into a memory row", async () => {
    if (!state.companyId) return SKIP("no company");
    const memories = await until(async () => {
      const page = await get(`/api/v1/companies/${state.companyId}/memories`);
      const items = list(page.body);
      return items.length > 0 ? items : null;
    }, T.medium, 3000);
    if (!memories) {
      const detail = "zero memories after task close - consolidation produced nothing";
      return LANE === "scripted" ? LANE_LIMIT(`${detail} (scripted consolidation writes none BY DESIGN)`) : BREAK(detail, "worker:memory consolidation");
    }
    state.memoryCount = memories.length;
    return PASS(`${memories.length} memory row(s)`);
  });

  await stage("13-worker-idle", "session settles instead of leaking a live runner", async () => {
    if (!state.sessionId) return SKIP("no session");
    const settled = await until(async () => {
      const sessions = await get(`/api/v1/companies/${state.companyId}/agent-sessions`);
      const session = (list(sessions.body)).find((s) => s.id === state.sessionId);
      return session && ["completed", "waiting", "failed", "cancelled"].includes(session.status) ? session : null;
    }, T.medium, 3000);
    if (!settled) return BREAK(`session ${state.sessionId} never settled - worker still running after close`, "worker:session lifecycle");
    if (settled.status === "failed") return BREAK("session settled as failed", "worker:agentTaskWorkflow");
    return PASS(`session ${settled.status}, steps=${settled.stepsCount}, cost=${settled.costCents}c`);
  });

  await stage("14-second-task-is-faster", "a 2nd goal reuses index+memory+session - no re-discovery", async () => {
    if (!state.projectId) return SKIP("no project");
    const firstDispatch = stages.find((s) => s.id === "08-scheduler-dispatch")?.ms ?? null;
    const startedAt = Date.now();
    const goal = await post(`/api/v1/companies/${state.companyId}/projects/${state.projectId}/goal`, {
      objective: "Saglik ucuna surum alani ekle ve testini guncelle.",
    });
    if (!goal.ok) return BREAK(`second goal -> ${goal.status} ${brief(goal.body)}`, "server:projects/goal");
    const before = state.taskCount1 ?? 0;
    const dispatched = await until(async () => {
      const tasks = await get(`/api/v1/companies/${state.companyId}/tasks?projectId=${state.projectId}`);
      const items = list(tasks.body);
      if (items.length <= before) return null;
      return items.find((t) => t.id !== state.workTaskId && t.ownerAgentId && t.status !== "BACKLOG") ?? null;
    }, T.long, 3000);
    const secondMs = Date.now() - startedAt;
    if (!dispatched) {
      return BREAK(`second goal produced no dispatched task in ${(secondMs / 1000).toFixed(0)}s - warm path reuses nothing`, "server:scheduler / worker:planning");
    }
    const reindexed = Boolean(state.indexSha2) && state.indexSha2 !== state.headSha;
    if (reindexed) return BREAK(`2nd dispatch in ${(secondMs / 1000).toFixed(1)}s but the index was rebuilt - cold start repeated`, "worker:codeIndex reuse");
    const firstLabel = firstDispatch === null ? "n/a" : `${(firstDispatch / 1000).toFixed(1)}s`;
    return PASS(`2nd dispatch ${(secondMs / 1000).toFixed(1)}s (1st ${firstLabel}), no re-index`);
  });

  // --------------------------------------------------------------- map ----
  const width = Math.max(...stages.map((s) => s.id.length));
  console.log("\n\n=== BREAK-POINT MAP ===");
  for (const s of stages) {
    console.log(`${s.verdict.padEnd(5)} ${s.id.padEnd(width)} ${(s.ms / 1000).toFixed(1).padStart(6)}s  ${s.goal}`);
    console.log(`        -> ${s.observed}${s.where ? `  [${s.where}]` : ""}`);
  }
  const laneLimited = stages.filter((s) => s.verdict === "LANE");
  const broken = stages.filter((s) => s.verdict === "BREAK" || s.verdict === "ERROR");
  if (laneLimited.length > 0) {
    console.log(`
${laneLimited.length} stage(s) unprovable in the ${LANE} lane: ${laneLimited.map((s) => s.id).join(", ")} - only ACOS_E2E_LANE=live proves these.`);
  }
  console.log(`\n${stages.length - broken.length}/${stages.length} stages green; first break: ${broken[0]?.id ?? "none"}`);
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, at: new Date().toISOString(), state, stages }, null, 2));
    console.log(`map -> ${JSON_OUT}`);
  }
  process.exit(broken.length === 0 ? 0 : 1);
}

await main();
