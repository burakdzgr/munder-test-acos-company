// agent-worker boot (T31/T32; 09 §3, §4.1): three Temporal workers in one
// unprivileged container. Activities get real DB + ModelRouter deps;
// LLM_MODE=scripted swaps in the deterministic fake (32 §6) — used by the
// e2e/demo profile, never by default.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { NativeConnection, Worker } from "@temporalio/worker";
import { loadConfigOrExit, TASK_QUEUES, type Config } from "@acos/config";
import {
  createDb,
  createGuardedDb,
  loadProviderPricing,
  type CompanyContext,
  type GuardedDb,
} from "@acos/db";
import { modelProviders } from "@acos/db/schema";
import {
  ModelRouter,
  SCRIPTED_PRICING,
  createAnthropicAdapter,
  createGeminiAdapter,
  createOllamaAdapter,
  createOpenAiCompatAdapter,
  createOpenAiAdapter,
  createOpenRouterAdapter,
  pricingDefaultsFor,
  type LlmCallLogEntry,
  type ProviderAdapter,
  type ProviderPricingEntry,
  type RoutingContext,
} from "@acos/llm";
import { createScriptedAdapter, loadScript } from "@acos/llm/testing";
import * as trivialActivities from "./activities/index.js";
import {
  createAgentTaskActivities,
  createDbRoutingLoader,
} from "./activities/agent-task.js";
import { createRuntimeEventPublisher } from "./runtime-events.js";

const require = createRequire(import.meta.url);

interface RouterDeps {
  router: ModelRouter;
  routingFor: (ctx: CompanyContext, agentId: string) => Promise<RoutingContext>;
}

/**
 * Router-level accounting log (ADR-015: EVERY attempt is recorded, success and
 * failure). The llm_calls row is written by callModelActivity, but only for
 * calls that returned — failed attempts and fallback hops reach nothing else,
 * so dropping them here (this used to be `() => {}`) lost them entirely.
 * B1 (2026-08-15 code review).
 */
function logLlmCall(entry: LlmCallLogEntry): void {
  console.log(
    JSON.stringify({
      msg: "llm call",
      providerId: entry.providerId,
      model: entry.model,
      purpose: entry.purpose,
      status: entry.status,
      ...(entry.errorKind && { errorKind: entry.errorKind }),
      tokensIn: entry.usage.inputTokens,
      tokensOut: entry.usage.outputTokens,
      tokensCached: entry.usage.cachedInputTokens,
      costCents: entry.costCents,
      latencyMs: entry.latencyMs,
      ...(entry.agentId && { agentId: entry.agentId }),
      ...(entry.taskId && { taskId: entry.taskId }),
      ...(entry.sessionId && { sessionId: entry.sessionId }),
    }),
  );
  // An unpriced model bills 0 and would silently starve the budget guard
  // (INV-19) — surface it instead of inventing a rate.
  const billable = entry.usage.inputTokens + entry.usage.outputTokens > 0;
  if (entry.status === "ok" && billable && entry.costCents === 0) {
    console.log(
      JSON.stringify({
        msg: "llm call priced at 0 — no pricing entry for this model",
        providerId: entry.providerId,
        model: entry.model,
      }),
    );
  }
}

/** Scripted mode (32 §6): fake adapter behind a real model_providers row so
 *  llm_calls FKs stay honest. */
async function buildScriptedRouter(pool: Pool): Promise<RouterDeps> {
  const db = createDb(pool);
  const [existing] = await db
    .select()
    .from(modelProviders)
    .where(eq(modelProviders.name, "scripted"));
  const provider =
    existing ??
    (await db.insert(modelProviders).values({ kind: "ollama", name: "scripted" }).returning())[0]!;

  const scriptsDir = join(dirname(require.resolve("@acos/llm/package.json")), "testing/scripts");
  const scripts = readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => loadScript(readFileSync(join(scriptsDir, f), "utf8")));
  const adapter: ProviderAdapter = { ...createScriptedAdapter(scripts), providerId: provider.id };
  return {
    router: new ModelRouter({
      providers: new Map([[provider.id, adapter]]),
      pricing: new Map([[provider.id, SCRIPTED_PRICING]]),
      logCall: logLlmCall,
    }),
    routingFor: async () => ({
      bindings: [],
      profiles: [
        { purpose: "reasoning", providerId: provider.id, model: "scripted" },
        // semantic retrieval lane (T45): pseudo-embeddings, deterministic
        { purpose: "embedding", providerId: provider.id, model: "scripted" },
      ],
    }),
  };
}

/** Prod: adapters per model_providers row (keyed by row id — what profiles
 *  and bindings reference), transports from config keys. */
async function buildLiveRouter(pool: Pool, guardedDb: GuardedDb, config: Config): Promise<RouterDeps> {
  const db = createDb(pool);
  const rows = await db.select().from(modelProviders).where(eq(modelProviders.enabled, true));
  const providers = new Map<string, ProviderAdapter>();
  // Pricing per provider row, keyed the way the router looks it up (26 §3.1).
  const pricing = new Map<string, ProviderPricingEntry>();
  for (const row of rows) {
    let adapter: ProviderAdapter | null = null;
    if (row.kind === "anthropic" && config.llm.anthropicApiKey) {
      adapter = createAnthropicAdapter({ providerId: row.id, apiKey: config.llm.anthropicApiKey });
    } else if (row.kind === "openai" && row.name === "claude-cli" && config.llm.claudeCliUrl) {
      // Claude Code CLI köprüsü (2026-08-19): host'taki claude-cli-bridge —
      // ABONELİK kotası, API kredisi değil. openai-COMPATIBLE adaptör şart:
      // saf OpenAI sağlayıcısı /responses API'sine gider, köprü yalnız
      // /chat/completions konuşur (canlı bulgu: istekler 404'e düşüyordu).
      adapter = { ...createOpenAiCompatAdapter({ providerId: "claude-cli", baseUrl: config.llm.claudeCliUrl, apiKey: "subscription" }), providerId: row.id };
    } else if (row.kind === "openai" && row.name === "gemini" && config.llm.geminiApiKey) {
      // Gemini (2026-08-19, kayıtlı sapma): model_providers.kind CHECK'i beş
      // türle sabit — Gemini, OpenAI-uyumlu endpoint'inden konuşulduğu için
      // kind='openai' + name='gemini' satırıyla temsil edilir (migrasyonsuz).
      // Ücretsiz AI Studio anahtarı: kredi gerektirmeyen bulut katmanı.
      adapter = { ...createGeminiAdapter({ apiKey: config.llm.geminiApiKey }), providerId: row.id };
    } else if (row.kind === "openai" && config.llm.openaiApiKey) {
      adapter = createOpenAiAdapter({ providerId: row.id, apiKey: config.llm.openaiApiKey });
    } else if (row.kind === "openrouter" && config.llm.openrouterApiKey) {
      adapter = { ...createOpenRouterAdapter({ apiKey: config.llm.openrouterApiKey }), providerId: row.id };
    } else if ((row.kind === "ollama" || row.kind === "vllm") && config.llm.ollamaBaseUrl) {
      adapter = { ...createOllamaAdapter({ baseUrl: config.llm.ollamaBaseUrl }), providerId: row.id };
    }
    if (adapter) providers.set(row.id, adapter);
    const rates = pricingDefaultsFor(row.kind);
    if (rates) pricing.set(row.id, rates);
  }
  // A1 (26 §3.1): the DB column wins when an operator has priced a provider in
  // Settings → Providers; compile-time defaults stay the fallback for rows that
  // still carry the empty `{}` default.
  for (const [providerId, table] of await loadProviderPricing(guardedDb)) {
    pricing.set(providerId, table);
  }
  return {
    router: new ModelRouter({ providers, pricing, logCall: logLlmCall }),
    routingFor: createDbRoutingLoader(guardedDb),
  };
}

async function run(): Promise<void> {
  const config = loadConfigOrExit(process.env);
  // Tool Gateway endpoint (17 §1): compose-internal, never the public proxy
  const serverInternalUrl = process.env.SERVER_INTERNAL_URL ?? "http://server:3000";

  const port = Number(process.env.HEALTH_PORT ?? 3020);
  let ready = false;
  const health = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: ready ? "ok" : "starting", service: "agent-worker" }));
      return;
    }
    res.writeHead(404).end();
  });
  health.listen(port, "0.0.0.0");

  const pool = new Pool({ connectionString: config.database.url });
  const guardedDb = createGuardedDb(pool);
  // migrations run in the server's boot — retry briefly on a fresh database
  // (compose also orders worker after server-healthy; this covers races)
  let routerDeps: RouterDeps | null = null;
  for (let attempt = 1; attempt <= 10 && !routerDeps; attempt++) {
    try {
      routerDeps =
        process.env.LLM_MODE === "scripted"
          ? await buildScriptedRouter(pool)
          : await buildLiveRouter(pool, guardedDb, config);
    } catch (err) {
      if (attempt === 10) throw err;
      console.log(JSON.stringify({ msg: "router bootstrap retry", attempt, err: String(err) }));
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  const { router, routingFor } = routerDeps!;

  // LIVE-CONSOLE TASK 2/3: ajan döngüsünün canlı lifecycle olayları —
  // rt.<companyId> ephemeral NATS hattı (kayıplı; truth DB'de kalır)
  const runtimeEvents = createRuntimeEventPublisher(config.nats.url);

  const connection = await NativeConnection.connect({ address: config.temporal.address });
  const { Connection: ClientConnection, Client } = await import("@temporalio/client");
  const clientConnection = await ClientConnection.connect({ address: config.temporal.address });
  const temporalClient = new Client({ connection: clientConnection, namespace: "acos" });
  const { createTemporalSignalPort } = await import("./delivery.js");
  const { startAgentTaskWorkflow, workflowIds } = await import("./client.js");
  const { uuidv7 } = await import("@acos/domain");
  const { createReviewActivities } = await import("./review/activities.js");

  // shared seams (T40/T43): the gateway client + review workflow starter
  const invokeTool = async (req: object) => {
    const res = await fetch(`${serverInternalUrl}/internal/v1/tools/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.security.internalApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      throw new Error(`tool gateway transport failure: ${res.status}`);
    }
    return (await res.json()) as Awaited<
      ReturnType<NonNullable<Parameters<typeof createAgentTaskActivities>[0]["invokeTool"]>>
    >;
  };
  const startReviewWorkflow = async (input: {
    companyId: string;
    reviewId: string;
    taskId: string;
    reviewerAgentId: string;
    authorAgentId: string;
  }) => {
    await temporalClient.workflow
      .start("reviewWorkflow", {
        taskQueue: TASK_QUEUES.agentTasks,
        workflowId: workflowIds.review(input.reviewId),
        args: [input],
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") throw err;
      });
  };

  // E4/T31 (ADR-022): CLI-session runtime ports. Only wired when the broker is
  // configured; otherwise resolveAgentRuntimeActivity keeps every turn on steps.
  const { createCliSessionActivities } = await import("./cli-session/activities.js");
  const { createBrokerClient, createGatewaySessionClient, createSandboxSessionClient } = await import("./cli-session/clients.js");
  const { startTemporalHeartbeat } = await import("./activities/agent-task.js");
  const cliCfg = config.cliRuntime;
  const cliRuntimeEnabled = cliCfg.runtime === "cli" && Boolean(cliCfg.brokerUrl) && Boolean(cliCfg.brokerSecret);
  if (cliCfg.runtime === "cli" && !cliRuntimeEnabled) {
    console.error("agent-worker: ACOS_AGENT_RUNTIME=cli but IDENTITY_BROKER_URL/ACOS_BROKER_SECRET missing — falling back to steps");
  }
  const cliSessionActivities = createCliSessionActivities({
    guardedDb,
    config: {
      runtime: cliRuntimeEnabled ? "cli" : "steps",
      sessionMode: cliCfg.sessionMode,
      workspaceKind: cliCfg.workspaceKind,
      workspaceImage: cliCfg.workspaceImage,
      model: cliCfg.model,
      limits: { maxTotalTokens: cliCfg.maxSessionTokens, maxWallMs: cliCfg.maxSessionMs, maxRequests: cliCfg.maxSessionRequests },
      admissionWaitMs: cliCfg.admissionWaitMs,
      pollMs: 5_000,
      endGraceMs: 8_000,
      cols: 120,
      rows: 32,
    },
    broker: createBrokerClient({ baseUrl: cliCfg.brokerUrl ?? "http://127.0.0.1:3779", token: cliCfg.brokerSecret ?? "" }),
    gateway: createGatewaySessionClient({
      baseUrl: serverInternalUrl,
      token: config.security.internalApiToken,
      containerGatewayUrl: cliCfg.containerGatewayUrl,
    }),
    sandboxSessions: createSandboxSessionClient({ baseUrl: config.sandbox.managerUrl, token: config.security.internalApiToken }),
    sandboxHttp: { baseUrl: config.sandbox.managerUrl, token: config.security.internalApiToken },
    runtimeEvents,
    heartbeat: (detail) => startTemporalHeartbeat(detail),
  });

  const activities = {
    ...trivialActivities,
    ...cliSessionActivities,
    ...createAgentTaskActivities({
      // TASK 13: Context Compiler CodeIndex sorgusu
      codeIndexQuery: async (q) => {
        const res = await fetch(`${serverInternalUrl}/internal/v1/code-index/query`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.security.internalApiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(q),
        });
        if (!res.ok) throw new Error(`code-index query failed (${res.status})`);
        return (await res.json()) as never;
      },
      guardedDb,
      router,
      routingFor,
      runtimeEvents,
      signalPort: createTemporalSignalPort(temporalClient),
      // delegation → child workflow start (09 §4, T36); duplicate = no-op.
      // 2026-08-18 (Founder kararı — ajan başına TEK canlı oturum): meşgul
      // ajana ikinci workflow başlatılmaz; görev ASSIGNED kuyruğunda bekler,
      // oturum kapanınca sunucudaki session-ended drain'i sıradakini başlatır.
      startAgentWorkflow: async ({ companyId, agentId, taskId }) => {
        const { and, eq, inArray } = await import("drizzle-orm");
        const { agentSessions } = await import("@acos/db/schema");
        const [live] = await guardedDb
          .select({ taskId: agentSessions.taskId })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.companyId, companyId),
              eq(agentSessions.agentId, agentId),
              inArray(agentSessions.status, ["starting", "running"]),
            ),
          )
          .limit(1);
        if (live && live.taskId !== taskId) return; // kuyrukta bekler
        await startAgentTaskWorkflow(temporalClient, "agentTaskWorkflow", {
          companyId,
          agentId,
          taskId,
          sessionId: uuidv7(),
          attempt: 1,
        }).catch((err: unknown) => {
          if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") throw err;
        });
      },
      // use_tool → Tool Gateway internal HTTP (T40; S3 single choke point)
      invokeTool,
      // request_review → independent reviewer's reviewWorkflow (T43)
      startReviewWorkflow,
    }),
    ...createReviewActivities({
      guardedDb,
      invokeTool,
      startReviewWorkflow,
      // rework re-entry with the verdict pre-seeded (T43): a DISTINCT
      // workflow id (rework key) so it never races the prior run's close
      startAgentWorkflow: async ({ companyId, agentId, taskId, initialReviewVerdict, reworkKey }) => {
        await temporalClient.workflow
          .start("agentTaskWorkflow", {
            taskQueue: TASK_QUEUES.agentTasks,
            workflowId: `agent-task.${taskId}.${agentId}.rework-${reworkKey ?? "0"}`,
            args: [
              {
                companyId,
                agentId,
                taskId,
                sessionId: uuidv7(),
                attempt: 1,
                ...(initialReviewVerdict && { initialReviewVerdict }),
              },
            ],
          })
          .catch((err: unknown) => {
            if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") throw err;
          });
      },
    }),
  };

  const agentWorker = await Worker.create({
    connection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.agentTasks,
    workflowsPath: require.resolve("./workflows/index.js"),
    activities,
    maxConcurrentWorkflowTaskExecutions: 40,
    maxConcurrentActivityTaskExecutions: 64,
    maxCachedWorkflows: 200,
    shutdownGraceTime: "30s",
  });
  const { createMemoryActivities } = await import("./memory/activities.js");
  const memoryWorker = await Worker.create({
    connection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.memory,
    workflowsPath: require.resolve("./workflows/memory/index.js"),
    // consolidation pipeline (T44; 12 §5) — scripted mode swaps in the canned
    // extractions + pseudo-embeddings (32 §6)
    activities: createMemoryActivities({
      guardedDb,
      router,
      routingFor,
      scripted: process.env.LLM_MODE === "scripted",
    }),
    maxConcurrentActivityTaskExecutions: 8,
    shutdownGraceTime: "30s",
  });
  const { createIntakeControlActivities } = await import("./intake/activities.js");
  const intakeWorker = await Worker.create({
    connection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.intake,
    workflowsPath: require.resolve("./workflows/intake/index.js"),
    activities: createIntakeControlActivities({
      guardedDb,
      // B4 (14 §3.1 stage 3): the interpretive pass over the analyzer output.
      // Absent router ⇒ the deterministic report still ships (P6).
      router,
      routingFor,
      // TASK 9: planning devamı sunucuda (staffing gap + onay + CEO start)
      // E2/W4: "CEO düşünüyor" taslağı — sihirbaz 404 yerine ilerleme görsün
      openStaffingProposal: async (input) => {
        const res = await fetch(`${serverInternalUrl}/internal/v1/staffing/proposal/open`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.security.internalApiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        });
        if (!res.ok) throw new Error(`staffing proposal open failed (${res.status})`);
        return (await res.json()) as { id: string; status: string };
      },
      // E2/W4 (T19): CEO'nun önerdiği kadro planı server'a yazılır
      proposeStaffing: async (input) => {
        const res = await fetch(`${serverInternalUrl}/internal/v1/staffing/proposal`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.security.internalApiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(input),
        });
        if (!res.ok) throw new Error(`staffing proposal failed (${res.status})`);
        return (await res.json()) as { id: string; status: string; teams: unknown[] };
      },
      // E2/W5: onaylanan öneri Agent Factory'ye uygulanır
      applyStaffingProposal: async ({ companyId, proposalId }) => {
        const res = await fetch(`${serverInternalUrl}/internal/v1/staffing/proposal/apply`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.security.internalApiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ companyId, proposalId }),
        });
        if (!res.ok) throw new Error(`staffing proposal apply failed (${res.status})`);
        return (await res.json()) as { hired: number };
      },
      planningContinue: async ({ companyId, projectId }) => {
        const res = await fetch(`${serverInternalUrl}/internal/v1/staffing/continue`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.security.internalApiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ companyId, projectId }),
        });
        if (!res.ok) throw new Error(`planning continue failed (${res.status})`);
        return (await res.json()) as { state: string };
      },
      // TASK 6: greenfield bootstrap — sandbox seed + best-effort GitHub yansısı
      greenfieldBootstrap: async ({ companyId, projectId, name, objective }) => {
        const seedRes = await fetch(
          `${config.sandbox.managerUrl}/internal/v1/repos/seed-greenfield`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.security.internalApiToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ projectId, name, objective }),
          },
        );
        if (!seedRes.ok) throw new Error(`greenfield seed failed (${seedRes.status})`);
        // GitHub yansısı opsiyonel — bağlantı yoksa sunucu sessiz no-op döner
        await fetch(`${serverInternalUrl}/internal/v1/github/publish`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.security.internalApiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ companyId, projectId }),
        }).catch(() => {});
      },
      // TASK 3: READY'den önce senkron tam indeks (INVARIANT 2)
      codeIndexRebuild: async ({ companyId, projectId }) => {
        const res = await fetch(`${serverInternalUrl}/internal/v1/code-index/rebuild`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.security.internalApiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ companyId, projectId }),
        });
        if (!res.ok) throw new Error(`code-index rebuild failed (${res.status})`);
      },
      // routed GOAL → CEO agentTaskWorkflow (09 §4, same port as T36)
      startAgentWorkflow: async ({ companyId, agentId, taskId }) => {
        await startAgentTaskWorkflow(temporalClient, "agentTaskWorkflow", {
          companyId,
          agentId,
          taskId,
          sessionId: uuidv7(),
          attempt: 1,
        }).catch((err: unknown) => {
          if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") throw err;
        });
      },
    }),
    maxConcurrentActivityTaskExecutions: 4,
    shutdownGraceTime: "30s",
  });

  ready = true;
  console.log(
    JSON.stringify({
      msg: "agent-worker up",
      queues: [TASK_QUEUES.agentTasks, TASK_QUEUES.memory, TASK_QUEUES.intake],
      temporal: config.temporal.address,
      llmMode: process.env.LLM_MODE === "scripted" ? "scripted" : "live",
      healthPort: port,
    }),
  );

  const shutdown = () => {
    ready = false;
    agentWorker.shutdown();
    memoryWorker.shutdown();
    intakeWorker.shutdown();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await Promise.all([agentWorker.run(), memoryWorker.run(), intakeWorker.run()]);
  await connection.close();
  await pool.end();
  health.close();
}

run().catch((err) => {
  console.error("agent-worker boot failed:", err);
  process.exit(1);
});
