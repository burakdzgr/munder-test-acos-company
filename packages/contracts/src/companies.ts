// Companies & settings schemas (20 §3, 21 §2.3).
import { z } from "zod";

export const CompanySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  currency: z.string().length(3),
  status: z.enum(["active", "archived"]),
  role: z.enum(["founder", "admin", "viewer"]),
  createdAt: z.iso.datetime(),
});
export type Company = z.infer<typeof CompanySchema>;

export const CreateCompanyRequestSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  currency: z.string().length(3).default("USD"),
});

export const CompanySettingsSchema = z.object({
  outputLanguage: z.string(),
  timezone: z.string(),
  defaultAutonomyLevel: z.number().int().min(0).max(5),
  dailySpendLimitCents: z.number().int().nullable(),
  consolidationEventThreshold: z.number().int(),
  memoryTokenBudgetAgent: z.number().int(),
  memoryTokenBudgetProject: z.number().int(),
  memoryTokenBudgetCompany: z.number().int(),
  terminalLogRetentionDays: z.number().int(),
});
export type CompanySettings = z.infer<typeof CompanySettingsSchema>;

export const UpdateCompanySettingsRequestSchema = CompanySettingsSchema.partial();
