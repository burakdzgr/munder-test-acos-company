// Companies module service (20 §3, T17): create/list/settings with the
// company.created / company.settings.updated events emitted via the outbox in
// the SAME transaction as the state change.
import { and, eq, isNull } from "drizzle-orm";
import {
  companyContext,
  seedPromotionPolicies,
  type CompanyContext,
  type GuardedDb,
} from "@acos/db";
import { companies, companyMembers, companySettings } from "@acos/db/schema";
import { emitDomainEvent } from "../events/emit.js";

export type CompanyRow = typeof companies.$inferSelect;
export type CompanySettingsRow = typeof companySettings.$inferSelect;
export type MemberRole = "founder" | "admin" | "viewer";

export class CompanyService {
  constructor(private readonly db: GuardedDb) {}

  async create(input: {
    name: string;
    slug: string;
    currency: string;
    createdByUserId: string;
  }): Promise<CompanyRow> {
    return this.db.transaction(async (tx) => {
      const [company] = await tx
        .insert(companies)
        .values({
          name: input.name,
          slug: input.slug,
          currency: input.currency,
          createdByUserId: input.createdByUserId,
        })
        .returning();
      const ctx = companyContext(company!.id);
      await tx.insert(companySettings).values({ companyId: company!.id });
      await tx.insert(companyMembers).values({
        companyId: company!.id,
        userId: input.createdByUserId,
        role: "founder",
      });
      // binding memory-promotion defaults (12 §6.2, T46) — tenant-editable rows
      await seedPromotionPolicies(tx, ctx);
      await emitDomainEvent(tx, ctx, {
        type: "company.created",
        actor: { kind: "founder", id: null },
        payload: { name: input.name, currency: input.currency },
      });
      await emitDomainEvent(tx, ctx, {
        type: "company.member.added",
        actor: { kind: "founder", id: null },
        payload: { userId: input.createdByUserId, role: "founder" },
      });
      return company!;
    });
  }

  async listForUser(userId: string): Promise<Array<CompanyRow & { role: MemberRole }>> {
    const rows = await this.db
      .select({ company: companies, role: companyMembers.role })
      .from(companyMembers)
      .innerJoin(companies, eq(companyMembers.companyId, companies.id))
      .where(and(eq(companyMembers.userId, userId), isNull(companyMembers.removedAt)));
    return rows.map((r) => ({ ...r.company, role: r.role as MemberRole }));
  }

  /** 21 §2.3: membership (role ≥ viewer) or null — callers 404, never 403. */
  async membership(userId: string, companyId: string): Promise<MemberRole | null> {
    const [row] = await this.db
      .select({ role: companyMembers.role })
      .from(companyMembers)
      .where(
        and(
          eq(companyMembers.companyId, companyId),
          eq(companyMembers.userId, userId),
          isNull(companyMembers.removedAt),
        ),
      );
    return (row?.role as MemberRole | undefined) ?? null;
  }

  async getSettings(ctx: CompanyContext): Promise<CompanySettingsRow | undefined> {
    const [row] = await this.db
      .select()
      .from(companySettings)
      .where(eq(companySettings.companyId, ctx.companyId));
    return row;
  }

  async updateSettings(
    ctx: CompanyContext,
    patch: {
      [K in
        | "outputLanguage"
        | "timezone"
        | "defaultAutonomyLevel"
        | "dailySpendLimitCents"
        | "consolidationEventThreshold"
        | "memoryTokenBudgetAgent"
        | "memoryTokenBudgetProject"
        | "memoryTokenBudgetCompany"
        | "terminalLogRetentionDays"]?: CompanySettingsRow[K] | undefined;
    },
  ): Promise<CompanySettingsRow> {
    const cleaned = Object.fromEntries(
      Object.entries(patch).filter(([, v]) => v !== undefined),
    );
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(companySettings)
        .set(cleaned)
        .where(eq(companySettings.companyId, ctx.companyId))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "company.settings.updated",
        actor: { kind: "founder", id: null },
        payload: { diff: cleaned },
      });
      return updated!;
    });
  }
}
