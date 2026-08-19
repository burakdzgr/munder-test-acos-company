// T35 acceptance (server side): structured-brief validation at the engine
// boundary, Founder-only session verdicts with row-locked concurrency,
// endorsement chain verification (forged endorsements impossible), expiry
// sweep emitting approval.expired with rejected semantics, and the
// approval_engine actor settling a task parked in APPROVAL.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import {
  ApprovalError,
  ApprovalsService,
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  sweepApprovals,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agents,
  approvals,
  auditLog,
  events,
  orgUnits,
  positions,
  tasks,
  users,
} from "@acos/db/schema";
import { buildApp, type App } from "../../src/app.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const ok = async () => {};

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let app: App;
let service: ApprovalsService;
let ctx: CompanyContext;
let sessionCookie = "";
let csrfToken = "";
let companyId = "";
let founderUserId = "";
let DEV = ""; // requester
let LEAD = ""; // on the requester's reports_to chain
let OUTSIDER = ""; // not on the chain
const signalled: unknown[] = [];

const authHeaders = () => ({
  cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
  "x-csrf-token": csrfToken,
});

function validBrief(overrides: Record<string, unknown> = {}) {
  return {
    title: "Approve staging database upgrade",
    request: "Authorize upgrading the staging Postgres instance to 16.4.",
    reason: "Current minor version has a known CVE affecting logical replication.",
    attempted: ["Mitigated via network policy — insufficient for compliance"],
    options: [
      { option: "Upgrade now (recommended)", pros: "closes the CVE", cons: "15m downtime", cost_cents: 0 },
      { option: "Defer to next quarter", pros: "no downtime now", cons: "CVE stays open", cost_cents: 0 },
    ],
    recommendation: "Upgrade now during the low-traffic window.",
    risk: "medium — staging only, rollback snapshot taken first.",
    cost: { amount_cents: 0, currency: "USD" },
    impact: "Approved: CVE closed this week. Rejected: audit finding stays open.",
    urgency: "high — audit review is scheduled next Monday.",
    deadline: null,
    ...overrides,
  };
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  service = new ApprovalsService(guardedDb);
  app = await buildApp({
    healthCheckers: { postgres: ok, nats: ok, temporal: ok },
    logger: false,
    db,
    guardedDb,
    masterKey: MASTER_KEY,
  });
  app.approvalSignalPort = async (input) => {
    signalled.push(input);
    return true;
  };
  await app.ready();

  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { email: "founder@t35.local", password: "correct-horse-battery", displayName: "F" },
  });
  for (const c of setup.cookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }
  const [founder] = await db.select().from(users).where(eq(users.email, "founder@t35.local"));
  founderUserId = founder!.id;

  const created = await app.inject({
    method: "POST",
    url: "/api/v1/companies",
    headers: authHeaders(),
    payload: { name: "ApprovalCo", slug: "approvalco" },
  });
  companyId = created.json().id;
  ctx = companyContext(companyId);

  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  const hire = async (name: string, employeeNumber: number) =>
    (
      await db
        .insert(agents)
        .values({
          companyId,
          employeeNumber,
          name,
          status: "active",
          positionId: position!.id,
          orgUnitId: unit!.id,
          seniority: "mid",
          autonomyLevel: 2,
          persona: `${name}.`,
        })
        .returning()
    )[0]!.id;
  DEV = await hire("Dana Dev", 1);
  LEAD = await hire("Lena Lead", 2);
  OUTSIDER = await hire("Odin Outsider", 3);
  const { orgEdges } = await import("@acos/db/schema");
  await db
    .insert(orgEdges)
    .values({ companyId, fromAgentId: DEV, kind: "reports_to", toAgentId: LEAD });
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

async function eventRows(type: string) {
  return db
    .select()
    .from(events)
    .where(sql`${events.companyId} = ${companyId} AND ${events.type} = ${type}`)
    .orderBy(events.seq);
}

describe("approvals engine (T35)", () => {
  let approvalId = "";

  it("creates a pending approval from a valid brief — event + audit + inbox API shape", async () => {
    const { row, created } = await service.create(ctx, {
      kind: "other",
      brief: validBrief(),
      requestedByAgentId: DEV,
      risk: "medium",
      urgency: "high",
    });
    approvalId = row.id;
    expect(created).toBe(true);
    expect(row.status).toBe("pending");
    expect(row.number).toBe(1);

    const requested = await eventRows("approval.requested");
    expect(requested).toHaveLength(1);
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, companyId), eq(auditLog.action, "approval.requested")));
    expect(audit).toHaveLength(1);

    const list = await app.inject({
      method: "GET",
      url: `/api/v1/companies/${companyId}/approvals?status=pending`,
      headers: authHeaders(),
    });
    expect(list.statusCode).toBe(200);
    const items = list.json();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: approvalId,
      status: "pending",
      requesterName: "Dana Dev",
      urgency: "high",
    });
    // derived expiry: high urgency = created + 48h
    const expiresMs =
      new Date(items[0].expiresAt).getTime() - new Date(items[0].createdAt).getTime();
    expect(expiresMs).toBe(48 * 3_600_000);
  });

  it("bounces briefs that violate the 11-field contract or look like chat (19 §10)", async () => {
    await expect(
      service.create(ctx, {
        kind: "other",
        brief: validBrief({ reason: "Dev: please\nLead: ok\nCEO: fine\nDev: thanks" }),
        requestedByAgentId: DEV,
        risk: "low",
      }),
    ).rejects.toThrow(ApprovalError);
    const { options: _options, ...missing } = validBrief();
    await expect(
      service.create(ctx, { kind: "other", brief: missing, requestedByAgentId: DEV, risk: "low" }),
    ).rejects.toThrow(/11-field contract/);
    await expect(
      service.create(ctx, {
        kind: "spend", // doc-19 alias — not the canonical enum
        brief: validBrief(),
        requestedByAgentId: DEV,
        risk: "low",
      }),
    ).rejects.toThrow(/unknown approval kind/);
  });

  it("endorsement: chain executive may endorse; a forged endorsement is refused (34 T7)", async () => {
    const endorsed = await service.endorse(ctx, approvalId, {
      executiveAgentId: LEAD,
      note: "Verified the CVE report — recommend approve.",
    });
    const chain = endorsed.chain as Array<{ agentId: string; verdict: string }>;
    expect(chain.map((e) => e.verdict)).toEqual(["requested", "endorsed"]);
    expect((await eventRows("approval.endorsed")).length).toBe(1);

    await expect(
      service.endorse(ctx, approvalId, { executiveAgentId: OUTSIDER }),
    ).rejects.toThrow(/reports_to chain/);
  });

  it("PAT bearers cannot deliver verdicts — interactive session only (19 §12)", async () => {
    const pat = await app.inject({
      method: "POST",
      url: "/api/v1/auth/pats",
      headers: authHeaders(),
      payload: { name: "ci", scopes: ["read:events", "write:approvals"] },
    });
    const token = pat.json().token;
    const verdict = await app.inject({
      method: "POST",
      url: `/api/v1/companies/${companyId}/approvals/${approvalId}/verdict`,
      headers: { authorization: `Bearer ${token}` },
      payload: { verdict: "approved" },
    });
    expect(verdict.statusCode).toBe(403);
  });

  it("REJECT without a note fails validation (19 §11)", async () => {
    const rejected = await app.inject({
      method: "POST",
      url: `/api/v1/companies/${companyId}/approvals/${approvalId}/verdict`,
      headers: authHeaders(),
      payload: { verdict: "rejected" },
    });
    expect(rejected.statusCode).toBe(400);
  });

  it("Founder verdict approves once; the second verdict races into 409 (19 §12.1)", async () => {
    const approve = await app.inject({
      method: "POST",
      url: `/api/v1/companies/${companyId}/approvals/${approvalId}/verdict`,
      headers: authHeaders(),
      payload: { verdict: "approved", note: "Go ahead this week." },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json()).toMatchObject({
      status: "approved",
      decidedByUserId: founderUserId,
      decisionNote: "Go ahead this week.",
    });
    expect((await eventRows("approval.approved")).length).toBe(1);
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, companyId), eq(auditLog.action, "approval.approved")));
    expect(audit).toHaveLength(1);

    const again = await app.inject({
      method: "POST",
      url: `/api/v1/companies/${companyId}/approvals/${approvalId}/verdict`,
      headers: authHeaders(),
      payload: { verdict: "rejected", note: "changed my mind" },
    });
    expect(again.statusCode).toBe(409);
  });

  it("needs_review routes back and a revised brief returns to pending on the SAME id (19 §4)", async () => {
    const { row } = await service.create(ctx, {
      kind: "budget_increase",
      brief: validBrief({ title: "Raise infra budget by 200 USD/mo" }),
      requestedByAgentId: DEV,
      risk: "medium",
    });
    const review = await app.inject({
      method: "POST",
      url: `/api/v1/companies/${companyId}/approvals/${row.id}/verdict`,
      headers: authHeaders(),
      payload: { verdict: "needs_review", note: "Compare against reserved capacity first." },
    });
    expect(review.statusCode).toBe(200);
    expect(review.json().status).toBe("needs_review");
    expect((await eventRows("approval.needs_review")).length).toBe(1);

    const revised = await service.resubmit(ctx, row.id, {
      byAgentId: DEV,
      brief: validBrief({ title: "Raise infra budget by 150 USD/mo (revised)" }),
      note: "Reserved capacity covers 50 USD of the gap.",
    });
    expect(revised.status).toBe("pending");
    expect(revised.title).toContain("revised");
    const chain = revised.chain as Array<{ verdict: string }>;
    expect(chain.map((e) => e.verdict)).toEqual(["requested", "revised"]);
    // clean up: decide it so later sweeps see only intended rows
    await service.verdict(ctx, row.id, "rejected", { userId: founderUserId, note: "defer" });
  });

  it("verdicts settle a task parked in APPROVAL via the approval_engine actor (07 §5)", async () => {
    const mkTask = async (number: number) =>
      (
        await db
          .insert(tasks)
          .values({
            companyId,
            number,
            kind: "task",
            title: `Parked ${number}`,
            objective: "x",
            status: "APPROVAL",
            ownerAgentId: DEV,
            successCriteria: [],
          })
          .returning()
      )[0]!;
    const taskA = await mkTask(101);
    const taskB = await mkTask(102);

    const a = await service.create(ctx, {
      kind: "deployment",
      brief: validBrief({ title: "Deploy to production" }),
      requestedByAgentId: DEV,
      risk: "high",
      taskId: taskA.id,
      workflowId: "wf-parked-a",
    });
    const b = await service.create(ctx, {
      kind: "deployment",
      brief: validBrief({ title: "Deploy risky migration" }),
      requestedByAgentId: DEV,
      risk: "high",
      taskId: taskB.id,
    });

    const approved = await service.verdict(ctx, a.row.id, "approved", { userId: founderUserId });
    expect(approved.signal).toMatchObject({ workflowId: "wf-parked-a", verdict: "approved" });
    const rejected = await service.verdict(ctx, b.row.id, "rejected", {
      userId: founderUserId,
      note: "not during the launch freeze",
    });
    expect(rejected.signal).toBeNull();

    const [rowA] = await db.select().from(tasks).where(eq(tasks.id, taskA.id));
    const [rowB] = await db.select().from(tasks).where(eq(tasks.id, taskB.id));
    expect(rowA!.status).toBe("DONE");
    expect(rowB!.status).toBe("REJECTED");
  });

  it("sweep: reminders fire once per threshold; past-expiry rows expire with rejected semantics", async () => {
    const { row } = await service.create(ctx, {
      kind: "vendor",
      brief: validBrief({ title: "New monitoring vendor" }),
      requestedByAgentId: DEV,
      risk: "medium",
      urgency: "critical", // 24h window
      workflowId: "wf-sweep-target",
    });
    const createdAt = row.createdAt.getTime();

    // 60% into the window: the 50% reminder fires exactly once
    const midway = new Date(createdAt + 0.6 * 24 * 3_600_000);
    const first = await sweepApprovals(db, guardedDb, { now: midway });
    expect(first.reminded).toBe(1);
    expect(first.expired).toHaveLength(0);
    const second = await sweepApprovals(db, guardedDb, { now: midway });
    expect(second.reminded).toBe(0);
    expect((await eventRows("approval.reminder.sent")).length).toBe(1);

    // past the window: expired + event + the workflow to signal `expired`
    const after = new Date(createdAt + 25 * 3_600_000);
    const sweep = await sweepApprovals(db, guardedDb, { now: after });
    expect(sweep.expired).toEqual([
      { companyId, approvalId: row.id, workflowId: "wf-sweep-target" },
    ]);
    const [expiredRow] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(expiredRow!.status).toBe("expired");
    expect((await eventRows("approval.expired")).length).toBe(1);

    // idempotent: a re-sweep finds nothing open
    const again = await sweepApprovals(db, guardedDb, { now: after });
    expect(again.expired).toHaveLength(0);
  });

  it("the detail endpoint renders the typed brief + chain + task ref (no raw passthrough)", async () => {
    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/companies/${companyId}/approvals/${approvalId}`,
      headers: authHeaders(),
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.brief).toMatchObject({ title: "Approve staging database upgrade" });
    expect(Object.keys(body.brief)).toHaveLength(11);
    expect(body.chain.map((e: { verdict: string }) => e.verdict)).toEqual([
      "requested",
      "endorsed",
    ]);
  });
});
