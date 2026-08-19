// Agent aggregate repository — every method is CompanyContext-scoped (S4).
import { and, eq } from "drizzle-orm";
import { agents } from "../schema/agents.js";
import type { GuardedDb } from "../tenant.js";
import type { CompanyContext } from "../context.js";
import type { Tx } from "../outbox.js";

export type AgentRow = typeof agents.$inferSelect;
export type NewAgentRow = Omit<typeof agents.$inferInsert, "companyId">;

export class AgentRepository {
  constructor(
    private readonly db: GuardedDb,
    private readonly ctx: CompanyContext,
  ) {}

  async insert(tx: Tx, row: NewAgentRow): Promise<AgentRow> {
    const [inserted] = await tx
      .insert(agents)
      .values({ ...row, companyId: this.ctx.companyId })
      .returning();
    return inserted!;
  }

  async findById(id: string): Promise<AgentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, this.ctx.companyId), eq(agents.id, id)));
    return row;
  }

  async list(): Promise<AgentRow[]> {
    return this.db.select().from(agents).where(eq(agents.companyId, this.ctx.companyId));
  }

  async updateStatus(tx: Tx, id: string, status: AgentRow["status"]): Promise<void> {
    await tx
      .update(agents)
      .set({ status })
      .where(and(eq(agents.companyId, this.ctx.companyId), eq(agents.id, id)));
  }
}
