// Task aggregate repository — CompanyContext-scoped (S4). Status transitions
// go through TaskStateService (T27); this exposes storage only.
import { and, eq } from "drizzle-orm";
import { tasks } from "../schema/tasks.js";
import type { GuardedDb } from "../tenant.js";
import type { CompanyContext } from "../context.js";
import type { Tx } from "../outbox.js";

export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = Omit<typeof tasks.$inferInsert, "companyId">;

export class TaskRepository {
  constructor(
    private readonly db: GuardedDb,
    private readonly ctx: CompanyContext,
  ) {}

  async insert(tx: Tx, row: NewTaskRow): Promise<TaskRow> {
    const [inserted] = await tx
      .insert(tasks)
      .values({ ...row, companyId: this.ctx.companyId })
      .returning();
    return inserted!;
  }

  async findById(id: string): Promise<TaskRow | undefined> {
    const [row] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, this.ctx.companyId), eq(tasks.id, id)));
    return row;
  }

  async list(): Promise<TaskRow[]> {
    return this.db.select().from(tasks).where(eq(tasks.companyId, this.ctx.companyId));
  }
}
