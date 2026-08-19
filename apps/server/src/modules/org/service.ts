// Org engine (04 §1–4, §6; _DECISIONS §5): units/positions CRUD, typed edges
// with the on-write forest/cycle check (per-company advisory lock + recursive
// CTE), escalation-chain walk ending at the virtual Founder, read models.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { type CompanyContext, type GuardedDb, type Tx } from "@acos/db";
import { orgUnits, positions } from "@acos/db/schema";
import { agents, orgEdges } from "@acos/db/schema";
import { emitDomainEvent } from "../events/emit.js";

export class OrgCycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgCycleError";
  }
}

/** Archive/reorg preconditions (04 §1) — maps to HTTP 409 in routes. */
export class OrgConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgConflictError";
  }
}

export type UnitKind = "department" | "team" | "office" | "division";
export type EdgeKind =
  | "reports_to"
  | "manages"
  | "member_of"
  | "leads"
  | "mentors"
  | "collaborates_with";

const UNIT_EDGE_KINDS = new Set<EdgeKind>(["member_of", "leads"]);

export async function orgLockInTx(tx: Tx, ctx: CompanyContext): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"org:" + ctx.companyId}))`);
}

export class OrgService {
  constructor(private readonly db: GuardedDb) {}

  // ---------- units ----------

  async createUnit(
    ctx: CompanyContext,
    input: { name: string; slug: string; kind: UnitKind; parentId?: string | null | undefined },
  ) {
    return this.db.transaction(async (tx) => {
      await orgLockInTx(tx, ctx);
      if (input.parentId) await this.assertUnitParentAcyclic(tx, ctx, null, input.parentId);
      const [unit] = await tx
        .insert(orgUnits)
        .values({
          companyId: ctx.companyId,
          name: input.name,
          slug: input.slug,
          kind: input.kind,
          parentId: input.parentId ?? null,
        })
        .returning();
      // team/department channels auto-provision with their unit (11 §2)
      if (input.kind === "team" || input.kind === "department") {
        const { ChannelService } = await import("@acos/db");
        await new ChannelService(this.db).provisionInTx(tx, ctx, {
          kind: input.kind,
          orgUnitId: unit!.id,
          name: unit!.name,
        });
      }
      const type =
        input.kind === "department"
          ? "department.created"
          : input.kind === "team"
            ? "team.created"
            : "org.unit.created";
      await emitDomainEvent(tx, ctx, {
        type,
        actor: { kind: "founder", id: null },
        payload:
          input.kind === "team"
            ? { orgUnitId: unit!.id, name: unit!.name, departmentId: unit!.parentId ?? undefined }
            : { orgUnitId: unit!.id, name: unit!.name, parentUnitId: unit!.parentId ?? undefined, kind: input.kind },
      });
      return unit!;
    });
  }

  async moveUnit(ctx: CompanyContext, unitId: string, parentId: string | null) {
    return this.db.transaction(async (tx) => {
      await orgLockInTx(tx, ctx);
      if (parentId) await this.assertUnitParentAcyclic(tx, ctx, unitId, parentId);
      const [unit] = await tx
        .update(orgUnits)
        .set({ parentId })
        .where(and(eq(orgUnits.companyId, ctx.companyId), eq(orgUnits.id, unitId)))
        .returning();
      if (!unit) return undefined;
      await emitDomainEvent(tx, ctx, {
        type: "org.unit.updated",
        actor: { kind: "founder", id: null },
        payload: { orgUnitId: unitId, diff: { parentId } },
      });
      return unit;
    });
  }

  /** Unit-tree cycle check — identical CTE pattern to §2, over parent_id. */
  private async assertUnitParentAcyclic(
    tx: Tx,
    ctx: CompanyContext,
    unitId: string | null,
    newParentId: string,
  ): Promise<void> {
    if (unitId !== null && unitId === newParentId) {
      throw new OrgCycleError("unit cannot be its own parent");
    }
    if (unitId === null) return; // creating a fresh unit can never cycle
    const result = await tx.execute(sql`
      WITH RECURSIVE up AS (
        SELECT u.parent_id, 1 AS depth FROM org_units u
        WHERE u.company_id = ${ctx.companyId} AND u.id = ${newParentId}
        UNION ALL
        SELECT u.parent_id, up.depth + 1 FROM org_units u
        JOIN up ON u.id = up.parent_id
        WHERE u.company_id = ${ctx.companyId} AND up.depth < 50
      )
      SELECT 1 AS hit FROM up WHERE parent_id = ${unitId} LIMIT 1
    `);
    if (result.rows.length > 0) {
      throw new OrgCycleError("unit move would create a cycle in the unit tree");
    }
  }

  async listUnits(ctx: CompanyContext) {
    return this.db
      .select()
      .from(orgUnits)
      .where(and(eq(orgUnits.companyId, ctx.companyId), isNull(orgUnits.archivedAt)));
  }

  /**
   * 04 §1: soft-archive a unit. Preconditions (409): no active child units,
   * no non-offboarded agents placed in it. Remaining active unit edges are
   * ended, then archived_at is set — org.unit.archived is catalogued.
   */
  async archiveUnit(ctx: CompanyContext, unitId: string) {
    return this.db.transaction(async (tx) => {
      await orgLockInTx(tx, ctx);
      const [unit] = await tx
        .select()
        .from(orgUnits)
        .where(
          and(
            eq(orgUnits.companyId, ctx.companyId),
            eq(orgUnits.id, unitId),
            isNull(orgUnits.archivedAt),
          ),
        )
        .for("update");
      if (!unit) return undefined;

      const [child] = await tx
        .select({ id: orgUnits.id })
        .from(orgUnits)
        .where(
          and(
            eq(orgUnits.companyId, ctx.companyId),
            eq(orgUnits.parentId, unitId),
            isNull(orgUnits.archivedAt),
          ),
        )
        .limit(1);
      if (child) {
        throw new OrgConflictError("UNIT_HAS_CHILDREN: önce alt birimleri taşıyın veya arşivleyin");
      }
      // draft (hiç aktive edilmemiş) ajanlar bloklamaz — draft→offboarded
      // geçişi makinede yok; yerleşimleri placement endpoint'iyle düzeltilir
      const [member] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, ctx.companyId),
            eq(agents.orgUnitId, unitId),
            inArray(agents.status, ["active", "paused"]),
          ),
        )
        .limit(1);
      if (member) {
        throw new OrgConflictError(
          "UNIT_HAS_AGENTS: önce birimdeki ajanları başka birime taşıyın veya işten çıkarın",
        );
      }

      const endedEdges = await tx
        .update(orgEdges)
        .set({ endedAt: sql`now()` })
        .where(
          and(
            eq(orgEdges.companyId, ctx.companyId),
            eq(orgEdges.toUnitId, unitId),
            isNull(orgEdges.endedAt),
          ),
        )
        .returning({ id: orgEdges.id, endedAt: orgEdges.endedAt });
      for (const edge of endedEdges) {
        await emitDomainEvent(tx, ctx, {
          type: "org.edge.ended",
          actor: { kind: "founder", id: null },
          payload: { edgeId: edge.id, endedAt: edge.endedAt?.toISOString(), reason: "unit.archived" },
        });
      }

      // slug'ı serbest bırak: unique kısıt arşivlileri de kapsıyor — aynı
      // adla yeniden kurulabilsin (Founder akışı: arşivle → yeniden kur)
      const [archived] = await tx
        .update(orgUnits)
        .set({
          archivedAt: sql`now()`,
          slug: sql`${orgUnits.slug} || '-arsiv-' || substr(${orgUnits.id}::text, 1, 8)`,
        })
        .where(and(eq(orgUnits.companyId, ctx.companyId), eq(orgUnits.id, unitId)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "org.unit.archived",
        actor: { kind: "founder", id: null },
        payload: { orgUnitId: unitId, archivedAt: archived!.archivedAt!.toISOString() },
      });
      return archived!;
    });
  }

  // ---------- positions ----------

  /** Walkthrough bulgusu (2026-08-19): UI pozisyonu hep 'member' rolüyle
   *  yaratıyordu — CEO pozisyonu sistemce yönetici sayılmıyordu. Rol artık
   *  formdan gelir; bu uç da mevcut pozisyonun rolünü düzeltir. */
  async updatePositionRole(ctx: CompanyContext, positionId: string, defaultRole: string) {
    const [row] = await this.db
      .update(positions)
      .set({ defaultRole })
      .where(and(eq(positions.companyId, ctx.companyId), eq(positions.id, positionId)))
      .returning();
    return row ?? null;
  }

  async createPosition(
    ctx: CompanyContext,
    input: { title: string; seniorityTrack: string[]; defaultRole: string; description?: string | null | undefined },
  ) {
    return this.db.transaction(async (tx) => {
      const [position] = await tx
        .insert(positions)
        .values({
          companyId: ctx.companyId,
          title: input.title,
          seniorityTrack: input.seniorityTrack,
          defaultRole: input.defaultRole,
          description: input.description ?? null,
        })
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "position.created",
        actor: { kind: "founder", id: null },
        payload: { positionId: position!.id, title: position!.title, seniorityTrack: input.seniorityTrack },
      });
      return position!;
    });
  }

  async listPositions(ctx: CompanyContext) {
    return this.db
      .select()
      .from(positions)
      .where(and(eq(positions.companyId, ctx.companyId), isNull(positions.archivedAt)));
  }

  /**
   * Pozisyon soft-arşivi (04 §1): işten çıkarılmamış bir ajan bu pozisyondaysa
   * 409-benzeri OrgConflictError; değilse archived_at set edilir ve katalogdaki
   * position.updated {positionId, diff} yayılır.
   */
  async archivePosition(ctx: CompanyContext, positionId: string) {
    return this.db.transaction(async (tx) => {
      await orgLockInTx(tx, ctx);
      const [position] = await tx
        .select()
        .from(positions)
        .where(
          and(
            eq(positions.companyId, ctx.companyId),
            eq(positions.id, positionId),
            isNull(positions.archivedAt),
          ),
        )
        .for("update");
      if (!position) return undefined;
      const [holder] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, ctx.companyId),
            eq(agents.positionId, positionId),
            inArray(agents.status, ["active", "paused", "draft"]),
          ),
        )
        .limit(1);
      if (holder) {
        throw new OrgConflictError(
          "POSITION_IN_USE: bu pozisyonda çalışan ajan var — önce rolünü değiştirin veya işten çıkarın",
        );
      }
      // unvanı serbest bırak (unique kısıt arşivlileri de kapsıyor)
      const [archived] = await tx
        .update(positions)
        .set({
          archivedAt: sql`now()`,
          title: sql`${positions.title} || ' (arşiv ' || substr(${positions.id}::text, 1, 8) || ')'`,
        })
        .where(and(eq(positions.companyId, ctx.companyId), eq(positions.id, positionId)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "position.updated",
        actor: { kind: "founder", id: null },
        payload: {
          positionId,
          diff: { archivedAt: archived!.archivedAt!.toISOString() },
        },
      });
      return archived!;
    });
  }

  // ---------- edges (04 §2, §6) ----------

  /**
   * Creates a typed edge inside one transaction with the per-company advisory
   * lock. reports_to runs the recursive-CTE cycle check and auto-creates the
   * inverse manages edge (04 §6.1).
   */
  async createEdge(
    ctx: CompanyContext,
    input: {
      fromAgentId: string;
      kind: EdgeKind;
      toAgentId?: string | null | undefined;
      toUnitId?: string | null | undefined;
      actorAgentId?: string | null | undefined;
    },
  ) {
    return this.db.transaction(async (tx) => {
      await orgLockInTx(tx, ctx);
      return this.createEdgeInTx(tx, ctx, input);
    });
  }

  /** Caller must hold the org advisory lock (orgLockInTx). */
  async createEdgeInTx(
    tx: Tx,
    ctx: CompanyContext,
    input: {
      fromAgentId: string;
      kind: EdgeKind;
      toAgentId?: string | null | undefined;
      toUnitId?: string | null | undefined;
      actorAgentId?: string | null | undefined;
    },
  ) {
    {

      if (input.kind === "reports_to") {
        await this.assertReportsToAcyclic(tx, ctx, input.fromAgentId, input.toAgentId!);
      }

      const rows: (typeof orgEdges.$inferInsert)[] = [
        {
          companyId: ctx.companyId,
          fromAgentId: input.fromAgentId,
          toAgentId: UNIT_EDGE_KINDS.has(input.kind) ? null : (input.toAgentId ?? null),
          toUnitId: UNIT_EDGE_KINDS.has(input.kind) ? (input.toUnitId ?? null) : null,
          kind: input.kind,
        },
      ];
      if (input.kind === "reports_to") {
        rows.push({
          companyId: ctx.companyId,
          fromAgentId: input.toAgentId!,
          toAgentId: input.fromAgentId,
          toUnitId: null,
          kind: "manages",
        });
      }

      // membership sync (11 §2): member_of joins the unit's channel if any
      if (input.kind === "member_of" && input.toUnitId) {
        const { ChannelService } = await import("@acos/db");
        const { channels } = await import("@acos/db/schema");
        const { eq: eqOp, and: andOp } = await import("drizzle-orm");
        const [channel] = await tx
          .select({ id: channels.id })
          .from(channels)
          .where(
            andOp(eqOp(channels.companyId, ctx.companyId), eqOp(channels.orgUnitId, input.toUnitId)),
          );
        if (channel) {
          await new ChannelService(this.db).addMemberInTx(tx, ctx, channel.id, input.fromAgentId);
        }
      }

      const inserted = await tx.insert(orgEdges).values(rows).returning();
      for (const edge of inserted) {
        await emitDomainEvent(tx, ctx, {
          type: "org.edge.created",
          actor: { kind: input.actorAgentId ? "agent" : "founder", id: input.actorAgentId ?? null },
          agentId: edge.fromAgentId,
          payload: {
            edgeId: edge.id,
            kind: edge.kind,
            fromAgentId: edge.fromAgentId,
            toAgentId: edge.toAgentId ?? undefined,
            toUnitId: edge.toUnitId ?? undefined,
          },
        });
      }
      return inserted[0]!;
    }
  }

  /** 04 §2: walk UP from the proposed manager; reaching the agent = cycle. */
  private async assertReportsToAcyclic(
    tx: Tx,
    ctx: CompanyContext,
    agentId: string,
    newManagerId: string,
  ): Promise<void> {
    if (agentId === newManagerId) {
      throw new OrgCycleError("an agent cannot report to itself");
    }
    const result = await tx.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT e.to_agent_id, 1 AS depth
        FROM org_edges e
        WHERE e.company_id = ${ctx.companyId}
          AND e.from_agent_id = ${newManagerId}
          AND e.kind = 'reports_to' AND e.ended_at IS NULL
        UNION ALL
        SELECT e.to_agent_id, c.depth + 1
        FROM org_edges e
        JOIN chain c ON e.from_agent_id = c.to_agent_id
        WHERE e.company_id = ${ctx.companyId}
          AND e.kind = 'reports_to' AND e.ended_at IS NULL
          AND c.depth < 50
      )
      SELECT 1 AS hit FROM chain WHERE to_agent_id = ${agentId} LIMIT 1
    `);
    if (result.rows.length > 0) {
      throw new OrgCycleError("ORG_EDGE_WOULD_CYCLE: reports_to must stay a forest");
    }
  }

  async endEdge(ctx: CompanyContext, edgeId: string) {
    return this.db.transaction(async (tx) => {
      const [edge] = await tx
        .update(orgEdges)
        .set({ endedAt: sql`now()` })
        .where(
          and(
            eq(orgEdges.companyId, ctx.companyId),
            eq(orgEdges.id, edgeId),
            isNull(orgEdges.endedAt),
          ),
        )
        .returning();
      if (!edge) return undefined;
      await emitDomainEvent(tx, ctx, {
        type: "org.edge.ended",
        actor: { kind: "founder", id: null },
        payload: { edgeId: edge.id, endedAt: edge.endedAt?.toISOString() },
      });
      return edge;
    });
  }

  // ---------- read models (04 §3–4) ----------

  /** Ordered management chain; terminates at the virtual Founder node. */
  async escalationChain(
    ctx: CompanyContext,
    agentId: string,
  ): Promise<Array<{ kind: "agent"; agentId: string; name: string } | { kind: "founder" }>> {
    const result = await this.db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT e.to_agent_id, 1 AS depth
        FROM org_edges e
        WHERE e.company_id = ${ctx.companyId}
          AND e.from_agent_id = ${agentId}
          AND e.kind = 'reports_to' AND e.ended_at IS NULL
        UNION ALL
        SELECT e.to_agent_id, c.depth + 1
        FROM org_edges e
        JOIN chain c ON e.from_agent_id = c.to_agent_id
        WHERE e.company_id = ${ctx.companyId}
          AND e.kind = 'reports_to' AND e.ended_at IS NULL
          AND c.depth < 50
      )
      SELECT chain.to_agent_id AS agent_id, a.name, chain.depth
      FROM chain JOIN agents a ON a.id = chain.to_agent_id
      WHERE a.company_id = ${ctx.companyId}
      ORDER BY chain.depth
    `);
    const hops = result.rows.map((r) => ({
      kind: "agent" as const,
      agentId: String((r as { agent_id: string }).agent_id),
      name: String((r as { name: string }).name),
    }));
    return [...hops, { kind: "founder" as const }];
  }

  /** Team roster (04 §4 SQL, verbatim shape). */
  async teamRoster(ctx: CompanyContext, unitId: string) {
    const result = await this.db.execute(sql`
      SELECT a.id, a.name, a.employee_number, a.seniority, p.title,
             BOOL_OR(l.id IS NOT NULL) AS is_lead
      FROM org_edges m
      JOIN agents a    ON a.id = m.from_agent_id
      JOIN positions p ON p.id = a.position_id
      LEFT JOIN org_edges l ON l.from_agent_id = a.id AND l.to_unit_id = m.to_unit_id
                           AND l.kind = 'leads' AND l.ended_at IS NULL
      WHERE m.company_id = ${ctx.companyId} AND m.to_unit_id = ${unitId}
        AND m.kind = 'member_of' AND m.ended_at IS NULL
        AND a.status = 'active'
      GROUP BY a.id, a.name, a.employee_number, a.seniority, p.title
      ORDER BY is_lead DESC, a.seniority DESC, a.employee_number
    `);
    return result.rows.map((r) => {
      const row = r as {
        id: string;
        name: string;
        employee_number: number;
        seniority: string;
        title: string;
        is_lead: boolean;
      };
      return {
        agentId: row.id,
        name: row.name,
        employeeNumber: Number(row.employee_number),
        seniority: row.seniority,
        title: row.title,
        isLead: Boolean(row.is_lead),
      };
    });
  }

  async listEdges(ctx: CompanyContext) {
    return this.db
      .select()
      .from(orgEdges)
      .where(and(eq(orgEdges.companyId, ctx.companyId), isNull(orgEdges.endedAt)));
  }
}
