// sandbox-manager HTTP surface (28 §2, T37). Internal-only: every route
// behind the shared INTERNAL_API_TOKEN bearer (18 §2) — there is no session
// or PAT path into the Docker-socket owner. Buffered exec returns the result
// inline; a streaming exec (sessionId present) acks immediately and frames
// flow over NATS `term.<sessionId>`.
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import Fastify, { type FastifyInstance } from "fastify";
import {
  CreateWorkspaceRequestSchema,
  EnsureRepoRequestSchema,
  ExecRequestSchema,
  IngestRepoRequestSchema,
  MergeBranchRequestSchema,
  ProvisionWorktreeRequestSchema,
  WORKTREE_VOLUME_PATTERN,
  type ExecResult,
} from "@acos/contracts";
import type { DockerSandbox } from "./docker.js";
import type { GitWorkspaces } from "./git.js";
import { readLogTail, readLogText } from "./terminal-log.js";

export interface AppDeps {
  sandbox: DockerSandbox;
  git: GitWorkspaces;
  internalApiToken: string;
  /** DATA_DIR/terminals — rolling logs for ring fallback + downloads (T41). */
  terminalsDir?: string;
  logger?: boolean;
}

function bearerOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true });

  // container liveness (compose healthcheck) — no auth, no Docker call
  app.get("/healthz", () => ({ status: "ok", service: "sandbox-manager" }));

  // everything else requires the internal bearer (S2/S3 boundary)
  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/healthz") return;
    if (!bearerOk(request.headers.authorization, deps.internalApiToken)) {
      return reply.status(401).send({ code: "unauthenticated", message: "internal token required" });
    }
  });

  app.post("/internal/v1/workspaces", async (request, reply) => {
    const parsed = CreateWorkspaceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const workspace = await deps.sandbox.createWorkspace(parsed.data);
    return reply.status(201).send(workspace);
  });

  app.get("/internal/v1/workspaces", async () => {
    return deps.sandbox.list();
  });

  app.post<{ Params: { workspaceId: string } }>(
    "/internal/v1/workspaces/:workspaceId/exec",
    async (request, reply) => {
      const parsed = ExecRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
      }
      const { workspaceId } = request.params;
      if (parsed.data.sessionId) {
        const session = deps.sandbox.newTerminalSession(parsed.data.sessionId);
        if (parsed.data.waitForResult) {
          // T41: frames stream live over NATS `term.<id>` WHILE the caller
          // awaits the buffered result — the tool path wants both
          const result = await deps.sandbox.exec(workspaceId, parsed.data, session);
          return reply.status(200).send(result);
        }
        // fire-and-forget streaming: ack now, frames flow over NATS
        void deps.sandbox
          .exec(workspaceId, parsed.data, session)
          .catch((err) => app.log.error({ err, workspaceId }, "streaming exec failed"));
        return reply.status(202).send({ sessionId: parsed.data.sessionId, streaming: true });
      }
      const result: ExecResult = await deps.sandbox.exec(workspaceId, parsed.data);
      return reply.status(200).send(result);
    },
  );

  // --- Terminal replay + scrollback (22 §5.2, T41) ---

  app.get<{ Params: { sessionId: string } }>(
    "/internal/v1/terminals/:sessionId/ring",
    async (request, reply) => {
      const { sessionId } = request.params;
      const live = deps.sandbox.terminalSession(sessionId);
      if (live) {
        return reply.send({
          frames: live.ringFrames(),
          currentSeq: live.currentSeq,
          source: "ring",
        });
      }
      if (deps.terminalsDir) {
        const frames = await readLogTail(deps.terminalsDir, sessionId).catch(() => []);
        if (frames.length > 0) {
          return reply.send({
            frames,
            currentSeq: frames[frames.length - 1]!.seq,
            source: "log",
          });
        }
      }
      return reply.send({ frames: [], currentSeq: 0, source: "none" });
    },
  );

  // --- Preview gateway (REVISION TASK 3): port discovery + reverse proxy ---

  app.get<{ Params: { workspaceId: string } }>(
    "/internal/v1/workspaces/:workspaceId/ports",
    async (request) => {
      const ports = await deps.sandbox.discoverPorts(request.params.workspaceId);
      return { workspaceId: request.params.workspaceId, ports };
    },
  );

  app.all<{ Params: { workspaceId: string; port: string; "*": string } }>(
    "/internal/v1/workspaces/:workspaceId/preview/:port/*",
    async (request, reply) => {
      const port = Number.parseInt(request.params.port, 10);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return reply.status(400).send({ code: "validation_failed", message: "bad port" });
      }
      const ip = await deps.sandbox.containerIp(request.params.workspaceId);
      const rest = request.params["*"] ?? "";
      const qsIndex = request.raw.url?.indexOf("?") ?? -1;
      const qs = qsIndex >= 0 ? request.raw.url!.slice(qsIndex) : "";
      const target = `http://${ip}:${port}/${rest}${qs}`;
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value !== "string") continue;
        // hop-by-hop + host stripped; the upstream sees its own authority
        if (["host", "connection", "authorization", "content-length"].includes(key)) continue;
        headers[key] = value;
      }
      const method = request.method.toUpperCase();
      const hasBody = !["GET", "HEAD"].includes(method);
      let upstream: Response;
      try {
        upstream = await fetch(target, {
          method,
          headers,
          ...(hasBody && {
            body: request.raw as unknown as RequestInit["body"],
            duplex: "half",
          } as RequestInit),
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        return reply
          .status(502)
          .send({ code: "bad_gateway", message: `preview upstream unreachable: ${String(err)}` });
      }
      reply.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (["transfer-encoding", "connection", "content-encoding", "content-length"].includes(key))
          return;
        reply.header(key, value);
      });
      const buf = Buffer.from(await upstream.arrayBuffer());
      return reply.send(buf);
    },
  );

  // --- Interactive shell (REVISION TASK 2): long-lived bidirectional PTY ---

  app.post<{ Params: { sessionId: string } }>(
    "/internal/v1/terminals/:sessionId/shell/open",
    async (request, reply) => {
      const parsed = z
        .object({
          workspaceId: z.string(),
          cols: z.number().int().min(10).max(500).default(120),
          rows: z.number().int().min(4).max(200).default(32),
        })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
      }
      const result = await deps.sandbox.openShell(
        parsed.data.workspaceId,
        request.params.sessionId,
        parsed.data.cols,
        parsed.data.rows,
      );
      return reply.status(result.opened ? 201 : 200).send({ sessionId: request.params.sessionId, ...result });
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/internal/v1/terminals/:sessionId/shell/write",
    async (request, reply) => {
      const parsed = z.object({ dataBase64: z.string().max(64 * 1024) }).safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
      }
      const ok = deps.sandbox.writeShell(request.params.sessionId, parsed.data.dataBase64);
      if (!ok) return reply.status(404).send({ code: "not_found", message: "no live shell" });
      return reply.send({ ok: true });
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/internal/v1/terminals/:sessionId/shell/resize",
    async (request, reply) => {
      const parsed = z
        .object({ cols: z.number().int().min(10).max(500), rows: z.number().int().min(4).max(200) })
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
      }
      const ok = await deps.sandbox.resizeShell(
        request.params.sessionId,
        parsed.data.cols,
        parsed.data.rows,
      );
      if (!ok) return reply.status(404).send({ code: "not_found", message: "no live shell" });
      return reply.send({ ok: true });
    },
  );

  app.delete<{ Params: { sessionId: string } }>(
    "/internal/v1/terminals/:sessionId/shell",
    async (request, reply) => {
      deps.sandbox.closeShell(request.params.sessionId);
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { sessionId: string } }>(
    "/internal/v1/terminals/:sessionId/log",
    async (request, reply) => {
      if (!deps.terminalsDir) {
        return reply.status(404).send({ code: "not_found", message: "no log storage" });
      }
      const text = await readLogText(deps.terminalsDir, request.params.sessionId).catch(() => null);
      if (text === null) {
        return reply.status(404).send({ code: "not_found", message: "no log for session" });
      }
      return reply.type("text/plain; charset=utf-8").send(text);
    },
  );

  app.delete<{ Params: { workspaceId: string } }>(
    "/internal/v1/workspaces/:workspaceId",
    async (request, reply) => {
      await deps.sandbox.destroyWorkspace(request.params.workspaceId);
      return reply.status(204).send();
    },
  );

  // --- Git model (T38): bare repos + per-task worktree volumes ---

  app.post("/internal/v1/repos", async (request, reply) => {
    const parsed = EnsureRepoRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const result = await deps.git.ensureBareRepo(parsed.data.projectId);
    return reply.status(result.created ? 201 : 200).send(result);
  });

  // task-branch push worktree → bare (T43, 15 §3.1)
  app.post("/internal/v1/worktrees/push", async (request, reply) => {
    const parsed = z
      .object({
        projectId: z.uuid(),
        volumeName: z.string(),
        branch: z.string(),
        force: z.boolean().default(false),
      })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const result = await deps.git.pushTaskBranch(parsed.data);
    return reply.status(200).send(result);
  });

  // CodeIndex (REVISION TASK 4): bare repo kod anlık görüntüsü + diff
  app.post("/internal/v1/repos/code-snapshot", async (request, reply) => {
    const parsed = z
      .object({ projectId: z.uuid(), paths: z.array(z.string()).max(2000).optional() })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const result = await deps.git.codeSnapshot(parsed.data);
    return reply.status(200).send(result);
  });

  // TASK 6: greenfield bootstrap — deterministik başlangıç dosyaları
  app.post("/internal/v1/repos/seed-greenfield", async (request, reply) => {
    const parsed = z
      .object({ projectId: z.uuid(), name: z.string().max(200), objective: z.string().max(2000) })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const result = await deps.git.seedGreenfieldRepo(parsed.data);
    return reply.status(200).send(result);
  });

  // TASK 5: task worktree overlay snapshot
  app.post("/internal/v1/worktrees/code-snapshot", async (request, reply) => {
    const parsed = z.object({ volumeName: z.string() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const result = await deps.git.worktreeCodeSnapshot(parsed.data);
    return reply.status(200).send(result);
  });

  app.post("/internal/v1/repos/changed-files", async (request, reply) => {
    const parsed = z
      .object({ projectId: z.uuid(), from: z.string(), to: z.string() })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const result = await deps.git.changedFiles(parsed.data);
    return reply.status(200).send(result);
  });

  // lead squash-merge into main (T43, 15 §3.6)
  app.post("/internal/v1/repos/merge", async (request, reply) => {
    const parsed = MergeBranchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const result = await deps.git.mergeTaskBranch(parsed.data);
    return reply.status(200).send(result);
  });

  // GitHub yansıması: bare repo → dış remote push (2026-08-18)
  app.post("/internal/v1/repos/publish", async (request, reply) => {
    const parsed = z
      .object({ projectId: z.uuid(), remoteUrl: z.string().url(), authB64: z.string().min(8) })
      .safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const result = await deps.git.publishToRemote(parsed.data);
    return reply.status(200).send(result);
  });

  // project intake ingest (T42, 14 §3.1 stage 1)
  app.post("/internal/v1/repos/ingest", async (request, reply) => {
    const parsed = IngestRepoRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const result = await deps.git.ingestRepo(parsed.data);
    return reply.status(result.created ? 201 : 200).send(result);
  });

  app.post("/internal/v1/worktrees", async (request, reply) => {
    const parsed = ProvisionWorktreeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const result = await deps.git.provisionWorktree(parsed.data);
    return reply.status(result.created ? 201 : 200).send(result);
  });

  app.delete<{ Params: { volumeName: string } }>(
    "/internal/v1/worktrees/:volumeName",
    async (request, reply) => {
      if (!WORKTREE_VOLUME_PATTERN.test(request.params.volumeName)) {
        return reply.status(400).send({ code: "validation_failed", message: "bad volume name" });
      }
      await deps.git.removeWorktree(request.params.volumeName);
      return reply.status(204).send();
    },
  );

  app.setErrorHandler((error: Error & { code?: string }, request, reply) => {
    if (error.code === "NOT_FOUND" || error.code === "REPO_NOT_FOUND") {
      return reply.status(404).send({ code: "not_found", message: error.message });
    }
    if (error.code === "INVALID_INPUT") {
      return reply.status(400).send({ code: "validation_failed", message: error.message });
    }
    request.log.error(error);
    return reply.status(500).send({ code: "internal", message: error.message });
  });

  return app;
}
