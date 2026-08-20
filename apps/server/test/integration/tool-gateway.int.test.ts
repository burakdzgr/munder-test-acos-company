// T39 acceptance: the authorize suite (allow / deny×2 / require_approval +
// constraints) against the real chain — identity → registry/schema →
// tool_permissions grants → constraints → policy bands → budget → the ONE
// domain authorize() — with the invariant that EVERY decision leaves an
// audit row (tool_invocations; identity failures land in audit_log), S2
// scrubbing + server-side credential injection, taint elevation (S5), rate
// limiting and idempotent replay.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agents,
  auditLog,
  costEntries,
  events,
  orgEdges,
  orgUnits,
  policies,
  positions,
  secrets,
  tasks,
  toolInvocations,
  toolPermissions,
  users,
} from "@acos/db/schema";
import { buildApp, type App } from "../../src/app.js";
import {
  ToolGateway,
  type ToolDispatchPort,
  type ToolInvokeResponse,
} from "../../src/modules/tools/gateway.js";
import { sealSecret, unsealSecret } from "../../src/modules/auth/crypto.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
const INTERNAL_TOKEN = "internal-test-token-0123456789";
const ok = async () => {};
const SHA = (c: string) => c.repeat(40);

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let app: App;
let gateway: ToolGateway;
let ctx: CompanyContext;
let companyId = "";
let sessionCookie = "";
let csrfToken = "";
let DEV = "";
let LEAD = "";
let CEO = "";
let PAUSED = "";
let RACER = "";
let SETTLER = "";
let CONSTRAINED = "";
let positionId = "";
let unitId = "";
let taskTightBudget = "";
let taskFree = "";
let taskRace = "";
let taskLedger = "";

interface DispatchCall {
  tool: string;
  input: Record<string, unknown>;
  credentials: Record<string, string>;
}
const dispatched: DispatchCall[] = [];

const fakePort: ToolDispatchPort = {
  dispatch: async ({ tool, input, credentials }) => {
    dispatched.push({ tool: tool.name, input: input as Record<string, unknown>, credentials });
    switch (tool.name) {
      case "fs.read":
        return {
          output: { kind: "file", content: "hello", truncated: false, byteSize: 5, provenance: "workspace" },
          resultSummary: "read 5 bytes",
        };
      case "fs.write":
        return {
          output: { byteSize: 1, created: true, lockConflicts: [], provenance: "workspace" },
        };
      case "git.branch":
        return { output: { pushed: true, remoteHead: SHA("a"), provenance: "workspace" } };
      case "git.merge":
        return {
          output: { merged: true, mergeCommitSha: SHA("b"), conflict: null, provenance: "workspace" },
          costCents: 2,
        };
      case "terminal.run":
        // A3: the race fixture needs the first call to still be IN FLIGHT when
        // the second one asks for budget — otherwise the two run back to back
        // and there is no race to observe.
        if ((input as { command?: string }).command === "race") {
          await new Promise((r) => setTimeout(r, 250));
        }
        return {
          output: {
            exitCode: 0,
            // T22: terminal.run çıktısına `timedOut` SONRADAN eklendi (ajan
            // "öldürüldü" ile "test kırıldı"yı ayırabilsin diye). Sahte port
            // alanı üretmediği için çıktı şema doğrulaması düşüyor ve A2/A3
            // ölçmek istedikleri şeye (defter/bütçe) hiç varamıyordu.
            timedOut: false,
            stdoutTail: "ok",
            stderrTail: "",
            durationMs: 10,
            terminalSessionId: randomUUID(),
            provenance: "workspace",
          },
          costCents: 5,
        };
      case "web.search":
        return { output: { results: [], provenance: "web" } };
      default:
        throw new Error(`fake port has no handler for ${tool.name}`);
    }
  },
};

async function invocationRow(id: string) {
  const [row] = await db
    .select()
    .from(toolInvocations)
    .where(eq(toolInvocations.id, id));
  return row!;
}

async function eventsOfType(type: string) {
  return db
    .select()
    .from(events)
    .where(and(eq(events.companyId, companyId), eq(events.type, type)))
    .orderBy(events.seq);
}

async function grant(
  toolName: string,
  subjectKind: "agent" | "position" | "org_unit",
  subjectId: string,
  constraints: Record<string, unknown> = {},
) {
  await db.insert(toolPermissions).values({
    companyId,
    toolName,
    subjectKind,
    subjectId,
    constraints,
  });
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  app = await buildApp({
    healthCheckers: { postgres: ok, nats: ok, temporal: ok },
    logger: false,
    db,
    guardedDb,
    masterKey: MASTER_KEY,
    internalApiToken: INTERNAL_TOKEN,
  });
  app.toolDispatchPort = fakePort;
  await app.ready();

  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { email: "founder@t39.local", password: "correct-horse-battery", displayName: "F" },
  });
  for (const c of setup.cookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/companies",
    headers: {
      cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
      "x-csrf-token": csrfToken,
    },
    payload: { name: "GatewayCo", slug: "gatewayco" },
  });
  companyId = created.json().id;
  ctx = companyContext(companyId);

  gateway = new ToolGateway({
    db: guardedDb,
    dispatch: fakePort,
    resolveCredential: async (c, name) => {
      const [row] = await guardedDb
        .select()
        .from(secrets)
        .where(and(eq(secrets.companyId, c.companyId), eq(secrets.name, name)))
        .limit(1);
      if (!row) return null;
      return unsealSecret(MASTER_KEY, Buffer.from(row.ciphertext as Uint8Array));
    },
  });

  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  unitId = unit!.id;
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  positionId = position!.id;
  const hire = async (name: string, employeeNumber: number, autonomyLevel: number, status = "active") =>
    (
      await db
        .insert(agents)
        .values({
          companyId,
          employeeNumber,
          name,
          status,
          positionId,
          orgUnitId: unitId,
          seniority: "mid",
          autonomyLevel,
          persona: `${name}.`,
        })
        .returning()
    )[0]!.id;
  DEV = await hire("Dana Dev", 1, 2);
  LEAD = await hire("Lena Lead", 2, 3);
  CEO = await hire("Cem CEO", 3, 5);
  PAUSED = await hire("Paula Paused", 4, 2, "paused");
  // A2/A3 fixtures get their own agents so the shared rate-limit buckets and
  // grant constraints of the suite above cannot perturb them.
  RACER = await hire("Rana Racer", 5, 3);
  SETTLER = await hire("Suat Settler", 6, 3);
  // C1 fixtures likewise: constraint bypasses must be measured against a
  // clean grant set, not against whatever the suite above already granted.
  CONSTRAINED = await hire("Kaan Constrained", 7, 3);
  for (const agentId of [DEV, LEAD, CEO]) {
    await db.insert(orgEdges).values({ companyId, fromAgentId: agentId, kind: "member_of", toUnitId: unitId });
  }

  const [tight] = await db
    .insert(tasks)
    .values({
      companyId,
      number: 1,
      kind: "task",
      title: "Tight budget task",
      objective: "x",
      status: "IN_PROGRESS",
      ownerAgentId: DEV,
      budgetCents: 100,
      spentCents: 90,
    })
    .returning();
  taskTightBudget = tight!.id;
  const [free] = await db
    .insert(tasks)
    .values({
      companyId,
      number: 2,
      kind: "task",
      title: "Free task",
      objective: "x",
      status: "IN_PROGRESS",
      ownerAgentId: DEV,
    })
    .returning();
  taskFree = free!.id;
  // A3: 40¢ hard budget — one terminal.run at 1800s estimates 30¢, so exactly
  // one of two concurrent calls can be authorised.
  const [race] = await db
    .insert(tasks)
    .values({
      companyId,
      number: 3,
      kind: "task",
      title: "Budget race task",
      objective: "x",
      status: "IN_PROGRESS",
      ownerAgentId: RACER,
      budgetCents: 40,
      spentCents: 0,
    })
    .returning();
  taskRace = race!.id;
  const [ledger] = await db
    .insert(tasks)
    .values({
      companyId,
      number: 4,
      kind: "task",
      title: "Ledger atomicity task",
      objective: "x",
      status: "IN_PROGRESS",
      ownerAgentId: SETTLER,
    })
    .returning();
  taskLedger = ledger!.id;
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("authorize suite (17 §4; accept: allow / deny×2 / require_approval)", () => {
  it("ALLOW: granted R0 within autonomy → dispatched, output validated, audited, cost-free", async () => {
    await grant("fs.read", "agent", DEV);
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "fs.read",
      input: { path: "src/index.ts" },
      taskId: taskFree,
    });
    expect(res.decision).toBe("allow");
    expect(res.status).toBe("succeeded");
    expect((res.output as { content: string }).content).toBe("hello");
    expect(dispatched.at(-1)).toMatchObject({ tool: "fs.read" });

    const row = await invocationRow(res.invocationId!);
    expect(row).toMatchObject({
      toolName: "fs.read",
      decision: "allow",
      status: "succeeded",
      riskClass: "R0",
      agentId: DEV,
    });
    expect(row.finishedAt).not.toBeNull();
    expect((await eventsOfType("tool.invocation.requested")).length).toBeGreaterThan(0);
    expect((await eventsOfType("tool.invocation.completed")).length).toBe(1);
  });

  it("DENY 1 — no grant: fail-closed with an audit row + denied event", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "fs.write",
      input: { path: "apps/web/x.ts", content: "x" },
    });
    expect(res.decision).toBe("deny");
    expect(res.reason).toBe("NO_PERMISSION_GRANT");
    const row = await invocationRow(res.invocationId!);
    expect(row.status).toBe("denied");
    expect((await eventsOfType("tool.invocation.denied")).length).toBe(1);
  });

  it("DENY 2 — grant constraint violated: pathPrefixes reject a foreign path (position-level grant)", async () => {
    await grant("fs.write", "position", positionId, { pathPrefixes: ["apps/web/", "packages/ui/"] });
    const denied = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "fs.write",
      input: { path: "packages/db/schema.ts", content: "nope" },
    });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("GRANT_CONSTRAINT_VIOLATED");
    expect(denied.reason).toContain("path_not_in_prefixes:packages/db/schema.ts");
    expect((await invocationRow(denied.invocationId!)).status).toBe("denied");

    // the same grant allows the owned subtree — structured denial ≠ blanket deny
    const allowed = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "fs.write",
      input: { path: "apps/web/pages/login.tsx", content: "ok" },
    });
    expect(allowed.decision).toBe("allow");
    expect(allowed.status).toBe("succeeded");
  });

  it("REQUIRE_APPROVAL: R2 above an L2 agent's cap escalates to the manager; L5 executes", async () => {
    await grant("git.merge", "agent", DEV);
    await grant("git.merge", "agent", CEO);
    const dev = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "git.merge",
      input: { taskId: taskFree, branch: "task/1-x", expectedHeadSha: SHA("c") },
    });
    expect(dev.decision).toBe("require_approval");
    expect(dev.approver).toBe("manager");
    expect((await invocationRow(dev.invocationId!)).status).toBe("awaiting_approval");

    const ceo = await gateway.invoke(ctx, {
      agentId: CEO,
      toolName: "git.merge",
      input: { taskId: taskFree, branch: "task/1-x", expectedHeadSha: SHA("c") },
    });
    expect(ceo.decision).toBe("allow");
    expect(ceo.status).toBe("succeeded");
    expect(ceo.costCents).toBe(2);
  });

  it("branchPattern constraint: pushing main is denied, task/* passes (17 §4.2 ex. 3)", async () => {
    await grant("git.branch", "agent", DEV, { branchPattern: "^task/" });
    const main = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "git.branch",
      input: { branch: "main" },
    });
    expect(main.decision).toBe("deny");
    expect(main.reason).toContain("branch_not_allowed:main");

    const task = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "git.branch",
      input: { branch: "task/81-fix-login" },
    });
    expect(task.decision).toBe("allow");
  });

  // C1 (Y4) — the three ways a grant constraint could be walked around. Each
  // is a fail-OPEN bug: the gateway believed it had constrained the agent, so
  // nothing downstream looked twice.
  it("C1: grant constraints cannot be walked around (prefix boundary, anchoring, malformed URL)", async () => {
    // (a) `src` must not authorise `srcret/` — a prefix is a PATH boundary,
    // not a string prefix. The old check was a bare startsWith.
    await grant("fs.write", "agent", CONSTRAINED, { pathPrefixes: ["src"] });
    const sibling = await gateway.invoke(ctx, {
      agentId: CONSTRAINED,
      toolName: "fs.write",
      input: { path: "srcret/keys.txt", content: "x" },
    });
    expect(sibling.decision).toBe("deny");
    expect(sibling.reason).toContain("path_not_in_prefixes");

    // …and the same grant still allows the directory it names
    const inside = await gateway.invoke(ctx, {
      agentId: CONSTRAINED,
      toolName: "fs.write",
      input: { path: "src/app.ts", content: "x" },
    });
    expect(inside.decision).toBe("allow");

    // traversal that normalises back out of the prefix is denied too
    const traversal = await gateway.invoke(ctx, {
      agentId: CONSTRAINED,
      toolName: "fs.write",
      input: { path: "src/../etc/passwd", content: "x" },
    });
    expect(traversal.decision).toBe("deny");

    // (b) an unanchored pattern is a FULL match: `main` must not also
    // authorise `not-main-really`
    await grant("git.branch", "agent", CONSTRAINED, { branchPattern: "main" });
    const lookalike = await gateway.invoke(ctx, {
      agentId: CONSTRAINED,
      toolName: "git.branch",
      input: { branch: "not-main-really" },
    });
    expect(lookalike.decision).toBe("deny");
    expect(lookalike.reason).toContain("branch_not_allowed:not-main-really");

    // (c) a malformed URL is a fail-CLOSED deny, not an unhandled 500.
    // In practice the input schema rejects it first (INVALID_INPUT) and the
    // constraint layer's own try/catch is the belt to that braces — what
    // matters is that neither layer lets it through or throws.
    await grant("web.fetch", "agent", CONSTRAINED, { domainAllowlist: ["registry.npmjs.org"] });
    const broken = await gateway.invoke(ctx, {
      agentId: CONSTRAINED,
      toolName: "web.fetch",
      input: { url: "http://[::bad::url]/x" },
    });
    expect(broken.decision).toBe("deny");
    expect(broken.reason).toMatch(/invalid_url|INVALID_INPUT/);

    // and a host outside the allowlist is denied by host, not by substring
    const foreign = await gateway.invoke(ctx, {
      agentId: CONSTRAINED,
      toolName: "web.fetch",
      input: { url: "https://registry.npmjs.org.evil.example/x" },
    });
    expect(foreign.decision).toBe("deny");
    expect(foreign.reason).toContain("domain_not_allowed");
  });

  it("spend caps: default deny; onCapExceeded=escalate degrades into approval (17 §4.2 ex. 2)", async () => {
    await grant("terminal.run", "agent", DEV, { spendCapCents: 5 });
    await grant("terminal.run", "agent", LEAD, { spendCapCents: 5, onCapExceeded: "escalate" });
    // estimate = ceil(1800/60) = 30¢ > 5¢ cap
    const denied = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "terminal.run",
      input: { command: "npm run build", timeoutSec: 1800 },
    });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("spend_cap_exceeded");

    const escalated = await gateway.invoke(ctx, {
      agentId: LEAD,
      toolName: "terminal.run",
      input: { command: "npm run build", timeoutSec: 1800 },
    });
    expect(escalated.decision).toBe("require_approval");
    expect(escalated.approver).toBe("manager");
    expect((await invocationRow(escalated.invocationId!)).status).toBe("awaiting_approval");
  });

  it("budget layer: a hard task budget denies when the estimate exceeds the remainder", async () => {
    // DEV's terminal.run grant caps spend at 5¢ — use a small timeout so the
    // constraint passes (1¢) and add a task with only 10¢ headroom but an
    // estimate above it via a longer window on LEAD's escalating grant?
    // Simpler: LEAD has no cap violation at 60s (1¢ ≤ 5¢) and the tight task
    // has 10¢ left — push the estimate over with 1800s via a fresh grant.
    await grant("terminal.run", "agent", CEO);
    const res = await gateway.invoke(ctx, {
      agentId: CEO,
      toolName: "terminal.run",
      input: { command: "npm test", timeoutSec: 1800 }, // 30¢ > 10¢ remaining
      taskId: taskTightBudget,
    });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("BUDGET_EXCEEDED");
    expect((await invocationRow(res.invocationId!)).status).toBe("denied");
  });

  it("policy deny short-circuits an existing grant (18 §4.2 band order)", async () => {
    await grant("web.fetch", "agent", DEV);
    await db.insert(policies).values({
      companyId,
      name: "no-web-fetch",
      kind: "tool",
      effect: "deny",
      rule: { actionPattern: "web.fetch" },
    });
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "web.fetch",
      input: { url: "https://registry.npmjs.org/react" },
    });
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("POLICY_DENY:no-web-fetch");
  });

  it("taint elevation (S5/17 §7.4): tainted R2 becomes R3 — Founder unless a standing allow policy covers it", async () => {
    const withoutPolicy = await gateway.invoke(ctx, {
      agentId: CEO,
      toolName: "git.merge",
      input: { taskId: taskFree, branch: "task/1-x", expectedHeadSha: SHA("d") },
      tainted: true,
    });
    expect(withoutPolicy.riskClass).toBe("R3");
    expect(withoutPolicy.elevatedFrom).toBe("R2");
    expect(withoutPolicy.decision).toBe("require_approval");
    expect(withoutPolicy.approver).toBe("founder");
    const audited = await invocationRow(withoutPolicy.invocationId!);
    expect(audited.riskClass).toBe("R3");
    expect((audited.input as { __elevatedFrom?: string }).__elevatedFrom).toBe("R2");

    // a standing allow policy satisfies the R3 clause (steps 6–7) but the S5
    // external-influence review (06 §2 step 8) still holds: a tainted R2+
    // action can NEVER end at plain allow — injected instructions can at most
    // cause a MORE-reviewed action (17 §7.4). The approver drops from
    // founder to manager; the elevation stays on the audit row.
    await db.insert(policies).values({
      companyId,
      name: "standing-merge-line",
      kind: "standing_approval",
      effect: "allow",
      rule: { actionPattern: "git.merge", condition: { maxCostCents: 100 } },
    });
    const withPolicy = await gateway.invoke(ctx, {
      agentId: CEO,
      toolName: "git.merge",
      input: { taskId: taskFree, branch: "task/1-x", expectedHeadSha: SHA("d") },
      tainted: true,
    });
    expect(withPolicy.decision).toBe("require_approval");
    expect(withPolicy.approver).toBe("manager");
    expect((await invocationRow(withPolicy.invocationId!)).status).toBe("awaiting_approval");
  });
});

describe("audit is unconditional (accept: audit row always written)", () => {
  it("unknown tool, invalid input, unknown agent, paused agent — every path leaves a row", async () => {
    const before = (await db.select().from(toolInvocations)).length;

    const unknownTool = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "no.such.tool",
      input: {},
    });
    expect(unknownTool.reason).toBe("TOOL_NOT_REGISTERED");
    const badInput = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "fs.read",
      input: { path: "" },
    });
    expect(badInput.reason).toContain("INVALID_INPUT");
    expect((await db.select().from(toolInvocations)).length).toBe(before + 2);

    // identity failures cannot reference an agent FK — they land in audit_log
    const ghost = await gateway.invoke(ctx, {
      agentId: randomUUID(),
      toolName: "fs.read",
      input: { path: "x" },
    });
    expect(ghost.reason).toBe("IDENTITY_INVALID");
    expect(ghost.invocationId).toBeNull();
    const paused = await gateway.invoke(ctx, {
      agentId: PAUSED,
      toolName: "fs.read",
      input: { path: "x" },
    });
    expect(paused.reason).toBe("IDENTITY_INVALID");
    const identityRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, companyId), eq(auditLog.action, "tool.invoke.identity_denied")));
    expect(identityRows.length).toBe(2);
  });

  it("R2+ decisions mirror into audit_log (S7)", async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, companyId), eq(auditLog.action, "tool.invoke.allow")));
    expect(rows.length).toBeGreaterThan(0); // CEO's merges above
  });
});

describe("S2: scrubbing + server-side credential injection", () => {
  it("credential-looking env keys never reach the audit row or dispatch", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: LEAD,
      toolName: "terminal.run",
      input: {
        command: "npm test",
        timeoutSec: 60, // 1¢ ≤ LEAD's 5¢ cap
        env: { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_leak", DB_PASSWORD: "x" },
      },
    });
    expect(res.decision).toBe("allow");
    const row = await invocationRow(res.invocationId!);
    const env = (row.input as { env: Record<string, string> }).env;
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(JSON.stringify(row.input)).not.toContain("ghp_leak");
    expect(JSON.stringify(dispatched.at(-1)!.input)).not.toContain("ghp_leak");
  });

  it("credentialRefs resolve from sealed-box secrets at dispatch only — absent from audit", async () => {
    const [founder] = await db.select().from(users).where(eq(users.email, "founder@t39.local"));
    await db.insert(secrets).values({
      companyId,
      name: "search.api_key",
      scope: "integration",
      ciphertext: await sealSecret(MASTER_KEY, "s3cret-search-key"),
      createdByUserId: founder!.id,
    });
    await grant("web.search", "agent", DEV);
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "web.search",
      input: { query: "fastify zod" },
    });
    expect(res.decision).toBe("allow");
    expect(dispatched.at(-1)!.credentials).toEqual({ "search.api_key": "s3cret-search-key" });
    const row = await invocationRow(res.invocationId!);
    expect(JSON.stringify(row.input)).not.toContain("s3cret-search-key");
    expect(JSON.stringify(row.resultSummary ?? "")).not.toContain("s3cret-search-key");
  });
});

describe("rate limiting + idempotency", () => {
  it("the per-agent token bucket denies with retryAfterSec and audits the throttle", async () => {
    await grant("git.merge", "agent", LEAD);
    const results: ToolInvokeResponse[] = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(
        await gateway.invoke(ctx, {
          agentId: LEAD,
          toolName: "git.merge", // perAgentPerMin 3
          input: { taskId: taskFree, branch: "task/1-x", expectedHeadSha: SHA("e") },
        }),
      );
    }
    expect(results.slice(0, 3).every((r) => r.decision === "allow")).toBe(true);
    const throttled = results[3]!;
    expect(throttled.decision).toBe("deny");
    expect(throttled.reason).toContain("RATE_LIMITED");
    expect(throttled.retryAfterSec).toBeGreaterThan(0);
    expect((await invocationRow(throttled.invocationId!)).status).toBe("denied");
    expect((await eventsOfType("tool.rate.throttled")).length).toBe(1);
  });

  it("idempotencyKey replays the recorded result without a second invocation row", async () => {
    const key = `attempt-${randomUUID()}`;
    const first = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "fs.read",
      input: { path: "src/app.ts" },
      idempotencyKey: key,
    });
    expect(first.status).toBe("succeeded");
    const rowsBefore = (await db.select().from(toolInvocations)).length;
    const replay = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "fs.read",
      input: { path: "src/app.ts" },
      idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.invocationId).toBe(first.invocationId);
    expect((await db.select().from(toolInvocations)).length).toBe(rowsBefore);
  });
});

describe("A2 — the cost entry commits with the invocation it prices (26 §2)", () => {
  async function ledgerFor(taskId: string) {
    return db
      .select()
      .from(costEntries)
      .where(and(eq(costEntries.companyId, companyId), eq(costEntries.taskId, taskId)));
  }
  async function invocationsFor(taskId: string) {
    return db
      .select()
      .from(toolInvocations)
      .where(and(eq(toolInvocations.companyId, companyId), eq(toolInvocations.taskId, taskId)));
  }
  async function spentCentsOf(taskId: string) {
    const [row] = await db.select({ spent: tasks.spentCents }).from(tasks).where(eq(tasks.id, taskId));
    return row!.spent;
  }

  it("a ledger failure rolls the invocation back — never `succeeded` without its cost entry", async () => {
    await grant("terminal.run", "agent", SETTLER);
    // Fault injection at the ledger, scoped to this task only: before the fix
    // recordCost ran AFTER the invocation transaction had committed, so the
    // row was already `succeeded` when the ledger write blew up.
    await pool.query(`
      CREATE OR REPLACE FUNCTION acos_test_ledger_down() RETURNS trigger AS $fn$
      BEGIN RAISE EXCEPTION 'ledger down'; END $fn$ LANGUAGE plpgsql;
    `);
    await pool.query(`
      CREATE TRIGGER acos_test_ledger_down_trg BEFORE INSERT ON cost_entries
      FOR EACH ROW WHEN (NEW.task_id = '${taskLedger}') EXECUTE FUNCTION acos_test_ledger_down();
    `);

    await expect(
      gateway.invoke(ctx, {
        agentId: SETTLER,
        toolName: "terminal.run",
        input: { command: "npm test", timeoutSec: 60 },
        taskId: taskLedger,
      }),
    ).rejects.toThrow(); // drizzle wraps the trigger error; state assertions below carry the meaning

    // the whole settle transaction rolled back: no ledger row, no spend, and
    // the invocation is still in flight rather than reporting success
    expect(await ledgerFor(taskLedger)).toHaveLength(0);
    expect(await spentCentsOf(taskLedger)).toBe(0);
    const stuck = await invocationsFor(taskLedger);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.status).toBe("dispatched");
    expect(stuck[0]!.finishedAt).toBeNull();

    await pool.query(`DROP TRIGGER acos_test_ledger_down_trg ON cost_entries`);

    const ok2 = await gateway.invoke(ctx, {
      agentId: SETTLER,
      toolName: "terminal.run",
      input: { command: "npm test", timeoutSec: 120 },
      taskId: taskLedger,
    });
    expect(ok2.status).toBe("succeeded");
    expect(ok2.costCents).toBe(5);
    const ledger = await ledgerFor(taskLedger);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.amountCents).toBe(5);
    expect(ledger[0]!.id).toBe(ok2.invocationId);
    expect(await spentCentsOf(taskLedger)).toBe(5);
  });
});

describe("A3 — concurrent invocations cannot overspend a hard budget (26 §4/§5.2)", () => {
  it("two parallel calls that each fit alone: the second is denied BUDGET_EXCEEDED", async () => {
    await grant("terminal.run", "agent", RACER);
    // 40¢ hard task budget, two concurrent 30¢ estimates. Without the
    // check-and-reserve both read `remaining = 40`, both pass, and the task
    // ends up 20¢ over its hard limit.
    const call = () =>
      gateway.invoke(ctx, {
        agentId: RACER,
        toolName: "terminal.run",
        input: { command: "race", timeoutSec: 1800 }, // estimate 30¢
        taskId: taskRace,
      });
    const [a, b] = await Promise.all([call(), call()]);

    const allowed = [a, b].filter((r) => r.decision === "allow");
    const denied = [a, b].filter((r) => r.decision === "deny");
    expect(allowed).toHaveLength(1);
    expect(denied).toHaveLength(1);
    expect(denied[0]!.reason).toContain("BUDGET_EXCEEDED");
    expect(allowed[0]!.status).toBe("succeeded");
    expect((await invocationRow(denied[0]!.invocationId!)).status).toBe("denied");

    // only the winner is billed, and the reservation left no residue
    const entries = await db
      .select()
      .from(costEntries)
      .where(and(eq(costEntries.companyId, companyId), eq(costEntries.taskId, taskRace)));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.amountCents).toBe(5);
    const [task] = await db.select({ spent: tasks.spentCents }).from(tasks).where(eq(tasks.id, taskRace));
    expect(task!.spent).toBe(5);
    expect(task!.spent).toBeLessThanOrEqual(40);
  });
});

describe("internal HTTP surface (17 §1)", () => {
  it("rejects without the internal bearer (401) and never via session/PAT", async () => {
    const noAuth = await app.inject({
      method: "POST",
      url: "/internal/v1/tools/invoke",
      payload: { companyId, agentId: DEV, toolName: "fs.read", input: { path: "x" } },
    });
    expect(noAuth.statusCode).toBe(401);
    const sessionOnly = await app.inject({
      method: "POST",
      url: "/internal/v1/tools/invoke",
      headers: {
        cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
        "x-csrf-token": csrfToken,
      },
      payload: { companyId, agentId: DEV, toolName: "fs.read", input: { path: "x" } },
    });
    expect(sessionOnly.statusCode).toBe(401);
  });

  it("invokes end-to-end with the internal token (workers' path)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/v1/tools/invoke",
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {
        companyId,
        agentId: DEV,
        toolName: "fs.read",
        input: { path: "src/main.ts" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ToolInvokeResponse;
    expect(body.decision).toBe("allow");
    expect(body.status).toBe("succeeded");
  });
});
