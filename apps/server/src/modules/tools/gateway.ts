// Tool Gateway (T39; 17 §4 normative path, _DECISIONS §12, 18 §4). The
// single choke point between agent intent and real-world effect (S3): every
// step is fail-closed, every decision leaves a `tool_invocations` audit row
// (identity failures, which have no valid agent FK, land in `audit_log`),
// and the decision itself comes from the ONE canonical domain authorize()
// (06 §2) — the gateway only computes its inputs.
//
// Recorded deviations, bounded by the canonical schema (20 §12):
// - rate limiting reuses the T11 `rate_limits` UNLOGGED token-bucket table
//   (17 §6's sketched `tool_rate_counters` table does not exist canonically).
// - `tool_invocations` has no idempotency column — replay dedupe uses the
//   canonical `idempotency_keys` table (20 §2.7) under endpoint "tools.invoke".
// - approval CREATION on `require_approval` stays with the caller's escalate
//   machinery (19 §7, wired in T40); the gateway returns approver + records
//   `awaiting_approval`.
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  authorize,
  type Decision,
  type EscalationTarget,
  type ScopeRelation,
} from "@acos/domain/policies";
import type { AutonomyLevel, RiskClass } from "@acos/domain";
import {
  detectInjection,
  elevateRisk,
  getTool,
  matchesToolPattern,
  rateLimitFor,
  scrubSecretEnv,
  type ToolDefinition,
} from "@acos/tools";
import {
  appendEvents,
  beginIdempotent,
  completeIdempotent,
  CostService,
  type CompanyContext,
  type GuardedDb,
  type NewEventInput,
  type Tx,
} from "@acos/db";
import { parseEventPayload } from "@acos/events";
import {
  agents,
  auditLog,
  budgets,
  costEntries,
  orgEdges,
  policies,
  rateLimits,
  tasks,
  toolInvocations,
  toolPermissions,
} from "@acos/db/schema";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

export interface ToolInvokeRequest {
  agentId: string;
  toolName: string;
  input: unknown;
  taskId?: string | undefined;
  agentSessionId?: string | undefined;
  workspaceId?: string | undefined;
  /** S5 taint bit: arguments derive from external content (17 §7.4). */
  tainted?: boolean | undefined;
  /** Relation between the agent and the touched resource (06 §1). */
  scopeRelation?: ScopeRelation | undefined;
  /** Temporal activity attempt key — replays return the recorded result. */
  idempotencyKey?: string | undefined;
  /**
   * E4/A (T30): AUDIT + POLICY ONLY — validate, authorize, write the audit
   * row, but do NOT dispatch. The CLI-in-container runs its own built-in
   * Bash/Read/Edit/Write inside the sandbox and asks the gateway first (its
   * PreToolUse hook); executing it a second time here would be wrong AND
   * would double the side effect. INV-3 is preserved because the per-op
   * decision and the `tool_invocations` row still happen.
   */
  auditOnly?: boolean | undefined;
}

export interface ToolInvokeResponse {
  invocationId: string | null;
  decision: "allow" | "deny" | "require_approval";
  status: "denied" | "awaiting_approval" | "dispatched" | "succeeded" | "failed";
  reason: string | null;
  approver?: EscalationTarget;
  riskClass: RiskClass;
  elevatedFrom?: RiskClass;
  output?: unknown;
  error?: string;
  costCents?: number;
  retryAfterSec?: number;
  replayed?: boolean;
  /** S5 (17 §7.4): the OUTPUT tripped the injection heuristics — callers
   *  must treat it as tainted (fence + taint bit on derived calls). */
  outputFlagged?: boolean;
  flaggedPatterns?: string[];
}

/** Execution seam per sandboxLevel/scopes — implemented in T40 (sandbox-
 *  manager / egress proxy / adapters); tests inject fakes. */
export interface ToolDispatchPort {
  /**
   * Optional environment preparation (workspace provisioning, image pulls)
   * — runs BEFORE the tool's execution window under its own generous cap:
   * `timeoutMs` is the EXECUTION timeout (17 §2), not a provisioning budget.
   */
  prepare?(req: {
    ctx: CompanyContext;
    tool: ToolDefinition;
    agentId: string;
    taskId: string | null;
  }): Promise<void>;
  dispatch(req: {
    ctx: CompanyContext;
    tool: ToolDefinition;
    input: unknown;
    agentId: string;
    taskId: string | null;
    /** Yaşayan ajan terminali anahtarı (2026-08-19 runtime): oturum bağlamı
     *  varsa terminal.run kareleri ajan başına TEK kalıcı oturumda birikir. */
    agentSessionId?: string | null;
    workspaceId: string | null;
    /** Resolved server-side at dispatch time only — S2. */
    credentials: Record<string, string>;
  }): Promise<{ output: unknown; costCents?: number; resultSummary?: string }>;
}

/** Workspace provisioning allowance (first-touch clone + image pull). */
const PREPARE_TIMEOUT_MS = 600_000;

/**
 * A3: how long a `dispatched` invocation may hold its budget reservation.
 * Bounded by the longest possible execution window (PREPARE_TIMEOUT_MS plus
 * the widest tool timeout / the 45-minute dispatch proxy) so that an
 * invocation orphaned by a crashed process cannot pin a budget forever.
 */
const IN_FLIGHT_RESERVATION_MS = 60 * 60 * 1000;

export type CredentialResolver = (
  ctx: CompanyContext,
  name: string,
) => Promise<string | null>;

export interface ToolGatewayDeps {
  db: GuardedDb;
  dispatch?: ToolDispatchPort;
  resolveCredential?: CredentialResolver;
  now?: () => Date;
}

const NOT_WIRED: ToolDispatchPort = {
  dispatch: () => Promise.reject(new Error("tool dispatch not wired (lands with T40)")),
};

interface GrantConstraints {
  pathPrefixes?: string[];
  repoAllowlist?: string[];
  branchPatterns: string[];
  domainAllowlist?: string[];
  spendCapCents?: number;
  monthlySpendCapCents?: number;
  maxTimeoutSec?: number;
  onCapExceeded: "deny" | "escalate";
}

type ConstraintOutcome =
  | { ok: true }
  | { ok: false; detail: string; escalate: boolean };

interface PolicyRule {
  actionPattern?: string;
  subject?: { kind: "agent" | "position" | "org_unit"; id: string };
  condition?: { maxCostCents?: number; riskAtMost?: RiskClass; requiresTaint?: boolean };
  approver?: EscalationTarget;
}

const RISK_ORDER: RiskClass[] = ["R0", "R1", "R2", "R3"];

/**
 * Y4 (2026-08-15 code review): grant-constraint helpers, fail-closed.
 *
 * Path comparison happens on a normalized, workspace-relative form so a
 * traversal (`src/../../etc/passwd`) can never satisfy a `src/` prefix, and
 * matching stops at segment boundaries so `src` does not admit `srcret/`.
 * Returns null when the path leaves the workspace.
 */
function normalizeRelPath(input: string): string | null {
  const segments = input.replace(/\\/g, "/").split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null; // escapes the workspace root
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

/**
 * Y4: branch patterns come from the DB. They are anchored (an unanchored
 * `main` also matched `not-main-really`) and the subject is length-bounded to
 * blunt catastrophic backtracking; an invalid pattern denies rather than
 * throwing or silently allowing.
 */
function branchMatches(pattern: string, branch: string): boolean {
  if (branch.length > 255) return false;
  // A pattern the author anchored at the start is a PREFIX rule — `^task/`
  // must keep matching `task/81-fix-login`. Re-grouping the remainder also
  // contains a top-level alternation, so `^a|b` can no longer match a bare
  // `b`. A pattern with no anchor of its own is a full match, which is what
  // stops `main` from also allowing `not-main-really`.
  const anchored = pattern.startsWith("^")
    ? `^(?:${pattern.slice(1)})`
    : `^(?:${pattern})$`;
  try {
    return new RegExp(anchored).test(branch);
  } catch {
    return false;
  }
}

export class ToolGateway {
  private readonly db: GuardedDb;
  private readonly dispatchPort: ToolDispatchPort;
  private readonly resolveCredential: CredentialResolver;
  private readonly now: () => Date;
  private readonly costs: CostService;

  constructor(deps: ToolGatewayDeps) {
    this.db = deps.db;
    this.dispatchPort = deps.dispatch ?? NOT_WIRED;
    this.resolveCredential = deps.resolveCredential ?? (() => Promise.resolve(null));
    this.now = deps.now ?? (() => new Date());
    this.costs = new CostService(this.db, this.now);
  }

  async invoke(ctx: CompanyContext, req: ToolInvokeRequest): Promise<ToolInvokeResponse> {
    // ---- 1. identity: agent exists, is active, belongs to this company ----
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, req.agentId)))
      .limit(1);
    if (!agent || agent.status !== "active") {
      // no valid agent FK ⇒ the always-written audit row lands in audit_log
      await this.db.transaction(async (tx) => {
        await tx.insert(auditLog).values({
          companyId: ctx.companyId,
          actorKind: "system",
          action: "tool.invoke.identity_denied",
          targetKind: "agent",
          targetId: agent?.id ?? null,
          meta: { toolName: req.toolName, agentId: req.agentId, status: agent?.status ?? "missing" },
        });
      });
      return {
        invocationId: null,
        decision: "deny",
        status: "denied",
        reason: "IDENTITY_INVALID",
        riskClass: "R0",
      };
    }

    // ---- 2. registry + schema (fail-closed; S2 scrubbing BEFORE parse) ----
    const def = getTool(req.toolName);
    if (!def) {
      return this.finalizeDenied(ctx, req, agent.id, "R0", "TOOL_NOT_REGISTERED", req.input);
    }
    let rawInput = req.input;
    if (rawInput && typeof rawInput === "object" && "env" in rawInput) {
      const env = (rawInput as { env?: unknown }).env;
      if (env && typeof env === "object") {
        const { env: clean } = scrubSecretEnv(env as Record<string, string>);
        rawInput = { ...(rawInput as object), env: clean };
      }
    }
    const parsed = def.input.safeParse(rawInput);
    if (!parsed.success) {
      const detail = (parsed.error.issues as { path: (string | number)[]; message: string }[])
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return this.finalizeDenied(
        ctx,
        req,
        agent.id,
        def.risk,
        `INVALID_INPUT: ${detail}`.slice(0, 500),
        rawInput,
      );
    }
    const input = parsed.data as Record<string, unknown>;

    // ---- idempotent replay (Temporal activity retries, 17 §7.2) ----
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ tool: req.toolName, agent: req.agentId, input }))
      .digest("hex");
    if (req.idempotencyKey) {
      const start = await this.db.transaction((tx) =>
        beginIdempotent(tx, ctx, {
          key: req.idempotencyKey!,
          endpoint: "tools.invoke",
          requestHash,
        }),
      );
      if (start.kind === "replay") {
        return { ...(start.responseBody as ToolInvokeResponse), replayed: true };
      }
      if (start.kind === "mismatch") {
        return this.finalizeDenied(
          ctx, req, agent.id, def.risk, "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT", input,
        );
      }
      // B3 (2026-08-15 code review): `in_flight` used to always proceed —
      // a retry could run the SAME side-effecting command a second time
      // while the first was still executing in the container (npm install,
      // migrations, test suites in triplicate). Read-only tools keep the
      // takeover semantics; side-effecting ones are now fail-closed.
      if (start.kind === "in_flight" && !def.sideEffectFree) {
        return this.finalizeDenied(
          ctx,
          req,
          agent.id,
          def.risk,
          "IN_FLIGHT_DUPLICATE: a prior attempt with this idempotency key is still running",
          input,
        );
      }
      // fresh | in_flight(read-only) → proceed (the crashed first attempt
      // never recorded a result; this attempt takes over the key)
    }

    // ---- 3. grant lookup: agent > position > org_unit (17 §4.1) ----
    const unitRows = await this.db
      .select({ unitId: orgEdges.toUnitId })
      .from(orgEdges)
      .where(
        and(
          eq(orgEdges.companyId, ctx.companyId),
          eq(orgEdges.fromAgentId, agent.id),
          eq(orgEdges.kind, "member_of"),
          isNull(orgEdges.endedAt),
        ),
      );
    const unitIds = unitRows.map((r) => r.unitId).filter((u): u is string => !!u);
    // Faz E: `subjectFilters[1]` ölü koddu — position dalı aşağıda kendi
    // subject_kind kontrolüyle zaten kuruluyor, buradaki ikinci girdi hiç
    // okunmuyordu. Yanlış okunduğunda "position grant'i subject_kind'sız
    // eşleşiyor" gibi görünüyordu ki öyle değil.
    const agentSubjectFilter = and(
      eq(toolPermissions.subjectKind, "agent"),
      eq(toolPermissions.subjectId, agent.id),
    );
    const grantRows = await this.db
      .select()
      .from(toolPermissions)
      .where(
        and(
          eq(toolPermissions.companyId, ctx.companyId),
          isNull(toolPermissions.revokedAt),
          or(isNull(toolPermissions.expiresAt), gt(toolPermissions.expiresAt, this.now())),
          or(
            agentSubjectFilter,
            and(
              eq(toolPermissions.subjectKind, "position"),
              eq(toolPermissions.subjectId, agent.positionId),
            ),
            unitIds.length > 0
              ? and(
                  eq(toolPermissions.subjectKind, "org_unit"),
                  inArray(toolPermissions.subjectId, unitIds),
                )
              : sql`false`,
          ),
        ),
      );
    const applicable = grantRows.filter((g) => matchesToolPattern(g.toolName, def.name));
    // most specific subject kind wins; within it, constraints merge by
    // INTERSECTION (least privilege, 17 §4.1)
    const byKind = (kind: string) => applicable.filter((g) => g.subjectKind === kind);
    const winning =
      byKind("agent").length > 0
        ? byKind("agent")
        : byKind("position").length > 0
          ? byKind("position")
          : byKind("org_unit");
    const permissionGranted = winning.length > 0;
    const constraints = mergeConstraints(winning.map((g) => g.constraints as object));

    // ---- 4. constraint evaluation (17 §4.2) ----
    let constraintOutcome: ConstraintOutcome = { ok: true };
    let estCostCents = def.estimateCost(input).amountCents;
    if (permissionGranted) {
      // maxTimeoutSec CLAMPS rather than denies
      if (
        constraints.maxTimeoutSec !== undefined &&
        typeof input.timeoutSec === "number" &&
        input.timeoutSec > constraints.maxTimeoutSec
      ) {
        input.timeoutSec = constraints.maxTimeoutSec;
        estCostCents = def.estimateCost(input).amountCents;
      }
      constraintOutcome = await this.evaluateConstraints(ctx, def, input, constraints, {
        agentId: agent.id,
        estCostCents,
      });
    }

    // ---- 5. policy rows: deny → require_approval → allow bands (18 §4.2) ----
    const effectiveRisk = req.tainted ? elevateRisk(def.risk) : def.risk;
    const elevatedFrom = req.tainted && effectiveRisk !== def.risk ? def.risk : undefined;
    const policyRows = await this.db
      .select()
      .from(policies)
      .where(
        and(
          eq(policies.companyId, ctx.companyId),
          eq(policies.enabled, true),
          inArray(policies.kind, ["tool", "standing_approval"]),
        ),
      );
    const matching = policyRows
      .filter((p) => {
        const rule = (p.rule ?? {}) as PolicyRule;
        if (!matchesToolPattern(rule.actionPattern ?? "*", def.name)) return false;
        if (rule.subject) {
          if (rule.subject.kind === "agent" && rule.subject.id !== agent.id) return false;
          if (rule.subject.kind === "position" && rule.subject.id !== agent.positionId)
            return false;
          if (rule.subject.kind === "org_unit" && !unitIds.includes(rule.subject.id))
            return false;
        }
        const cond = rule.condition ?? {};
        if (cond.maxCostCents !== undefined && estCostCents > cond.maxCostCents) return false;
        if (
          cond.riskAtMost !== undefined &&
          RISK_ORDER.indexOf(effectiveRisk) > RISK_ORDER.indexOf(cond.riskAtMost)
        )
          return false;
        if (cond.requiresTaint === false && req.tainted) return false;
        return true;
      })
      .sort((a, b) => a.priority - b.priority);
    const denyRule = matching.find((p) => p.effect === "deny");
    const approvalRule = matching.find((p) => p.effect === "require_approval");
    const allowRule = matching.find((p) => p.effect === "allow");

    // ---- 6. budget: tightest applicable scope (26 §1) ----
    // Advisory read — the binding check-and-reserve happens under a row lock
    // in the invocation transaction below (A3).
    const budget = await this.db.transaction((tx) =>
      this.tightestBudget(tx, ctx, req.taskId ?? null, false),
    );

    // ---- 6.5 Walkthrough bulgusu (2026-08-19): Founder'ın bu GÖREV için
    // verdiği güncel ONAY, görev altındaki org-mutasyon araçları (R3:
    // org.team.create / agent.hire, github.repo.ensure) için geçerli
    // yetkidir — "tek toplu onay → CEO uygular" (LIFECYCLE TASK 9/10).
    // Onaysız R3 yine Founder'a eskale olur; kapı kalkmıyor, MÜKERRER
    // onay istemi kalkıyor. 24 saatlik pencere.
    let taskApprovalGrant = false;
    if (
      req.taskId &&
      ["org.team.create", "agent.hire", "github.repo.ensure"].includes(def.name)
    ) {
      const { approvals: approvalsTable } = await import("@acos/db/schema");
      const { desc: descOrder } = await import("drizzle-orm");
      const [latestApproval] = await this.db
        .select({ status: approvalsTable.status, decidedAt: approvalsTable.decidedAt })
        .from(approvalsTable)
        .where(
          and(eq(approvalsTable.companyId, ctx.companyId), eq(approvalsTable.taskId, req.taskId)),
        )
        .orderBy(descOrder(approvalsTable.createdAt))
        .limit(1);
      taskApprovalGrant =
        latestApproval?.status === "approved" &&
        latestApproval.decidedAt !== null &&
        Date.now() - latestApproval.decidedAt.getTime() < 24 * 3_600_000;
    }

    // ---- 7. THE decision — canonical domain authorize() (06 §2) ----
    let decision: Decision;
    if (!constraintOutcome.ok && constraintOutcome.escalate) {
      // 17 §4.2 example 2: cap exceeded + onCapExceeded=escalate degrades
      // the standing delegation into a Founder/manager brief, not a deny
      decision = { verdict: "require_approval", approver: "manager", briefRequired: true };
    } else {
      decision = authorize({
        autonomyLevel: agent.autonomyLevel as AutonomyLevel,
        riskClass: effectiveRisk,
        scopeRelation: req.scopeRelation ?? "own_team",
        founderOnlyCategory: def.founderCategory !== undefined,
        hasStandingGrant: allowRule !== undefined || taskApprovalGrant,
        permissionGranted,
        constraintsSatisfied: constraintOutcome.ok,
        policyDeny: denyRule !== undefined,
        ...(denyRule && { policyDenyReason: `POLICY_DENY:${denyRule.name}` }),
        estCostCents,
        budgetRemainingCents: budget.remainingCents,
        budgetHard: budget.hard,
        externallyInfluenced: req.tainted ?? false,
      });
      if (decision.verdict === "allow" && approvalRule) {
        const rule = (approvalRule.rule ?? {}) as PolicyRule;
        decision = {
          verdict: "require_approval",
          approver: rule.approver ?? "founder",
          briefRequired: true,
        };
      }
    }

    // ---- rate limit (17 §6) — only would-be-dispatched calls consume ----
    let retryAfterSec: number | undefined;
    if (decision.verdict === "allow") {
      const limit = rateLimitFor(def);
      const agentTake = await this.takeToken(
        `tool:${ctx.companyId}:${agent.id}:${def.name}`,
        limit.perAgentPerMin,
      );
      const companyTake = agentTake.ok
        ? await this.takeToken(`tool:${ctx.companyId}:*:${def.name}`, limit.perCompanyPerMin)
        : agentTake;
      if (!agentTake.ok || !companyTake.ok) {
        retryAfterSec = Math.max(agentTake.retryAfterSec ?? 0, companyTake.retryAfterSec ?? 0);
        decision = { verdict: "deny", reason: "RATE_LIMITED" };
      }
    }

    // ---- audit row — ALWAYS — + events, one tx (17 §4 step 6) ----
    const actor = { kind: "agent" as const, id: agent.id };
    const refs = {
      taskId: req.taskId ?? null,
      agentId: agent.id,
    };
    const audited = await this.db.transaction(async (tx) => {
      // A3 (2026-08-15 code review; 26 §4 "a step must pass every applicable
      // scope" + §5.2 gateway pre-execution check): CHECK-AND-RESERVE, atomic.
      //
      // The step-6 read is advisory — N concurrent invocations all observe the
      // same remainder, all pass it, and the scope is overspent by (N-1)×est.
      // The governing row is therefore re-read FOR UPDATE inside the very
      // transaction that writes the invocation row, and the estimate then
      // rides that row as an in-flight reservation (`status='dispatched'` +
      // `cost_cents=est`) which `tightestBudget` subtracts. The next caller
      // blocks on the lock and reads a remainder that already contains it.
      // Settlement swaps the reservation for the real ledger entry in a
      // single transaction (A2), so nothing is ever counted twice.
      if (decision.verdict === "allow" && estCostCents > 0) {
        const locked = await this.tightestBudget(tx, ctx, req.taskId ?? null, true);
        if (locked.hard && estCostCents > locked.remainingCents) {
          decision = { verdict: "deny", reason: "BUDGET_EXCEEDED", redirect: "manager" };
        }
      }
      const detailReason =
        decision.verdict === "deny"
          ? decision.reason +
            (!constraintOutcome.ok && !constraintOutcome.escalate
              ? `:${constraintOutcome.detail}`
              : "")
          : decision.verdict === "require_approval"
            ? `approver=${decision.approver}` +
              (!constraintOutcome.ok ? `:${constraintOutcome.detail}` : "")
            : "authorized";
      const status: ToolInvokeResponse["status"] =
        decision.verdict === "deny"
          ? "denied"
          : decision.verdict === "require_approval"
            ? "awaiting_approval"
            : "dispatched";
      // The reservation only ever sits on an in-flight row; settlement
      // overwrites it with the actual cost (or 0 on failure), so the column's
      // settled meaning is unchanged.
      const reservedCents = status === "dispatched" ? estCostCents : 0;
      const [row] = await tx
        .insert(toolInvocations)
        .values({
          companyId: ctx.companyId,
          agentId: agent.id,
          taskId: req.taskId ?? null,
          agentSessionId: req.agentSessionId ?? null,
          toolName: def.name,
          riskClass: effectiveRisk,
          input: { ...input, ...(elevatedFrom && { __elevatedFrom: elevatedFrom }) },
          decision: decision.verdict,
          decisionReason: detailReason.slice(0, 1000),
          status,
          workspaceId: req.workspaceId ?? null,
          costCents: reservedCents,
        })
        .returning({ id: toolInvocations.id });
      await emitDomainEvent(tx, ctx, {
        type: "tool.invocation.requested",
        actor,
        ...refs,
        payload: { invocationId: row!.id, toolName: def.name, riskClass: effectiveRisk },
      });
      if (decision.verdict === "deny") {
        await emitDomainEvent(tx, ctx, {
          type: "tool.invocation.denied",
          actor,
          ...refs,
          payload: { toolName: def.name, riskClass: effectiveRisk, reason: detailReason },
        });
        if (detailReason.startsWith("RATE_LIMITED")) {
          await emitDomainEvent(tx, ctx, {
            type: "tool.rate.throttled",
            actor,
            ...refs,
            payload: { agentId: agent.id, toolName: def.name, count: 1 },
          });
        }
      }
      // R2+ decisions mirror into audit_log (S7, 17 §4.3)
      if (RISK_ORDER.indexOf(effectiveRisk) >= RISK_ORDER.indexOf("R2")) {
        await tx.insert(auditLog).values({
          companyId: ctx.companyId,
          actorKind: "agent",
          actorId: agent.id,
          action: `tool.invoke.${decision.verdict}`,
          targetKind: "tool_invocation",
          targetId: row!.id,
          meta: { toolName: def.name, riskClass: effectiveRisk, reason: detailReason },
        });
      }
      return { invocationId: row!.id, detailReason, status };
    });
    const { invocationId, detailReason, status } = audited;

    const base: ToolInvokeResponse = {
      invocationId,
      decision: decision.verdict,
      status,
      reason: decision.verdict === "allow" ? null : detailReason,
      riskClass: effectiveRisk,
      ...(elevatedFrom && { elevatedFrom }),
      ...(decision.verdict === "require_approval" && { approver: decision.approver }),
      ...(retryAfterSec !== undefined && { retryAfterSec }),
    };
    if (decision.verdict !== "allow") {
      await this.recordIdempotent(ctx, req, requestHash, base);
      return base;
    }

    // ---- 7a. audit-only (E4/A): karar verildi, satır yazıldı, ÇALIŞTIRMA YOK.
    // Sandbox içindeki CLI komutu kendisi koşturur; burada ikinci kez koşmak
    // yan etkiyi ikiye katlardı. Maliyet 0'dır — bu satır bir icra değil, bir
    // karardır; 0 maliyetli çağrı zaten defter kaydı üretmez (26 §2).
    if (req.auditOnly) {
      await this.db.transaction(async (tx) => {
        await tx
          .update(toolInvocations)
          .set({
            status: "succeeded",
            costCents: 0,
            durationMs: 0,
            finishedAt: this.now(),
            resultSummary: "builtin allowed; executed by the CLI inside the sandbox",
          })
          .where(
            and(eq(toolInvocations.companyId, ctx.companyId), eq(toolInvocations.id, invocationId)),
          );
        await emitDomainEvent(tx, ctx, {
          type: "tool.invocation.completed",
          actor,
          ...refs,
          payload: {
            toolName: def.name,
            riskClass: effectiveRisk,
            costCents: 0,
            resultDigest: "builtin:audit-only",
          },
        });
      });
      const allowed: ToolInvokeResponse = { ...base, status: "succeeded", costCents: 0 };
      await this.recordIdempotent(ctx, req, requestHash, allowed);
      return allowed;
    }

    // ---- 7b. dispatch (S2 credentials resolved HERE, never earlier) ----
    const credentials: Record<string, string> = {};
    for (const ref of def.credentialRefs ?? []) {
      const value = await this.resolveCredential(ctx, ref);
      if (value !== null) credentials[ref] = value;
    }
    const started = this.now().getTime();
    let result: { output: unknown; costCents?: number; resultSummary?: string };
    try {
      // provisioning (first-touch worktree + container) is NOT billed to the
      // tool's execution timeout — it runs under its own allowance
      if (this.dispatchPort.prepare) {
        await withTimeout(
          this.dispatchPort.prepare({
            ctx,
            tool: def,
            agentId: agent.id,
            taskId: req.taskId ?? null,
          }),
          PREPARE_TIMEOUT_MS,
        );
      }
      result = await withTimeout(
        this.dispatchPort.dispatch({
          ctx,
          tool: def,
          input,
          agentId: agent.id,
          taskId: req.taskId ?? null,
          agentSessionId: req.agentSessionId ?? null,
          workspaceId: req.workspaceId ?? null,
          credentials,
        }),
        def.timeoutMs,
      );
      const outParsed = def.output.safeParse(result.output);
      if (!outParsed.success) {
        throw new Error(`output schema mismatch: ${outParsed.error.issues[0]?.message}`);
      }
      result.output = outParsed.data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed: ToolInvokeResponse = {
        ...base,
        status: "failed",
        error: message.slice(0, 1000),
      };
      await this.db.transaction(async (tx) => {
        await tx
          .update(toolInvocations)
          .set({
            status: "failed",
            error: message.slice(0, 2000),
            durationMs: this.now().getTime() - started,
            finishedAt: this.now(),
            // A3: nothing ran to completion, so the reservation is released
            // (leaving `dispatched` already drops it out of the in-flight sum)
            // and the row must not claim a cost that has no ledger entry.
            costCents: 0,
          })
          .where(
            and(eq(toolInvocations.companyId, ctx.companyId), eq(toolInvocations.id, invocationId)),
          );
        // İzin verilmiş ama çalışırken patlayan çağrı zaman çizelgesine de
        // düşer (10 §10.1, 2026-08-15 Founder kararıyla eklendi). Önceden bu
        // dal sessizdi: Founder yalnız başarıları görüyor, ajan aynı hatayı
        // tekrarlarken ekranda hiçbir şey olmuyordu.
        await emitDomainEvent(tx, ctx, {
          type: "tool.invocation.failed",
          actor,
          ...refs,
          payload: {
            toolName: def.name,
            riskClass: effectiveRisk,
            error: message.slice(0, 500),
          },
        });
      });
      await this.recordIdempotent(ctx, req, requestHash, failed);
      return failed;
    }

    const actualCost = result.costCents ?? estCostCents;
    const durationMs = this.now().getTime() - started;

    // S5 (17 §7.4): outputs whose content originates outside the platform
    // pass the instruction-detection heuristics — hits flag the invocation
    // (recorded deviation: the canonical status CHECK has no 'flagged' value,
    // so the flag rides the events + response; consumers fence + taint)
    const provenance = (result.output as { provenance?: string } | null)?.provenance;
    const external = provenance === "workspace" || provenance === "web";
    const scan = external
      ? detectInjection(JSON.stringify(result.output ?? "").slice(0, 100_000))
      : { flagged: false, patterns: [], severe: false, version: 0 };

    await this.db.transaction(async (tx) => {
      // Lock ordering, A2 + A3 together. The reserve path takes the governing
      // task row FOR UPDATE and only then the outbox sequence; settling books
      // the ledger entry (which bumps `tasks.spent_cents`) after emitting
      // events, i.e. sequence-then-task. Two concurrent invocations against
      // the same task therefore grabbed the two locks in opposite orders and
      // Postgres aborted one with 40P01. Taking the task lock up front puts
      // both paths on the same order.
      if (req.taskId && actualCost > 0) {
        await tx.execute(
          sql`SELECT 1 FROM tasks WHERE company_id = ${ctx.companyId} AND id = ${req.taskId} FOR UPDATE`,
        );
      }
      await tx
        .update(toolInvocations)
        .set({
          status: "succeeded",
          costCents: actualCost,
          durationMs,
          finishedAt: this.now(),
          resultSummary: (result.resultSummary ?? "").slice(0, 2000) || null,
        })
        .where(
          and(eq(toolInvocations.companyId, ctx.companyId), eq(toolInvocations.id, invocationId)),
        );
      await emitDomainEvent(tx, ctx, {
        type: "tool.invocation.completed",
        actor,
        ...refs,
        payload: {
          toolName: def.name,
          riskClass: effectiveRisk,
          costCents: actualCost,
          resultDigest: (result.resultSummary ?? "").slice(0, 200),
        },
      });
      if (scan.flagged) {
        const sourceDigest = createHash("sha256")
          .update(JSON.stringify(result.output ?? ""))
          .digest("hex")
          .slice(0, 16);
        await emitDomainEvent(tx, ctx, {
          type: "tool.output.flagged",
          actor,
          ...refs,
          payload: { invocationId, pattern: scan.patterns.join(","), sourceDigest },
        });
        await emitDomainEvent(tx, ctx, {
          type: "policy.injection.flagged",
          actor,
          ...refs,
          payload: {
            source: `${provenance}:${def.name}`,
            contentDigest: sourceDigest,
            triggeredAction: def.name,
          },
        });
        if (scan.severe) {
          await emitDomainEvent(tx, ctx, {
            type: "security.alert",
            actor: { kind: "system", id: null },
            ...refs,
            payload: {
              severity: "high",
              category: "injection",
              detail: `severe injection pattern in ${def.name} output: ${scan.patterns.join(",")}`,
            },
          });
        }
      }
      // A2 (2026-08-15 code review; 26 §2): the ledger entry commits in the
      // SAME transaction as the invocation it prices — "`tool_invocations` +
      // cost entry together [...] no async billing pipeline, no drift, no lost
      // attribution on crash". It used to run after this transaction had
      // committed: a crash in between left the call `succeeded` with no cost
      // entry, so every budget scope under-counted it (a real race since B1
      // made LLM/tool costs non-zero). Committing here also retires the A3
      // in-flight reservation and books the real spend in one step.
      if (actualCost > 0) {
        await this.costs.recordCostInTx(tx, ctx, {
          id: invocationId, // exactly-once even on replays
          kind: "tool",
          ref: def.name,
          agentId: agent.id,
          taskId: req.taskId ?? undefined,
          amountCents: actualCost,
        });
      }
    });
    const success: ToolInvokeResponse = {
      ...base,
      status: "succeeded",
      output: result.output,
      costCents: actualCost,
      ...(scan.flagged && { outputFlagged: true, flaggedPatterns: scan.patterns }),
    };
    await this.recordIdempotent(ctx, req, requestHash, success);
    return success;
  }

  // ---------- helpers ----------

  /** Deny before an agent-attributable invocation exists is still audited. */
  private async finalizeDenied(
    ctx: CompanyContext,
    req: ToolInvokeRequest,
    agentId: string,
    risk: RiskClass,
    reason: string,
    input: unknown,
  ): Promise<ToolInvokeResponse> {
    const invocationId = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(toolInvocations)
        .values({
          companyId: ctx.companyId,
          agentId,
          taskId: req.taskId ?? null,
          agentSessionId: req.agentSessionId ?? null,
          toolName: req.toolName,
          riskClass: risk,
          input: (input ?? {}) as object,
          decision: "deny",
          decisionReason: reason.slice(0, 1000),
          status: "denied",
          workspaceId: req.workspaceId ?? null,
        })
        .returning({ id: toolInvocations.id });
      await emitDomainEvent(tx, ctx, {
        type: "tool.invocation.denied",
        actor: { kind: "agent", id: agentId },
        agentId,
        taskId: req.taskId ?? null,
        payload: { toolName: req.toolName, riskClass: risk, reason: reason.slice(0, 500) },
      });
      return row!.id;
    });
    return {
      invocationId,
      decision: "deny",
      status: "denied",
      reason,
      riskClass: risk,
    };
  }

  private async evaluateConstraints(
    ctx: CompanyContext,
    def: ToolDefinition,
    input: Record<string, unknown>,
    c: GrantConstraints,
    meta: { agentId: string; estCostCents: number },
  ): Promise<ConstraintOutcome> {
    // fs: every path in the input must sit under an allowed prefix
    if (c.pathPrefixes && def.scopes.includes("fs")) {
      const paths = [
        ...(typeof input.path === "string" ? [input.path] : []),
        ...(Array.isArray(input.paths) ? (input.paths as string[]) : []),
      ];
      for (const p of paths) {
        // Y4 (2026-08-15 code review): normalize BEFORE comparing and require
        // a segment boundary. Raw startsWith let `src/../../etc/passwd` pass
        // (safeRelPath catches it downstream today, but the check belongs
        // here too — a future tool that skips safeRelPath would open a hole)
        // and let prefix `src` allow the unrelated `srcret/` directory.
        const normalized = normalizeRelPath(p);
        if (normalized === null) {
          return { ok: false, detail: `path_escapes_workspace:${p}`, escalate: false };
        }
        const inPrefix = c.pathPrefixes.some((prefix) => {
          const base = normalizeRelPath(prefix);
          if (base === null) return false;
          return base === "" || normalized === base || normalized.startsWith(`${base}/`);
        });
        if (!inPrefix) {
          return { ok: false, detail: `path_not_in_prefixes:${p}`, escalate: false };
        }
      }
    }
    // git: repo allowlist + branch pattern(s) — ALL patterns must match
    if (c.repoAllowlist && typeof input.repo === "string") {
      if (!c.repoAllowlist.includes(input.repo)) {
        return { ok: false, detail: `repo_not_allowed:${input.repo}`, escalate: false };
      }
    }
    if (c.branchPatterns.length > 0 && typeof input.branch === "string") {
      for (const pattern of c.branchPatterns) {
        // Y4: DB-supplied patterns were unanchored (`main` also matched
        // `not-main-really`) and ran unbounded (ReDoS on a hostile pattern).
        // Anchor + length-bound the subject; a pattern that fails to compile
        // is a DENY, never a pass-through.
        if (!branchMatches(pattern, input.branch)) {
          return { ok: false, detail: `branch_not_allowed:${input.branch}`, escalate: false };
        }
      }
    }
    // network: URL host must be inside the grant's narrowed allowlist
    if (c.domainAllowlist && typeof input.url === "string") {
      // Y4: `new URL()` sat OUTSIDE the caller's try/catch — a malformed URL
      // threw an unhandled error (HTTP 500) instead of a fail-closed deny.
      let host: string;
      try {
        host = new URL(input.url).hostname;
      } catch {
        return { ok: false, detail: "invalid_url", escalate: false };
      }
      const allowed = c.domainAllowlist.some(
        (d) => host === d || host.endsWith(d.startsWith(".") ? d : `.${d}`),
      );
      if (!allowed) {
        return { ok: false, detail: `domain_not_allowed:${host}`, escalate: false };
      }
    }
    // spend caps: per-invocation + rolling 30-day (17 §4.2 example 2)
    const escalate = c.onCapExceeded === "escalate";
    if (c.spendCapCents !== undefined && meta.estCostCents > c.spendCapCents) {
      return { ok: false, detail: "spend_cap_exceeded", escalate };
    }
    if (c.monthlySpendCapCents !== undefined) {
      const since = new Date(this.now().getTime() - 30 * 24 * 60 * 60 * 1000);
      const [row] = await this.db
        .select({ total: sql<string>`coalesce(sum(${costEntries.amountCents}), 0)` })
        .from(costEntries)
        .where(
          and(
            eq(costEntries.companyId, ctx.companyId),
            eq(costEntries.kind, "tool"),
            eq(costEntries.ref, def.name),
            eq(costEntries.agentId, meta.agentId),
            gt(costEntries.occurredAt, since),
          ),
        );
      const spent = Number(row?.total ?? 0);
      if (spent + meta.estCostCents > c.monthlySpendCapCents) {
        return { ok: false, detail: "monthly_spend_cap_exceeded", escalate };
      }
    }
    return { ok: true };
  }

  /**
   * Tightest applicable budget: task total (hard, T28) else company daily.
   *
   * A3: the remainder subtracts BOTH settled ledger spend and the estimates of
   * invocations still in flight (`status='dispatched'`), so a concurrent call
   * that has been authorised but has not billed yet is already accounted for.
   * With `lock` the governing row is taken FOR UPDATE first, which serialises
   * concurrent check-and-reserve transactions on that row.
   */
  private async tightestBudget(
    tx: Tx,
    ctx: CompanyContext,
    taskId: string | null,
    lock: boolean,
  ): Promise<{ remainingCents: number; hard: boolean }> {
    const inFlightSince = new Date(this.now().getTime() - IN_FLIGHT_RESERVATION_MS);
    if (taskId) {
      const taskQuery = tx
        .select({ budget: tasks.budgetCents, spent: tasks.spentCents })
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)))
        .limit(1);
      const [task] = lock ? await taskQuery.for("update") : await taskQuery;
      if (task?.budget != null) {
        const reserved = await this.inFlightReservedCents(tx, ctx, taskId, inFlightSince);
        return { remainingCents: Math.max(0, task.budget - task.spent - reserved), hard: true };
      }
    }
    const budgetQuery = tx
      .select()
      .from(budgets)
      .where(
        and(
          eq(budgets.companyId, ctx.companyId),
          eq(budgets.scopeKind, "company"),
          eq(budgets.period, "daily"),
          eq(budgets.enabled, true),
        ),
      )
      .limit(1);
    const [companyDaily] = lock ? await budgetQuery.for("update") : await budgetQuery;
    if (companyDaily) {
      const dayStart = new Date(this.now());
      dayStart.setUTCHours(0, 0, 0, 0);
      const [row] = await tx
        .select({ total: sql<string>`coalesce(sum(${costEntries.amountCents}), 0)` })
        .from(costEntries)
        .where(
          and(eq(costEntries.companyId, ctx.companyId), gt(costEntries.occurredAt, dayStart)),
        );
      const reserved = await this.inFlightReservedCents(tx, ctx, null, inFlightSince);
      return {
        remainingCents: Math.max(
          0,
          companyDaily.limitCents - Number(row?.total ?? 0) - reserved,
        ),
        hard: companyDaily.kind === "hard",
      };
    }
    // No budget row governs this call. 26 §5.3 makes the company daily budget
    // the circuit breaker's trigger, so the seed plants one for every company
    // (apps/server/src/seed.ts) — this fallback only survives for installs
    // that deliberately deleted it.
    return { remainingCents: Number.MAX_SAFE_INTEGER, hard: false };
  }

  /** A3: estimates held by invocations that are dispatched but not settled. */
  private async inFlightReservedCents(
    tx: Tx,
    ctx: CompanyContext,
    taskId: string | null,
    since: Date,
  ): Promise<number> {
    const [row] = await tx
      .select({ total: sql<string>`coalesce(sum(${toolInvocations.costCents}), 0)` })
      .from(toolInvocations)
      .where(
        and(
          eq(toolInvocations.companyId, ctx.companyId),
          eq(toolInvocations.status, "dispatched"),
          gt(toolInvocations.createdAt, since),
          ...(taskId ? [eq(toolInvocations.taskId, taskId)] : []),
        ),
      );
    return Number(row?.total ?? 0);
  }

  /** Token bucket on the T11 UNLOGGED rate_limits table (no Redis, 17 §6). */
  private async takeToken(
    key: string,
    perMin: number,
  ): Promise<{ ok: boolean; retryAfterSec?: number }> {
    const refillPerSec = perMin / 60;
    const nowTs = this.now();
    return this.db.transaction(async (tx) => {
      await tx
        .insert(rateLimits)
        .values({ key, tokens: perMin, refilledAt: nowTs })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(rateLimits)
        .where(eq(rateLimits.key, key))
        .for("update");
      const elapsedSec = Math.max(0, (nowTs.getTime() - row!.refilledAt.getTime()) / 1000);
      const tokens = Math.min(perMin, row!.tokens + elapsedSec * refillPerSec);
      if (tokens < 1) {
        const retryAfterSec = Math.ceil((1 - tokens) / refillPerSec);
        await tx
          .update(rateLimits)
          .set({ tokens, refilledAt: nowTs })
          .where(eq(rateLimits.key, key));
        return { ok: false, retryAfterSec };
      }
      await tx
        .update(rateLimits)
        .set({ tokens: tokens - 1, refilledAt: nowTs })
        .where(eq(rateLimits.key, key));
      return { ok: true };
    });
  }

  private async recordIdempotent(
    ctx: CompanyContext,
    req: ToolInvokeRequest,
    _requestHash: string,
    response: ToolInvokeResponse,
  ): Promise<void> {
    if (!req.idempotencyKey) return;
    await this.db.transaction((tx) =>
      completeIdempotent(
        tx,
        ctx,
        { key: req.idempotencyKey!, endpoint: "tools.invoke" },
        200,
        response,
      ),
    );
  }
}

function mergeConstraints(raw: object[]): GrantConstraints {
  const merged: GrantConstraints = { branchPatterns: [], onCapExceeded: "deny" };
  let sawEscalate = raw.length > 0;
  for (const entry of raw) {
    const c = entry as Record<string, unknown>;
    for (const key of ["pathPrefixes", "repoAllowlist", "domainAllowlist"] as const) {
      const list = c[key];
      if (Array.isArray(list)) {
        merged[key] =
          merged[key] === undefined
            ? [...(list as string[])]
            : merged[key]!.filter((v) => (list as string[]).includes(v)); // intersection
      }
    }
    if (typeof c.branchPattern === "string") merged.branchPatterns.push(c.branchPattern);
    for (const key of ["spendCapCents", "monthlySpendCapCents", "maxTimeoutSec"] as const) {
      const value = c[key];
      if (typeof value === "number") {
        merged[key] = merged[key] === undefined ? value : Math.min(merged[key]!, value); // min
      }
    }
    if (c.onCapExceeded !== "escalate") sawEscalate = false; // every grant must opt in
  }
  if (sawEscalate) merged.onCapExceeded = "escalate";
  return merged;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tool timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
