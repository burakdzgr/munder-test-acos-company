// CodeIndex REST yüzeyi (REVISION TASK 4): rebuild + özet. Founder/admin.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { companyContext, CodeIndexService, type GuardedDb } from "@acos/db";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";
import { rebuildCodeIndex, updateTaskOverlayIndex } from "./service.js";
import { queryCodeIndex } from "./query.js";

export interface CodeIndexRoutesDeps {
  guardedDb: () => GuardedDb;
  companiesSvc: () => CompanyService;
  sandbox: () => { url: string; token: string } | null;
  /** /internal/v1/code-index/* için paylaşılan bearer (18 §2). */
  internalApiToken?: () => string;
}

const ParamsSchema = z.object({ companyId: z.uuid(), projectId: z.uuid() });

export async function registerCodeIndexRoutes(
  app: FastifyInstance,
  deps: CodeIndexRoutesDeps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  async function requireAdmin(userId: string, companyId: string): Promise<void> {
    const role = await deps.companiesSvc().membership(userId, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
    if (role !== "founder" && role !== "admin") {
      throw new ApiError("forbidden", "code index requires founder/admin");
    }
  }

  typed.post(
    "/api/v1/companies/:companyId/projects/:projectId/code-index/rebuild",
    { schema: { params: ParamsSchema, tags: ["code-index"], hide: true } },
    async (request) => {
      const user = request.requireUser();
      const { companyId, projectId } = request.params;
      await requireAdmin(user.id, companyId);
      const sandbox = deps.sandbox();
      if (!sandbox) throw new ApiError("internal", "sandbox-manager not wired");
      return rebuildCodeIndex({ guardedDb: deps.guardedDb(), sandbox }, companyId, projectId);
    },
  );

  // TASK 3: intake workflow'unun senkron indeks kapısı — READY bu çağrı
  // bitmeden verilmez (INVARIANT 2). Internal bearer ile korunur.
  typed.post(
    "/internal/v1/code-index/rebuild",
    {
      schema: {
        body: z.object({ companyId: z.uuid(), projectId: z.uuid() }),
        tags: ["code-index"],
        hide: true,
      },
    },
    async (request, reply) => {
      const token = deps.internalApiToken?.();
      const header = request.headers.authorization;
      if (!token || header !== `Bearer ${token}`) {
        return reply
          .status(401)
          .send({ code: "unauthenticated", message: "internal token required" });
      }
      const sandbox = deps.sandbox();
      if (!sandbox) throw new ApiError("internal", "sandbox-manager not wired");
      return rebuildCodeIndex(
        { guardedDb: deps.guardedDb(), sandbox },
        request.body.companyId,
        request.body.projectId,
      );
    },
  );

  // TASK 5: görev overlay indeksini tazele (context compiler / dispatch çağırır)
  typed.post(
    "/internal/v1/code-index/overlay",
    {
      schema: {
        body: z.object({ companyId: z.uuid(), projectId: z.uuid(), taskId: z.uuid() }),
        tags: ["code-index"],
        hide: true,
      },
    },
    async (request, reply) => {
      const token = deps.internalApiToken?.();
      if (!token || request.headers.authorization !== `Bearer ${token}`) {
        return reply
          .status(401)
          .send({ code: "unauthenticated", message: "internal token required" });
      }
      const sandbox = deps.sandbox();
      if (!sandbox) throw new ApiError("internal", "sandbox-manager not wired");
      const result = await updateTaskOverlayIndex(
        { guardedDb: deps.guardedDb(), sandbox },
        request.body.companyId,
        request.body.projectId,
        request.body.taskId,
      );
      return result ?? { overlayRef: null, filesIndexed: 0, deleted: 0, head: null };
    },
  );

  // TASK 13: Context Compiler sorgusu — canonical + task overlay birlikte
  typed.post(
    "/internal/v1/code-index/query",
    {
      schema: {
        body: z.object({
          companyId: z.uuid(),
          projectId: z.uuid(),
          taskId: z.uuid().optional(),
          terms: z.array(z.string().max(80)).max(16),
          limit: z.number().int().min(1).max(30).optional(),
        }),
        tags: ["code-index"],
        hide: true,
      },
    },
    async (request, reply) => {
      const token = deps.internalApiToken?.();
      if (!token || request.headers.authorization !== `Bearer ${token}`) {
        return reply
          .status(401)
          .send({ code: "unauthenticated", message: "internal token required" });
      }
      const sandbox = deps.sandbox();
      if (!sandbox) throw new ApiError("internal", "sandbox-manager not wired");
      return queryCodeIndex({ guardedDb: deps.guardedDb(), sandbox }, request.body);
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/projects/:projectId/code-index",
    { schema: { params: ParamsSchema, tags: ["code-index"], hide: true } },
    async (request) => {
      const user = request.requireUser();
      const { companyId, projectId } = request.params;
      await requireAdmin(user.id, companyId);
      const service = new CodeIndexService(deps.guardedDb());
      return service.summary(companyContext(companyId), projectId);
    },
  );
}
