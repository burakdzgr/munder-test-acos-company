// Company root repository — companies IS the tenant boundary, so this
// operates above CompanyContext (used by platform modules and seed).
import { eq } from "drizzle-orm";
import { companies, companySettings } from "../schema/companies.js";
import type { Db } from "../index.js";
import type { Tx } from "../outbox.js";

export type CompanyRow = typeof companies.$inferSelect;

export class CompanyRepository {
  constructor(private readonly db: Db) {}

  async insert(tx: Tx, row: typeof companies.$inferInsert): Promise<CompanyRow> {
    const [inserted] = await tx.insert(companies).values(row).returning();
    await tx.insert(companySettings).values({ companyId: inserted!.id });
    return inserted!;
  }

  async findBySlug(slug: string): Promise<CompanyRow | undefined> {
    const [row] = await this.db.select().from(companies).where(eq(companies.slug, slug));
    return row;
  }
}
