// Preview Gateway (REVISION TASK 3): Founder, sandbox içinde çalışan web
// uygulamasını tarayıcıda açar. Port keşfi sandbox-manager'dan (proc/net/tcp),
// istekler server → sandbox-manager → workspace container zinciriyle proxy'lenir.
//
// Mutlak yollar (/assets, /_next, …) için çerez tabanlı fallback: preview
// kökü açıldığında `acos_preview=<workspaceId>:<port>` çerezi yazılır ve
// app.ts'in 404 handler'ı bilinmeyen yolları bu hedefe proxy'ler — server
// origin'inde SPA olmadığı için çakışma yoktur.
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { and, eq } from "drizzle-orm";
import { companyContext, type GuardedDb } from "@acos/db";
import { workspaces } from "@acos/db/schema";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";

export interface PreviewRoutesDeps {
  guardedDb: () => GuardedDb;
  companiesSvc: () => CompanyService;
  sandbox: () => { url: string; token: string } | null;
  /** Tarayıcının server'a ulaştığı origin (preview linkleri için). */
  publicServerUrl: string;
}

const PREVIEW_COOKIE = "acos_preview";

const PortsParamsSchema = z.object({ companyId: z.uuid(), workspaceId: z.uuid() });

export interface PreviewFallback {
  (request: FastifyRequest, reply: FastifyReply): Promise<boolean>;
}

export async function registerPreviewRoutes(
  app: FastifyInstance,
  deps: PreviewRoutesDeps,
): Promise<PreviewFallback> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  function requireSandbox() {
    const sandbox = deps.sandbox();
    if (!sandbox) throw new ApiError("internal", "sandbox-manager not wired");
    return sandbox;
  }

  /** workspace → şirket üyeliği (founder/admin) doğrulaması (S4: sorgu
   *  company_id şartı taşır, bu yüzden companyId URL'de gelir). */
  async function requireWorkspaceAccess(
    userId: string,
    companyId: string,
    workspaceId: string,
  ): Promise<void> {
    const role = await deps.companiesSvc().membership(userId, companyId);
    if (!role) throw new ApiError("not_found", "workspace not found");
    if (role !== "founder" && role !== "admin") {
      throw new ApiError("forbidden", "preview requires founder/admin");
    }
    const ctx = companyContext(companyId);
    const db = deps.guardedDb();
    const [row] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.companyId, ctx.companyId), eq(workspaces.id, workspaceId)))
      .limit(1);
    if (!row) throw new ApiError("not_found", "workspace not found");
  }

  /** Sandbox-manager preview ucuna tek isteği proxy'ler ve yanıtı yazar. */
  async function proxyPreview(
    request: FastifyRequest,
    reply: FastifyReply,
    companyId: string,
    workspaceId: string,
    port: number,
    restPath: string,
  ): Promise<void> {
    const sandbox = requireSandbox();
    const qsIndex = request.raw.url?.indexOf("?") ?? -1;
    const qs = qsIndex >= 0 ? request.raw.url!.slice(qsIndex) : "";
    const target = `${sandbox.url}/internal/v1/workspaces/${workspaceId}/preview/${port}/${restPath}${qs}`;
    const headers: Record<string, string> = { authorization: `Bearer ${sandbox.token}` };
    for (const [key, value] of Object.entries(request.headers)) {
      if (typeof value !== "string") continue;
      if (["host", "connection", "authorization", "content-length", "cookie"].includes(key))
        continue;
      headers[key] = value;
    }
    const method = request.method.toUpperCase();
    const hasBody = !["GET", "HEAD"].includes(method);
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method,
        headers,
        ...(hasBody &&
          ({ body: request.raw as unknown as RequestInit["body"], duplex: "half" } as RequestInit)),
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      void reply
        .status(502)
        .send({ code: "bad_gateway", message: `preview unreachable: ${String(err)}` });
      return;
    }
    void reply.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (["transfer-encoding", "connection", "content-encoding", "content-length"].includes(key))
        return;
      void reply.header(key, value);
    });
    const contentType = upstream.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      // mutlak yollu asset istekleri için hedefi hatırla (404 fallback)
      void reply.setCookie(PREVIEW_COOKIE, `${companyId}:${workspaceId}:${port}`, {
        path: "/",
        sameSite: "lax",
      });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    void reply.send(buf);
  }

  // Keşfedilen portlar + hazır preview linkleri
  typed.get(
    "/api/v1/companies/:companyId/workspaces/:workspaceId/ports",
    { schema: { params: PortsParamsSchema, tags: ["preview"], hide: true } },
    async (request) => {
      const user = request.requireUser();
      const { companyId, workspaceId } = request.params;
      await requireWorkspaceAccess(user.id, companyId, workspaceId);
      const sandbox = requireSandbox();
      const res = await fetch(`${sandbox.url}/internal/v1/workspaces/${workspaceId}/ports`, {
        headers: { authorization: `Bearer ${sandbox.token}` },
      });
      if (!res.ok) throw new ApiError("internal", `port discovery failed (${res.status})`);
      const body = (await res.json()) as { ports: number[] };
      return {
        workspaceId,
        ports: body.ports.map((port) => ({
          port,
          previewUrl: `${deps.publicServerUrl}/preview/${companyId}/${workspaceId}/${port}/`,
        })),
      };
    },
  );

  // Preview proxy — tarayıcı doğrudan bu yolu açar (session çerezi host bazlı
  // olduğundan SPA oturumu burada da geçerlidir)
  app.all("/preview/:companyId/:workspaceId/:port/*", async (request, reply) => {
    const params = request.params as {
      companyId: string;
      workspaceId: string;
      port: string;
      "*": string;
    };
    const user = request.requireUser();
    await requireWorkspaceAccess(user.id, params.companyId, params.workspaceId);
    const port = Number.parseInt(params.port, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ApiError("validation_failed", "bad port");
    }
    await proxyPreview(request, reply, params.companyId, params.workspaceId, port, params["*"] ?? "");
  });

  app.all("/preview/:companyId/:workspaceId/:port", async (request, reply) => {
    const params = request.params as { companyId: string; workspaceId: string; port: string };
    void reply.redirect(
      `/preview/${params.companyId}/${params.workspaceId}/${params.port}/`,
      302,
    );
  });

  // 404 fallback: mutlak yollu istekler (örn /_next/…) çereze göre proxy'lenir
  return async (request, reply) => {
    const cookie = request.cookies?.[PREVIEW_COOKIE];
    if (!cookie) return false;
    const url = request.raw.url ?? "/";
    if (
      url.startsWith("/api/") ||
      url.startsWith("/ws") ||
      url.startsWith("/preview/") ||
      url.startsWith("/healthz")
    ) {
      return false;
    }
    const [companyId, workspaceId, portRaw] = cookie.split(":");
    const port = Number.parseInt(portRaw ?? "", 10);
    if (!companyId || !workspaceId || !Number.isInteger(port)) return false;
    try {
      const user = request.requireUser();
      await requireWorkspaceAccess(user.id, companyId, workspaceId);
    } catch {
      return false; // oturum yoksa normal 404 akışı sürsün
    }
    const path = url.startsWith("/") ? url.slice(1) : url;
    const pathOnly = path.split("?")[0]!;
    await proxyPreview(request, reply, companyId, workspaceId, port, pathOnly);
    return true;
  };
}
