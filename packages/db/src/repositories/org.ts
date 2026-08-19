// Org aggregate repository (units, positions, edges) — CompanyContext-scoped.
import { and, eq, isNull } from "drizzle-orm";
import { orgUnits, positions } from "../schema/org.js";
import { orgEdges } from "../schema/agents.js";
import type { GuardedDb } from "../tenant.js";
import type { CompanyContext } from "../context.js";
import type { Tx } from "../outbox.js";

export type OrgUnitRow = typeof orgUnits.$inferSelect;
export type PositionRow = typeof positions.$inferSelect;
export type OrgEdgeRow = typeof orgEdges.$inferSelect;

export class OrgRepository {
  constructor(
    private readonly db: GuardedDb,
    private readonly ctx: CompanyContext,
  ) {}

  async insertUnit(tx: Tx, row: Omit<typeof orgUnits.$inferInsert, "companyId">): Promise<OrgUnitRow> {
    const [inserted] = await tx
      .insert(orgUnits)
      .values({ ...row, companyId: this.ctx.companyId })
      .returning();
    return inserted!;
  }

  async insertPosition(
    tx: Tx,
    row: Omit<typeof positions.$inferInsert, "companyId">,
  ): Promise<PositionRow> {
    const [inserted] = await tx
      .insert(positions)
      .values({ ...row, companyId: this.ctx.companyId })
      .returning();
    return inserted!;
  }

  async insertEdge(tx: Tx, row: Omit<typeof orgEdges.$inferInsert, "companyId">): Promise<OrgEdgeRow> {
    const [inserted] = await tx
      .insert(orgEdges)
      .values({ ...row, companyId: this.ctx.companyId })
      .returning();
    return inserted!;
  }

  /** Active reports_to edges — input for the domain forest/cycle checks. */
  async activeReportsToEdges(): Promise<OrgEdgeRow[]> {
    return this.db
      .select()
      .from(orgEdges)
      .where(
        and(
          eq(orgEdges.companyId, this.ctx.companyId),
          eq(orgEdges.kind, "reports_to"),
          isNull(orgEdges.endedAt),
        ),
      );
  }

  async listUnits(): Promise<OrgUnitRow[]> {
    return this.db.select().from(orgUnits).where(eq(orgUnits.companyId, this.ctx.companyId));
  }
}
