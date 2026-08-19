// Terminals REST surface (24 §6.9, T41): the session list for the Terminals
// view + the full-scrollback download (proxied from sandbox-manager's rolling
// log). Founder/admin only — the route guard mirrors the WS topic authz
// (22 §8): live frames are the most privileged stream in the product.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { and, desc, eq } from "drizzle-orm";
import {
  TerminalListQuerySchema,
  TerminalListResponseSchema,
  TerminalSessionDtoSchema,
} from "@acos/contracts";
import { companyContext, type GuardedDb } from "@acos/db";
import { agents, tasks, terminalSessions, workspaces } from "@acos/db/schema";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";

export interface TerminalRoutesDeps {
  guardedDb: () => GuardedDb;
  companiesSvc: () => CompanyService;
  /** sandbox-manager internal API — log download proxy (null until wired). */
  sandbox: () => { url: string; token: string } | null;
}

const ParamsSchema = z.object({ companyId: z.uuid() });
const SessionParamsSchema = z.object({ companyId: z.uuid(), sessionId: z.uuid() });

/**
 * REVISION TASK 2 — agent_control ↔ human_control. In-memory per-session
 * holder; default agent_control. Founder must take control before writing
 * into the PTY, and returns it when done. Server restart falls back to
 * agent_control — the safe default.
 */
const controlHolders = new Map<string, "agent" | "human">();
export function terminalControlHolder(sessionId: string): "agent" | "human" {
  return controlHolders.get(sessionId) ?? "agent";
}

export async function registerTerminalRoutes(
  app: FastifyInstance,
  deps: TerminalRoutesDeps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  /** Membership + founder/admin gate (mirrors the WS topic rule). */
  async function requireAdmin(userId: string, companyId: string): Promise<void> {
    const role = await deps.companiesSvc().membership(userId, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
    if (role !== "founder" && role !== "admin") {
      throw new ApiError("forbidden", "terminals require founder/admin");
    }
  }

  typed.get(
    "/api/v1/companies/:companyId/terminals",
    {
      schema: {
        params: ParamsSchema,
        querystring: TerminalListQuerySchema,
        response: { 200: TerminalListResponseSchema },
        tags: ["terminals"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      await requireAdmin(user.id, companyId);
      const ctx = companyContext(companyId);
      const db = deps.guardedDb();

      const rows = await db
        .select({
          session: terminalSessions,
          agentName: agents.name,
          taskId: workspaces.taskId,
          taskNumber: tasks.number,
          branch: workspaces.branch,
          isolationLevel: workspaces.isolationLevel,
          workspaceStatus: workspaces.status,
        })
        .from(terminalSessions)
        .innerJoin(workspaces, eq(terminalSessions.workspaceId, workspaces.id))
        .leftJoin(agents, eq(terminalSessions.agentId, agents.id))
        .leftJoin(tasks, eq(workspaces.taskId, tasks.id))
        .where(
          and(
            eq(terminalSessions.companyId, ctx.companyId),
            ...(request.query.status ? [eq(terminalSessions.status, request.query.status)] : []),
          ),
        )
        .orderBy(desc(terminalSessions.createdAt))
        .limit(request.query.limit);

      return {
        items: rows.map((r) =>
          TerminalSessionDtoSchema.parse({
            id: r.session.id,
            workspaceId: r.session.workspaceId,
            agentId: r.session.agentId,
            agentName: r.agentName,
            title: r.session.title,
            status: r.session.status,
            cols: r.session.cols,
            rows: r.session.rows,
            createdAt: r.session.createdAt.toISOString(),
            closedAt: r.session.closedAt?.toISOString() ?? null,
            taskId: r.taskId,
            taskNumber: r.taskNumber,
            branch: r.branch,
            isolationLevel: r.isolationLevel,
            workspaceStatus: r.workspaceStatus,
          }),
        ),
      };
    },
  );

  // --- Interactive shell (REVISION TASK 2) ---

  /** Session row lookup shared by the shell routes. */
  async function requireSession(companyId: string, sessionId: string) {
    const ctx = companyContext(companyId);
    const db = deps.guardedDb();
    const [row] = await db
      .select({ id: terminalSessions.id, workspaceId: terminalSessions.workspaceId })
      .from(terminalSessions)
      .where(and(eq(terminalSessions.companyId, ctx.companyId), eq(terminalSessions.id, sessionId)))
      .limit(1);
    if (!row) throw new ApiError("not_found", "terminal session not found");
    return row;
  }

  function requireSandbox() {
    const sandbox = deps.sandbox();
    if (!sandbox) throw new ApiError("internal", "sandbox-manager not wired");
    return sandbox;
  }

  async function sandboxPost(path: string, body: unknown): Promise<Response> {
    const sandbox = requireSandbox();
    return fetch(`${sandbox.url}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${sandbox.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  // takeover / return-control
  typed.post(
    "/api/v1/companies/:companyId/terminals/:sessionId/control",
    {
      schema: {
        params: SessionParamsSchema,
        body: z.object({ holder: z.enum(["agent", "human"]) }),
        tags: ["terminals"],
        hide: true,
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, sessionId } = request.params;
      await requireAdmin(user.id, companyId);
      await requireSession(companyId, sessionId);
      controlHolders.set(sessionId, request.body.holder);
      return { sessionId, holder: request.body.holder };
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/terminals/:sessionId/control",
    { schema: { params: SessionParamsSchema, tags: ["terminals"], hide: true } },
    async (request) => {
      const user = request.requireUser();
      const { companyId, sessionId } = request.params;
      await requireAdmin(user.id, companyId);
      return { sessionId, holder: terminalControlHolder(sessionId) };
    },
  );

  // open a long-lived bidirectional PTY on the session's workspace
  typed.post(
    "/api/v1/companies/:companyId/terminals/:sessionId/shell/open",
    {
      schema: {
        params: SessionParamsSchema,
        body: z.object({
          cols: z.number().int().min(10).max(500).default(120),
          rows: z.number().int().min(4).max(200).default(32),
        }),
        tags: ["terminals"],
        hide: true,
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, sessionId } = request.params;
      await requireAdmin(user.id, companyId);
      const session = await requireSession(companyId, sessionId);
      const res = await sandboxPost(`/internal/v1/terminals/${sessionId}/shell/open`, {
        workspaceId: session.workspaceId,
        cols: request.body.cols,
        rows: request.body.rows,
      });
      if (!res.ok) throw new ApiError("internal", `shell open failed (${res.status})`);
      return (await res.json()) as { sessionId: string; opened: boolean };
    },
  );

  // Founder keystrokes — only while holding human_control
  typed.post(
    "/api/v1/companies/:companyId/terminals/:sessionId/write",
    {
      schema: {
        params: SessionParamsSchema,
        body: z.object({ dataBase64: z.string().max(64 * 1024) }),
        tags: ["terminals"],
        hide: true,
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, sessionId } = request.params;
      await requireAdmin(user.id, companyId);
      await requireSession(companyId, sessionId);
      if (terminalControlHolder(sessionId) !== "human") {
        throw new ApiError("conflict", "take control first (human_control required)");
      }
      const res = await sandboxPost(`/internal/v1/terminals/${sessionId}/shell/write`, {
        dataBase64: request.body.dataBase64,
      });
      if (res.status === 404) throw new ApiError("not_found", "no live shell — open it first");
      if (!res.ok) throw new ApiError("internal", `shell write failed (${res.status})`);
      return { ok: true };
    },
  );

  typed.post(
    "/api/v1/companies/:companyId/terminals/:sessionId/resize",
    {
      schema: {
        params: SessionParamsSchema,
        body: z.object({
          cols: z.number().int().min(10).max(500),
          rows: z.number().int().min(4).max(200),
        }),
        tags: ["terminals"],
        hide: true,
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, sessionId } = request.params;
      await requireAdmin(user.id, companyId);
      await requireSession(companyId, sessionId);
      const ctx = companyContext(companyId);
      await deps
        .guardedDb()
        .update(terminalSessions)
        .set({ cols: request.body.cols, rows: request.body.rows })
        .where(
          and(eq(terminalSessions.companyId, ctx.companyId), eq(terminalSessions.id, sessionId)),
        );
      const res = await sandboxPost(`/internal/v1/terminals/${sessionId}/shell/resize`, {
        cols: request.body.cols,
        rows: request.body.rows,
      });
      // no live shell is fine — the size lands in DB for the next open
      if (!res.ok && res.status !== 404) {
        throw new ApiError("internal", `shell resize failed (${res.status})`);
      }
      return { ok: true };
    },
  );

  // full scrollback download — REST, not WS (22 §5.2)
  typed.get(
    "/api/v1/companies/:companyId/terminals/:sessionId/log",
    { schema: { params: SessionParamsSchema, tags: ["terminals"], hide: true } },
    async (request, reply) => {
      const user = request.requireUser();
      const { companyId, sessionId } = request.params;
      await requireAdmin(user.id, companyId);
      const ctx = companyContext(companyId);
      const db = deps.guardedDb();
      const [row] = await db
        .select({ id: terminalSessions.id })
        .from(terminalSessions)
        .where(and(eq(terminalSessions.companyId, ctx.companyId), eq(terminalSessions.id, sessionId)))
        .limit(1);
      if (!row) throw new ApiError("not_found", "terminal session not found");

      const sandbox = deps.sandbox();
      if (!sandbox) throw new ApiError("internal", "log storage not wired");
      const res = await fetch(`${sandbox.url}/internal/v1/terminals/${sessionId}/log`, {
        headers: { authorization: `Bearer ${sandbox.token}` },
      });
      if (res.status === 404) throw new ApiError("not_found", "no log for session");
      if (!res.ok) throw new ApiError("internal", `log fetch failed (${res.status})`);
      const text = await res.text();
      return reply
        .type("text/plain; charset=utf-8")
        .header("content-disposition", `attachment; filename="terminal-${sessionId}.log"`)
        .send(text);
    },
  );
}
