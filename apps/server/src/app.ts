// Fastify 5 modular monolith skeleton (28 §2, 21 §2): zod type provider,
// problem+json error envelope, OpenAPI 3.1 via @fastify/swagger, one plugin
// per domain module. buildApp does NO IO — boot wiring lives in main.ts.
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { problemFor, type ErrorCode } from "@acos/contracts";
import { ProjectsService, companyContext } from "@acos/db";
import type { Db, GuardedDb } from "@acos/db";
import { registerHealthRoutes, type HealthCheckers } from "./modules/health/index.js";
import { moduleStubs } from "./modules/index.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import {
  AuthService,
  CSRF_COOKIE,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  type UserRow,
} from "./modules/auth/service.js";
import { registerCompanyRoutes } from "./modules/companies/routes.js";
import { CompanyService } from "./modules/companies/service.js";
import { registerOrgRoutes } from "./modules/org/routes.js";
import { OrgService } from "./modules/org/service.js";
import { registerAgentRoutes } from "./modules/agents/routes.js";
import { AgentsService } from "./modules/agents/service.js";
import { registerEventRoutes } from "./modules/events/routes.js";
import { registerOfficeRoutes } from "./modules/office/routes.js";
import { EventsReadService } from "./modules/events/read.js";
import { registerTaskRoutes } from "./modules/tasks/routes.js";
import { TasksService, TaskStateService } from "./modules/tasks/service.js";
import { registerCommsRoutes } from "./modules/comms/routes.js";
import { registerApprovalRoutes, type ApprovalSignalPort } from "./modules/approvals/routes.js";
import { registerToolGatewayRoutes, registerToolManagementRoutes } from "./modules/tools/routes.js";
import { registerTerminalRoutes } from "./modules/terminals/routes.js";
import { registerProjectRoutes, type IntakeStarter } from "./modules/projects/routes.js";
import { registerReviewRoutes } from "./modules/reviews/routes.js";
import { registerSkillRoutes } from "./modules/skills/routes.js";
import { registerMemoryRoutes } from "./modules/memory/routes.js";
import { registerCostRoutes } from "./modules/costs/routes.js";
import { ToolGateway, type ToolDispatchPort } from "./modules/tools/gateway.js";
import { unsealSecret } from "./modules/auth/crypto.js";
import { secrets } from "@acos/db/schema";
import { and, eq } from "drizzle-orm";
import type { SignalPort } from "@acos/db";
import { RealtimeGateway } from "./modules/realtime/gateway.js";
import { createOfficeProjector } from "./modules/office/wiring.js";
import type { OfficeProjector } from "./modules/office/projector.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: { kind: "user"; user: UserRow; scopes: string[] | null } | null;
    requireUser(): UserRow;
  }
  interface FastifyInstance {
    realtime: RealtimeGateway | null;
    officeProjector: OfficeProjector | null;
    attachOfficeNats: ((nats: import("nats").NatsConnection) => void) | null;
    /** Temporal-backed message delivery — attached by main.ts when up (T33). */
    commsSignalPort: SignalPort | null;
    /** Temporal-backed approvalVerdict delivery — attached by main.ts (T35). */
    approvalSignalPort: ApprovalSignalPort | null;
    /** Assignment → agentTaskWorkflow start (09 §4) — attached by main.ts (T36). */
    agentWorkflowStarter: import("./modules/workflows/client.js").AgentWorkflowStarter | null;
    /** request_review → reviewWorkflow start (15 §2, T43) — attached by main.ts
     *  (T53). null ⇒ Temporal yok: inceleme satırı yine açılır ama turu kimse
     *  başlatmaz, bu yüzden dispatcher bunu SESSİZ geçmez, warn'lar. */
    reviewWorkflowStarter: import("./modules/workflows/client.js").ReviewWorkflowStarter | null;
    /** Tool execution seam (17 §4 step 7) — attached by T40 wiring; null ⇒
     *  allow-decisions dispatch-fail (still audited). */
    toolDispatchPort: ToolDispatchPort | null;
    /** projectIntakeWorkflow start (14 §2) — attached by main.ts (T42). */
    intakeStarter: IntakeStarter | null;
    /** TASK 18: READY projeye hedef verilince analiz+planlama akışı. */
    goalStarter:
      | ((input: {
          companyId: string;
          projectId: string;
          projectName: string;
          objective: string;
          constraints: string | null;
        }) => Promise<void>)
      | null;
    /** E2/W5: onaylanan kadro önerisini BEKLEYEN iş akışına sinyal. */
    proposalSignaller:
      | import("./modules/staffing/proposal-routes.js").ProposalSignaller
      | null;
  }
}

/** Domain errors carrying a stable API error code (21 §2.5). */
export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface BuildAppOptions {
  healthCheckers: HealthCheckers;
  version?: string;
  logger?: boolean;
  /** Absent only for OpenAPI generation — handlers throw if hit without it. */
  db?: Db;
  guardedDb?: GuardedDb;
  masterKey?: string;
  /** Shared bearer for /internal/* routes (18 §2) — workers ↔ gateway. */
  internalApiToken?: string;
  /** sandbox-manager internal API — terminal ring/log source (22 §5.2, T41). */
  sandboxManagerUrl?: string;
  /** E4/A (T30): konteynerdeki CLI'ın çağıracağı MCP adresi (workspace ağı). */
  mcpPublicUrl?: string;
  /** E4/A (T30): şirket başına eşzamanlı canlı oturum tavanı. */
  maxLiveSessionsPerCompany?: number;
  /** Single-user mode (AUTH_AUTOLOGIN): mint a Founder session for cookie-less GETs. */
  autologinFounder?: boolean;
}

export type App = FastifyInstance;

export async function buildApp(options: BuildAppOptions): Promise<App> {
  const app = Fastify({
    logger: options.logger ?? true,
    requestIdHeader: "x-request-id",
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);

  // ---------- principal resolution + CSRF (18 §2, 21 §2.2) ----------
  let authService: AuthService | null = null;
  const auth = (): AuthService => {
    if (!authService) {
      if (!options.db || !options.masterKey) throw new ApiError("internal", "auth not wired");
      authService = new AuthService(options.db, options.masterKey);
    }
    return authService;
  };

  app.decorateRequest("principal", null);
  app.decorateRequest("requireUser", function (this: { principal: { user: UserRow } | null }) {
    if (!this.principal) throw new ApiError("unauthenticated", "authentication required");
    return this.principal.user;
  });

  app.addHook("preHandler", async (request, reply) => {
    const bearer = request.headers.authorization;
    if (bearer?.startsWith("Bearer acos_pat_")) {
      const verified = await auth().verifyPat(bearer.slice("Bearer ".length));
      if (verified) request.principal = { kind: "user", user: verified.user, scopes: verified.scopes };
      return;
    }
    const sessionToken = request.cookies?.[SESSION_COOKIE];
    if (sessionToken) {
      const user = await auth().verifySession(sessionToken);
      if (user) {
        request.principal = { kind: "user", user, scopes: null };
        // CSRF double-submit for cookie-session mutations (18 §2). Auth
        // bootstrap routes (login/setup/logout) are exempt by design.
        const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
        const exempt = ["/api/v1/auth/login", "/api/v1/auth/setup", "/api/v1/auth/logout"];
        if (mutating && !exempt.includes(request.url.split("?")[0]!)) {
          const cookieToken = request.cookies?.[CSRF_COOKIE];
          const headerToken = request.headers["x-csrf-token"];
          if (!cookieToken || headerToken !== cookieToken) {
            throw new ApiError("forbidden", "missing or mismatched CSRF token");
          }
        }
        return;
      }
    }
    // Single-user mode (AUTH_AUTOLOGIN, Founder decision 2026-08-13): no
    // credentials presented (or a stale session) → mint a real Founder
    // session and continue as authenticated. Cookie-less GETs on /api/v1
    // only, so health probes and the WS upgrade never mint sessions; the SPA
    // picks the cookies up on its first read and mutations/WS reuse them.
    if (
      options.autologinFounder &&
      request.principal === null &&
      options.db !== undefined &&
      ["GET", "HEAD", "OPTIONS"].includes(request.method) &&
      request.url.startsWith("/api/v1/")
    ) {
      const result = await auth().autologinFounder({
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
      if (result.kind === "ok") {
        reply
          .setCookie(SESSION_COOKIE, result.sessionToken, SESSION_COOKIE_OPTIONS)
          .setCookie(CSRF_COOKIE, result.csrfToken, { ...SESSION_COOKIE_OPTIONS, httpOnly: false });
        request.principal = { kind: "user", user: result.user, scopes: null };
      }
    }
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "ACOS API",
        description: "AI Agent Company OS control-plane API (21-API-DESIGN.md)",
        version: options.version ?? "0.0.0",
      },
      servers: [{ url: "/" }],
    },
    transform: jsonSchemaTransform,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      const problem = problemFor(error.code, error.message, {
        instance: request.url,
        requestId: request.id,
      });
      return reply.status(problem.status).type("application/problem+json").send(problem);
    }
    if (error.validation) {
      const problem = problemFor("validation_failed", "request validation failed", {
        instance: request.url,
        requestId: request.id,
        errors: error.validation.map((issue) => ({
          path: String(issue.instancePath || issue.params?.missingProperty || ""),
          message: issue.message ?? "invalid",
        })),
      });
      return reply.status(400).type("application/problem+json").send(problem);
    }
    request.log.error(error);
    const problem = problemFor("internal", "unexpected server error", {
      instance: request.url,
      requestId: request.id,
    });
    return reply.status(500).type("application/problem+json").send(problem);
  });

  // Preview Gateway (REVISION TASK 3): kayıt aşağıda — 404 fallback'i mutlak
  // yollu asset isteklerini aktif preview hedefine proxy'ler.
  let previewFallback: import("./modules/preview/routes.js").PreviewFallback | null = null;
  app.setNotFoundHandler(async (request, reply) => {
    if (previewFallback && (await previewFallback(request, reply))) return reply;
    const problem = problemFor("not_found", `route ${request.method} ${request.url} not found`, {
      instance: request.url,
      requestId: request.id,
    });
    return reply.status(404).type("application/problem+json").send(problem);
  });

  // Container healthcheck (compose) — trivial liveness.
  app.get("/healthz", () => ({ status: "ok", service: "server" }));

  let companyService: CompanyService | null = null;
  const companiesSvc = (): CompanyService => {
    if (!companyService) {
      if (!options.guardedDb) throw new ApiError("internal", "companies not wired");
      companyService = new CompanyService(options.guardedDb);
    }
    return companyService;
  };

  await registerHealthRoutes(app, options.healthCheckers, options.version ?? "0.0.0");
  await registerAuthRoutes(app, auth);
  let orgService: OrgService | null = null;
  const orgSvc = (): OrgService => {
    if (!orgService) {
      if (!options.guardedDb) throw new ApiError("internal", "org not wired");
      orgService = new OrgService(options.guardedDb);
    }
    return orgService;
  };

  await registerCompanyRoutes(app, companiesSvc, () => {
    if (!options.guardedDb) throw new ApiError("internal", "companies not wired");
    return options.guardedDb;
  });
  let agentsService: AgentsService | null = null;
  const agentsSvc = (): AgentsService => {
    if (!agentsService) {
      if (!options.guardedDb) throw new ApiError("internal", "agents not wired");
      agentsService = new AgentsService(options.guardedDb, orgSvc());
    }
    return agentsService;
  };

  let eventsReadService: EventsReadService | null = null;
  const eventsSvc = (): EventsReadService => {
    if (!eventsReadService) {
      if (!options.guardedDb) throw new ApiError("internal", "events not wired");
      eventsReadService = new EventsReadService(options.guardedDb);
    }
    return eventsReadService;
  };

  let tasksService: TasksService | null = null;
  const tasksSvc = (): TasksService => {
    if (!tasksService) {
      if (!options.guardedDb) throw new ApiError("internal", "tasks not wired");
      tasksService = new TasksService(options.guardedDb);
    }
    return tasksService;
  };
  let taskStateService: TaskStateService | null = null;
  const taskStateSvc = (): TaskStateService => {
    if (!taskStateService) {
      if (!options.guardedDb) throw new ApiError("internal", "tasks not wired");
      taskStateService = new TaskStateService(options.guardedDb);
    }
    return taskStateService;
  };

  await registerOrgRoutes(app, orgSvc, companiesSvc, () => {
    if (!options.guardedDb) throw new ApiError("internal", "org not wired");
    return options.guardedDb;
  });
  await registerAgentRoutes(app, agentsSvc, companiesSvc);
  await registerEventRoutes(app, eventsSvc, companiesSvc);
  app.decorate("agentWorkflowStarter", null);
  app.decorate("reviewWorkflowStarter", null);
  await registerTaskRoutes(
    app,
    tasksSvc,
    taskStateSvc,
    companiesSvc,
    () => app.agentWorkflowStarter,
    // Tepe yönetici çözümü TEK yerde: ProjectsService.topExecutive. Intake
    // yönlendirmesi ve yönetici raporu zaten onu kullanıyor; direktif ucu da
    // aynı mantığa bağlanır, kopyalanmaz.
    async (ctx) => {
      if (!options.guardedDb) throw new ApiError("internal", "tasks not wired");
      return new ProjectsService(options.guardedDb).topExecutive(ctx);
    },
  );
  app.decorate("commsSignalPort", null);
  await registerCommsRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "comms not wired");
      return options.guardedDb;
    },
    companiesSvc,
    signalPort: () => app.commsSignalPort,
  });
  app.decorate("approvalSignalPort", null);
  await registerApprovalRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "approvals not wired");
      return options.guardedDb;
    },
    companiesSvc,
    approvalSignal: () => app.approvalSignalPort,
  });

  // ---------- Tool Gateway (T39; 17 §4, S3 single choke point) ----------
  app.decorate("toolDispatchPort", null);
  let toolGateway: ToolGateway | null = null;
  const toolGatewaySvc = (): ToolGateway => {
    if (!toolGateway) {
      if (!options.guardedDb) throw new ApiError("internal", "tool gateway not wired");
      const guardedDb = options.guardedDb;
      toolGateway = new ToolGateway({
        db: guardedDb,
        // late-bound so T40 wiring (or tests) can attach after buildApp
        dispatch: {
          // B2 (2026-08-15 kod incelemesi): prepare köprüsü EKSİKTİ — gateway
          // `if (this.dispatchPort.prepare)` görüp atlıyordu, böylece repo
          // klonu + imaj çekme + konteyner kurulumu aracın kendi penceresinde
          // (fs.read = 10 sn) koşuyor ve ilk araç çağrısı hep timeout'a
          // düşüyordu. prepare kendi 10 dk'lık bütçesinde çalışmalı (17 §4).
          prepare: async (req) => {
            await app.toolDispatchPort?.prepare?.(req);
          },
          dispatch: (invocation) => {
            if (!app.toolDispatchPort) {
              return Promise.reject(new Error("tool dispatch not wired (lands with T40)"));
            }
            return app.toolDispatchPort.dispatch(invocation);
          },
        },
        // S2: sealed-box secrets resolved server-side at dispatch time only
        resolveCredential: async (ctx, name) => {
          if (!options.masterKey) return null;
          const [row] = await guardedDb
            .select()
            .from(secrets)
            .where(and(eq(secrets.companyId, ctx.companyId), eq(secrets.name, name)))
            .limit(1);
          if (!row) return null;
          return unsealSecret(options.masterKey, Buffer.from(row.ciphertext as Uint8Array));
        },
      });
    }
    return toolGateway;
  };
  registerToolGatewayRoutes(app, {
    gateway: toolGatewaySvc,
    internalApiToken: () => {
      if (!options.internalApiToken) throw new ApiError("internal", "internal token not wired");
      return options.internalApiToken;
    },
  });
  registerToolManagementRoutes(app, {
    db: () => {
      if (!options.guardedDb) throw new ApiError("internal", "tool permissions not wired");
      return options.guardedDb;
    },
    membership: (userId, companyId) => companiesSvc().membership(userId, companyId),
  });

  // ---------- terminals (T41; 24 §6.9) ----------
  const sandboxInternal =
    options.sandboxManagerUrl && options.internalApiToken
      ? { url: options.sandboxManagerUrl, token: options.internalApiToken }
      : null;
  const terminalRingSource = sandboxInternal
    ? {
        async ring(sessionId: string) {
          const res = await fetch(
            `${sandboxInternal.url}/internal/v1/terminals/${sessionId}/ring`,
            { headers: { authorization: `Bearer ${sandboxInternal.token}` } },
          );
          if (!res.ok) throw new Error(`ring fetch failed (${res.status})`);
          return (await res.json()) as {
            frames: { seq: number; ts: number; stream: string; data: string }[];
            currentSeq: number;
            source: string;
          };
        },
      }
    : null;
  await registerTerminalRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "terminals not wired");
      return options.guardedDb;
    },
    companiesSvc,
    sandbox: () => sandboxInternal,
  });

  // ---------- code index (REVISION TASK 4) ----------
  const { registerCodeIndexRoutes } = await import("./modules/code-index/routes.js");
  await registerCodeIndexRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "code index not wired");
      return options.guardedDb;
    },
    companiesSvc,
    sandbox: () => sandboxInternal,
    internalApiToken: () => {
      if (!options.internalApiToken) throw new ApiError("internal", "internal token not wired");
      return options.internalApiToken;
    },
  });

  // ---------- staffing (LIFECYCLE TASK 9+10) ----------
  const { registerStaffingRoutes } = await import("./modules/staffing/routes.js");
  await registerStaffingRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "staffing not wired");
      return options.guardedDb;
    },
    companiesSvc,
    internalApiToken: () => {
      if (!options.internalApiToken) throw new ApiError("internal", "internal token not wired");
      return options.internalApiToken;
    },
    starter: () => app.agentWorkflowStarter,
  });

  // ---------- E4/A: MCP tool-gateway (T30) ----------
  const { createActionDispatcher } = await import("@acos/agent-actions");
  let mcpDispatcher: import("@acos/agent-actions").ActionDispatcher | null = null;
  // Konteynerdeki `claude` oturumu ACOS'a BURADAN ulaşır — Tool Gateway'in
  // üstüne oturur, yanına değil. Kimlik oturum jetonundan türer.
  const { registerMcpRoutes } = await import("./modules/mcp/routes.js");
  await registerMcpRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "mcp not wired");
      return options.guardedDb;
    },
    gateway: toolGatewaySvc,
    internalApiToken: () => {
      if (!options.internalApiToken) throw new ApiError("internal", "internal token not wired");
      return options.internalApiToken;
    },
    publicMcpUrl: () => options.mcpPublicUrl ?? "http://server:3000/mcp/v1",
    maxLiveSessionsPerCompany: () => options.maxLiveSessionsPerCompany ?? 3,
    // Family B: worker ile AYNI dağıtıcı (INV-13 tek yazar). Portlar sunucunun
    // kendi kancalarına bağlanır: atama sonrası sahibin workflow'u başlar,
    // araç çağrıları yine Tool Gateway'den geçer.
    dispatcher: () => {
      if (!mcpDispatcher) {
        if (!options.guardedDb) throw new ApiError("internal", "mcp not wired");
        mcpDispatcher = createActionDispatcher({
          guardedDb: options.guardedDb,
          startAgentWorkflow: async (input) => {
            await app.agentWorkflowStarter?.(input);
          },
          // T53 — E4 canlı run #2'nin platosu tam buradaydı: bu dep YOKTU.
          // CLI şeridinde her `request_review` sunucunun MCP dispatcher'ından
          // geçiyor; dep olmayınca `dispatch.ts` inceleme workflow'unu SESSİZCE
          // atlıyor, görev REVIEW'da kalıcı kilitleniyordu (sweep §4 bu hali
          // kasten dışlar). Starter yoksa (Temporal kapalı) sessiz geçmiyoruz:
          // satır durur, savunma katmanı sweep onu kurtarır, ama log'da görünür.
          startReviewWorkflow: async (input) => {
            if (!app.reviewWorkflowStarter) {
              app.log.warn(
                { taskId: input.taskId, reviewId: input.reviewId, reviewerAgentId: input.reviewerAgentId },
                "review opened but no reviewWorkflow starter is wired — the reviewer's turn will NOT start until the stuck-task sweep picks it up",
              );
              return;
            }
            await app.reviewWorkflowStarter(input);
          },
          ...(app.commsSignalPort && { signalPort: app.commsSignalPort }),
          invokeTool: async (req) => {
            const response = await toolGatewaySvc().invoke(companyContext(req.companyId), {
              agentId: req.agentId,
              toolName: req.toolName,
              input: req.input,
              taskId: req.taskId,
              idempotencyKey: req.idempotencyKey,
              ...(req.agentSessionId && { agentSessionId: req.agentSessionId }),
            });
            return {
              invocationId: response.invocationId,
              decision: response.decision,
              status: response.status,
              reason: response.reason,
              ...(response.output !== undefined && { output: response.output }),
              ...(response.error !== undefined && { error: response.error }),
              ...(response.costCents !== undefined && { costCents: response.costCents }),
              ...(response.retryAfterSec !== undefined && { retryAfterSec: response.retryAfterSec }),
            };
          },
        });
      }
      return mcpDispatcher;
    },
  });

  // ---------- E2/W3+W5: düzenlenebilir kadro önerisi (T19) ----------
  const { registerProposalRoutes } = await import("./modules/staffing/proposal-routes.js");
  await registerProposalRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "staffing not wired");
      return options.guardedDb;
    },
    companiesSvc,
    internalApiToken: () => {
      if (!options.internalApiToken) throw new ApiError("internal", "internal token not wired");
      return options.internalApiToken;
    },
    proposalSignaller: () => app.proposalSignaller,
  });

  // ---------- preview gateway (REVISION TASK 3) ----------
  const { registerPreviewRoutes } = await import("./modules/preview/routes.js");
  previewFallback = await registerPreviewRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "preview not wired");
      return options.guardedDb;
    },
    companiesSvc,
    sandbox: () => sandboxInternal,
    publicServerUrl: process.env.PUBLIC_SERVER_URL ?? "http://localhost:3000",
  });

  // ---------- integrations: GitHub (2026-08-18) ----------
  const { registerIntegrationRoutes } = await import("./modules/integrations/routes.js");
  await registerIntegrationRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "integrations not wired");
      return options.guardedDb;
    },
    membership: (userId, companyId) => companiesSvc().membership(userId, companyId),
    masterKey: options.masterKey,
    sandbox: () => sandboxInternal,
    internalApiToken: () => {
      if (!options.internalApiToken) throw new ApiError("internal", "internal token not wired");
      return options.internalApiToken;
    },
  });

  // ---------- reviews (T43; 15 §2) ----------
  await registerReviewRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "reviews not wired");
      return options.guardedDb;
    },
    companiesSvc,
    sandbox: () => sandboxInternal,
  });

  // ---------- skills matrix (T47; 13 §10) ----------
  await registerSkillRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "skills not wired");
      return options.guardedDb;
    },
    companiesSvc,
  });

  // ---------- memory observatory (T48; 12 §8) ----------
  await registerMemoryRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "memories not wired");
      return options.guardedDb;
    },
    companiesSvc,
  });

  // ---------- costs + reports (T49; 26 §9/§12) ----------
  await registerCostRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "costs not wired");
      return options.guardedDb;
    },
    companiesSvc,
  });

  // ---------- projects + intake (T42; 14 §2) ----------
  app.decorate("intakeStarter", null);
  app.decorate("goalStarter", null);
  app.decorate("proposalSignaller", null);
  await registerProjectRoutes(app, {
    guardedDb: () => {
      if (!options.guardedDb) throw new ApiError("internal", "projects not wired");
      return options.guardedDb;
    },
    companiesSvc,
    intakeStarter: () => app.intakeStarter,
    goalStarter: () => app.goalStarter,
    sandbox: () => sandboxInternal,
  });

  // ---------- /ws gateway (T23; 21 §4, 22 §2–8) ----------
  await app.register(websocket, { options: { maxPayload: 131_072 } }); // 128 KB (22 §8)
  const office = options.guardedDb ? createOfficeProjector(options.guardedDb) : null;
  const gateway = options.guardedDb
    ? new RealtimeGateway(
        options.guardedDb,
        {
          verifySession: (token) => auth().verifySession(token),
          membership: (userId, companyId) => companiesSvc().membership(userId, companyId),
        },
        office?.projector ?? null,
        () => terminalRingSource,
      )
    : null;
  app.decorate("realtime", gateway);
  app.decorate("officeProjector", office?.projector ?? null);
  app.decorate("attachOfficeNats", office ? office.attachNats : null);

  // ---------- office floor plan (U04; 36 §7, N1 read-only) ----------
  await registerOfficeRoutes(app, {
    projector: () => {
      if (!office) throw new ApiError("internal", "office projector not wired");
      return office.projector;
    },
    companiesSvc,
  });
  gateway?.start();
  app.addHook("onClose", async () => {
    await gateway?.stop();
  });

  app.get("/ws", { websocket: true, schema: { hide: true } }, (socket, request) => {
    void (async () => {
      if (!gateway) return socket.close(4401, "gateway not wired");
      // session cookie (browsers) — resolved by the global preHandler — or
      // ?pat= for CLI with read:events minimum (21 §4.1)
      if (request.principal) {
        if (request.principal.scopes && !request.principal.scopes.includes("read:events")) {
          return socket.close(4401, "pat lacks read:events");
        }
        const sessionToken = request.cookies?.[SESSION_COOKIE] ?? null;
        return gateway.handleConnection(socket, {
          userId: request.principal.user.id,
          sessionToken: request.principal.scopes === null ? sessionToken : null,
        });
      }
      const pat = (request.query as { pat?: string }).pat;
      if (pat) {
        const verified = await auth().verifyPat(pat).catch(() => null);
        if (verified && verified.scopes.includes("read:events")) {
          return gateway.handleConnection(socket, {
            userId: verified.user.id,
            sessionToken: null,
          });
        }
      }
      socket.close(4401, "unauthenticated");
    })();
  });

  // Domain modules (28 §2) — stubs now; routes land with T16+.
  for (const [name, plugin] of Object.entries(moduleStubs)) {
    await app.register(plugin, { prefix: `/api/v1`, name });
  }

  return app;
}
