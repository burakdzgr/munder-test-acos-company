// GitHub bağlantı yüzeyi (2026-08-18): Founder PAT'ini bağlar/koparır,
// projeyi elle yayınlar. Yalnız founder/admin — PAT şirketin en yetkili
// sırrıdır. Token asla cevaplara yazılmaz; GET yalnız {connected, owner}.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { companyContext, type GuardedDb } from "@acos/db";
import { ApiError } from "../../app.js";
import { GithubError, GithubService, publishProjectToGithub } from "./github.js";

export interface IntegrationRoutesDeps {
  guardedDb: () => GuardedDb;
  membership: (userId: string, companyId: string) => Promise<string | null>;
  masterKey: string | undefined;
  sandbox: () => { url: string; token: string } | null;
  internalApiToken?: () => string;
}

const ParamsSchema = z.object({ companyId: z.uuid() });
const ProjectParamsSchema = z.object({ companyId: z.uuid(), projectId: z.uuid() });

export async function registerIntegrationRoutes(
  app: FastifyInstance,
  deps: IntegrationRoutesDeps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  async function requireAdmin(userId: string, companyId: string): Promise<void> {
    const role = await deps.membership(userId, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
    if (role !== "founder" && role !== "admin") {
      throw new ApiError("forbidden", "github bağlantısı founder/admin ister");
    }
  }

  function svc(): GithubService {
    return new GithubService(deps.guardedDb(), deps.masterKey);
  }

  typed.get(
    "/api/v1/companies/:companyId/settings/github",
    {
      schema: {
        params: ParamsSchema,
        response: {
          200: z.object({ connected: z.boolean(), owner: z.string().nullable() }),
        },
        tags: ["companies"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      await requireAdmin(user.id, request.params.companyId);
      return svc().status(companyContext(request.params.companyId));
    },
  );

  // TASK 7: bağlantı listesi — proje formundaki "GitHub connection" seçimi
  typed.get(
    "/api/v1/companies/:companyId/github/connections",
    {
      schema: {
        params: ParamsSchema,
        response: {
          200: z.array(
            z.object({
              id: z.uuid(),
              owner: z.string(),
              scopes: z.array(z.string()),
              status: z.string(),
              lastValidatedAt: z.string().nullable(),
            }),
          ),
        },
        tags: ["companies"],
        hide: true,
      },
    },
    async (request) => {
      const user = request.requireUser();
      await requireAdmin(user.id, request.params.companyId);
      return svc().listConnections(companyContext(request.params.companyId));
    },
  );

  // TASK 6: internal publish — intake (greenfield) ve tool gateway'in ortak
  // sunucu-tarafı yolu; credential yalnız burada çözülür.
  typed.post(
    "/internal/v1/github/publish",
    {
      schema: {
        body: z.object({ companyId: z.uuid(), projectId: z.uuid() }),
        tags: ["companies"],
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
      if (!sandbox) throw new ApiError("internal", "sandbox not wired");
      const { publishProjectToGithub } = await import("./github.js");
      return publishProjectToGithub({
        db: deps.guardedDb(),
        masterKey: deps.masterKey,
        sandbox,
        companyId: request.body.companyId,
        projectId: request.body.projectId,
      });
    },
  );

  typed.put(
    "/api/v1/companies/:companyId/settings/github",
    {
      schema: {
        params: ParamsSchema,
        body: z.object({ token: z.string().min(20).max(400) }),
        response: {
          200: z.object({ connected: z.boolean(), owner: z.string().nullable() }),
        },
        tags: ["companies"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      await requireAdmin(user.id, request.params.companyId);
      try {
        return await svc().connect(
          companyContext(request.params.companyId),
          request.body.token,
          user.id,
        );
      } catch (err) {
        if (err instanceof GithubError && err.code === "TOKEN_INVALID") {
          throw new ApiError("validation_failed", err.message);
        }
        throw err;
      }
    },
  );

  typed.delete(
    "/api/v1/companies/:companyId/settings/github",
    {
      schema: { params: ParamsSchema, response: { 204: z.null() }, tags: ["companies"] },
    },
    async (request, reply) => {
      const user = request.requireUser();
      await requireAdmin(user.id, request.params.companyId);
      await svc().disconnect(companyContext(request.params.companyId));
      return reply.status(204).send(null);
    },
  );

  // Elle yayın: repo yoksa GitHub'da açar, iç bare repo'yu iter.
  typed.post(
    "/api/v1/companies/:companyId/projects/:projectId/github/publish",
    {
      schema: {
        params: ProjectParamsSchema,
        response: {
          200: z.object({ published: z.boolean(), remoteUrl: z.string().nullable() }),
        },
        tags: ["projects"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      await requireAdmin(user.id, request.params.companyId);
      const sandbox = deps.sandbox();
      if (!sandbox) throw new ApiError("internal", "sandbox-manager not wired");
      return publishProjectToGithub({
        db: deps.guardedDb(),
        masterKey: deps.masterKey,
        sandbox,
        companyId: request.params.companyId,
        projectId: request.params.projectId,
      });
    },
  );
}
