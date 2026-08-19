// Companies routes (T17): CRUD + settings with X-Company-Id scoping (21 §2.3).
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  CompanySchema,
  CompanySettingsSchema,
  CreateCompanyRequestSchema,
  UpdateCompanySettingsRequestSchema,
} from "@acos/contracts";
import { companyContext } from "@acos/db";
import { ApiError } from "../../app.js";
import type { CompanyService, CompanySettingsRow, MemberRole } from "./service.js";

function toApiCompany(company: {
  id: string;
  name: string;
  slug: string;
  currency: string;
  status: string;
  createdAt: Date;
}, role: MemberRole) {
  return {
    id: company.id,
    name: company.name,
    slug: company.slug,
    currency: company.currency,
    status: company.status as "active" | "archived",
    role,
    createdAt: company.createdAt.toISOString(),
  };
}

function toApiSettings(row: CompanySettingsRow) {
  return {
    outputLanguage: row.outputLanguage,
    timezone: row.timezone,
    defaultAutonomyLevel: row.defaultAutonomyLevel,
    dailySpendLimitCents: row.dailySpendLimitCents,
    consolidationEventThreshold: row.consolidationEventThreshold,
    memoryTokenBudgetAgent: row.memoryTokenBudgetAgent,
    memoryTokenBudgetProject: row.memoryTokenBudgetProject,
    memoryTokenBudgetCompany: row.memoryTokenBudgetCompany,
    terminalLogRetentionDays: row.terminalLogRetentionDays,
  };
}

export async function registerCompanyRoutes(
  rawApp: FastifyInstance,
  companiesService: () => CompanyService,
  guardedDb?: () => import("@acos/db").GuardedDb,
) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  /** Mismatch returns 404, never 403 — no existence leaks (21 §2.3). */
  async function requireMembership(
    request: FastifyRequest,
    companyId: string,
  ): Promise<MemberRole> {
    const user = request.requireUser();
    const role = await companiesService().membership(user.id, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
    return role;
  }

  app.get(
    "/api/v1/companies",
    {
      schema: {
        operationId: "listCompanies",
        tags: ["companies"],
        response: { 200: z.array(CompanySchema) },
      },
    },
    async (request) => {
      const user = request.requireUser();
      const rows = await companiesService().listForUser(user.id);
      return rows.map((r) => toApiCompany(r, r.role));
    },
  );

  app.post(
    "/api/v1/companies",
    {
      schema: {
        operationId: "createCompany",
        tags: ["companies"],
        body: CreateCompanyRequestSchema,
        response: { 201: CompanySchema },
      },
    },
    async (request, reply) => {
      const user = request.requireUser();
      try {
        const company = await companiesService().create({
          ...request.body,
          createdByUserId: user.id,
        });
        // Yeni şirket çalışır doğar (2026-08-19): LLM zinciri + bütçe +
        // arama kimliği — commit sonrası, best-effort ve idempotent.
        try {
          if (guardedDb) {
            const { provisionCompanyDefaults } = await import("../../seed.js");
            await provisionCompanyDefaults(guardedDb(), {
              companyId: company.id,
              founderUserId: user.id,
            });
          }
        } catch (err) {
          request.log.warn({ err, companyId: company.id }, "company defaults provisioning failed");
        }
        return reply.status(201).send(toApiCompany(company, "founder"));
      } catch (err) {
        const root = (err as { cause?: unknown }).cause ?? err;
        const pg = root as { code?: string; constraint?: string };
        if (pg.code === "23505" && pg.constraint === "companies_slug_uq") {
          throw new ApiError("conflict", `slug "${request.body.slug}" is taken`);
        }
        throw err;
      }
    },
  );

  app.get(
    "/api/v1/companies/:id",
    {
      schema: {
        operationId: "getCompany",
        tags: ["companies"],
        params: z.object({ id: z.uuid() }),
        response: { 200: CompanySchema },
      },
    },
    async (request) => {
      const role = await requireMembership(request, request.params.id);
      const rows = await companiesService().listForUser(request.requireUser().id);
      const company = rows.find((r) => r.id === request.params.id);
      if (!company) throw new ApiError("not_found", "company not found");
      return toApiCompany(company, role);
    },
  );

  app.get(
    "/api/v1/companies/:id/settings",
    {
      schema: {
        operationId: "getCompanySettings",
        tags: ["companies"],
        params: z.object({ id: z.uuid() }),
        response: { 200: CompanySettingsSchema },
      },
    },
    async (request) => {
      await requireMembership(request, request.params.id);
      const settings = await companiesService().getSettings(companyContext(request.params.id));
      if (!settings) throw new ApiError("not_found", "settings not found");
      return toApiSettings(settings);
    },
  );

  app.patch(
    "/api/v1/companies/:id/settings",
    {
      schema: {
        operationId: "updateCompanySettings",
        tags: ["companies"],
        params: z.object({ id: z.uuid() }),
        body: UpdateCompanySettingsRequestSchema,
        response: { 200: CompanySettingsSchema },
      },
    },
    async (request) => {
      const role = await requireMembership(request, request.params.id);
      if (role === "viewer") throw new ApiError("forbidden", "viewers cannot edit settings");
      const updated = await companiesService().updateSettings(
        companyContext(request.params.id),
        request.body,
      );
      return toApiSettings(updated);
    },
  );
}
