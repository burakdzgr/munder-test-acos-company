// Boot sequence (T15, 28 §2): config → migrate under advisory lock → routes.
import { Pool } from "pg";
import { WORKFLOW_IDS, loadConfigOrExit } from "@acos/config";
import { createDb, createGuardedDb, runMigrations, WorkspaceService } from "@acos/db";
import { companies } from "@acos/db/schema";
import { connect as natsConnect } from "nats";
import { buildApp } from "./app.js";
import { provisionJetStream } from "./modules/events/jetstream.js";
import { OutboxRelay } from "./modules/events/relay.js";
import { DlqHandler } from "./modules/events/dlq.js";
import { buildCheckers } from "./checkers.js";

async function main(): Promise<void> {
  const config = loadConfigOrExit(process.env);

  await runMigrations(config.database.url); // pg_advisory_lock inside — safe under multi-boot
  const pool = new Pool({ connectionString: config.database.url });

  const guardedDb = createGuardedDb(pool);
  if (config.seedDemo) {
    const { ensureSeed, SEED_FOUNDER_EMAIL } = await import("./seed.js");
    const seeded = await ensureSeed(guardedDb);
    if (seeded.created && seeded.founderPassword) {
      console.log(`ACOS ready — ${SEED_FOUNDER_EMAIL} / ${seeded.founderPassword}`);
    }
  }

  // O9: AUTH_AUTOLOGIN turns the login prompt off entirely — anyone who can
  // reach /api/v1 is served as the Founder. That is the intended single-user
  // mode (2026-08-13), but it must never be the quiet default on an exposed
  // install, so boot says it out loud.
  if (config.security.autologinFounder) {
    const message =
      "AUTH_AUTOLOGIN is ON — every request to /api/v1 is served as the Founder, with no password. " +
      "This is single-user mode. Set AUTH_AUTOLOGIN=false before exposing this install to a network.";
    console.warn(`⚠  ${message}`);
    // REVISION TASK 7 — production fail-closed: kimlik dogrulamasiz bir
    // production boot'u sessizce (veya bir warning'le) ayakta KALMAZ.
    // Tek kullanicili kurulum bilincli olarak AUTH_AUTOLOGIN_ALLOW_PRODUCTION
    // =true ile bu kapiyi acar; digerlerinde boot burada durur.
    if (config.nodeEnv === "production" && !config.security.autologinAllowProduction) {
      console.error(
        "✖  NODE_ENV=production + AUTH_AUTOLOGIN=true: refusing to boot an unauthenticated " +
          "production server. Set AUTH_AUTOLOGIN=false (login flow) or, for a deliberate " +
          "single-user install, AUTH_AUTOLOGIN_ALLOW_PRODUCTION=true.",
      );
      process.exit(1);
    }
  }

  // Açılış mutabakatı: bir önceki süreçle birlikte ölen terminal oturumları
  // `active` kalıyordu ve Founder'ın panelinde günlerce donmuş "açık terminal"
  // olarak duruyordu (23 §13'ün projektör için yaptığı mutabakatın terminal
  // karşılığı). Hayatta kalan oturum canlı olamaz — sahibi olan süreç öldü.
  // Şirket listesi guard'sız db'den okunur: `companies` kiracı tablosu
  // değil, kiracının KÖKÜDÜR — company_id yüklemi diye bir şeyi yoktur.
  // Mutabakat, tek tek şirket kimliğiyle yürür (S4).
  try {
    const companyRows = await createDb(pool).select({ id: companies.id }).from(companies);
    const orphaned = await new WorkspaceService(guardedDb).closeOrphanedTerminals(
      companyRows.map((c) => c.id),
    );
    if (orphaned > 0) {
      console.log(`terminal reconciliation — closed ${orphaned} orphaned session(s)`);
    }
  } catch (err) {
    // Mutabakat bir KOLAYLIKTIR, açılış şartı değil: burada patlamak
    // sunucuyu hiç ayağa kaldırmamak demek olurdu (ilk sürümde tam olarak
    // bu oldu — bir S4 ihlali bütün boot'u düşürdü).
    console.warn("terminal reconciliation skipped:", (err as Error).message);
  }

  // Grant mutabakatı (2026-08-18): seedToolGrants yalnız SEED şirketine
  // koşuyordu — sihirbazla kurulan şirketin CEO'su ilk görevinde
  // NO_PERMISSION_GRANT'e çarpıyor ve Founder'dan izin dilemek zorunda
  // kalıyordu. Liste (tool, subject) bazında idempotent; bilinen birim
  // slug'ı olmayan şirkette hiçbir satır eşleşmez, yani zararsız.
  try {
    const { seedToolGrants } = await import("./seed.js");
    const { companyContext } = await import("@acos/db");
    const companyRows = await createDb(pool).select({ id: companies.id }).from(companies);
    for (const row of companyRows) {
      await seedToolGrants(guardedDb, companyContext(row.id));
    }
  } catch (err) {
    console.warn("tool-grant reconciliation skipped:", (err as Error).message);
  }

  const app = await buildApp({
    db: createDb(pool),
    guardedDb,
    masterKey: config.security.masterKey,
    internalApiToken: config.security.internalApiToken,
    autologinFounder: config.security.autologinFounder,
    sandboxManagerUrl: config.sandbox.managerUrl,
    mcpPublicUrl: config.agentRuntime.mcpPublicUrl,
    maxLiveSessionsPerCompany: config.agentRuntime.maxLiveSessionsPerCompany,
    healthCheckers: buildCheckers({
      pool,
      natsUrl: config.nats.url,
      temporalAddress: config.temporal.address,
    }),
    version: process.env.npm_package_version ?? "0.0.0",
  });

  // Tool Gateway dispatch arm (T40): workspace tools execute via
  // sandbox-manager; the gateway stays the only caller (S3)
  const { createSandboxDispatchPort } = await import("./modules/tools/dispatch.js");
  app.toolDispatchPort = createSandboxDispatchPort({
    guardedDb,
    masterKey: config.security.masterKey,
    sandboxManagerUrl: config.sandbox.managerUrl,
    internalApiToken: config.security.internalApiToken,
    // B3': db.inspect must never be aimed at the platform DB (every company's rows)
    platformDatabaseUrl: config.database.url,
    // B2': network tools leave only through the egress allowlist (27 §12, S8)
    egressProxyUrl: config.sandbox.egressProxyUrl,
    ...(process.env.SEARCH_API_URL && { searchApiUrl: process.env.SEARCH_API_URL }),
    // GitHub yansıması: merge main'e girince dış remote'a best-effort push
    onMergeCompleted: (companyId, projectId, mergeCommit, mergedTaskId) => {
      void (async () => {
        // CodeIndex incremental (REVISION TASK 4): yalnız diff'teki dosyalar
        if (mergeCommit) {
          const { updateCodeIndexFromMerge } = await import("./modules/code-index/service.js");
          await updateCodeIndexFromMerge(
            {
              guardedDb,
              sandbox: { url: config.sandbox.managerUrl, token: config.security.internalApiToken },
            },
            companyId,
            projectId,
            mergeCommit,
            `${mergeCommit}~1`,
          )
            .then((r) => {
              if (r.filesIndexed > 0 || r.filesRemoved > 0) {
                app.log.info({ projectId, ...r }, "code index updated after merge");
              }
            })
            .catch((err: unknown) =>
              app.log.warn({ err, projectId }, "code index incremental update failed"),
            );
          // TASK 5: merge sonrası görevin overlay katmanı düşer
          if (mergedTaskId) {
            const { deleteTaskOverlayIndex } = await import("./modules/code-index/service.js");
            await deleteTaskOverlayIndex(
              {
                guardedDb,
                sandbox: {
                  url: config.sandbox.managerUrl,
                  token: config.security.internalApiToken,
                },
              },
              companyId,
              projectId,
              mergedTaskId,
            ).catch(() => {});
          }
        }
        const { publishProjectToGithub } = await import("./modules/integrations/github.js");
        const result = await publishProjectToGithub({
          db: guardedDb,
          masterKey: config.security.masterKey,
          sandbox: { url: config.sandbox.managerUrl, token: config.security.internalApiToken },
          companyId,
          projectId,
        });
        if (result.published) {
          app.log.info({ projectId, remoteUrl: result.remoteUrl }, "github publish after merge");
        }
      })().catch((err) => app.log.warn({ err, projectId }, "github publish failed"));
    },
  });

  // message delivery signalling (11 §4.4, T33): best-effort Temporal client —
  // messages stay durable without it, agents just poll their thread slice
  let temporalClientRef: import("@temporalio/client").Client | null = null;
  try {
    const { Client, Connection } = await import("@temporalio/client");
    const temporalConnection = await Connection.connect({ address: config.temporal.address });
    const temporalClient = new Client({ connection: temporalConnection, namespace: "acos" });
    temporalClientRef = temporalClient;
    app.commsSignalPort = {
      async signalActiveSession({ workflowId, item }) {
        try {
          await temporalClient.workflow.getHandle(workflowId).signal("messageReceived", item);
          return true;
        } catch {
          return false;
        }
      },
      // T38: cozulen bekleyis, canli workflow YOKKEN de sahibinin turunu
      // yeniden baslatir. Starter tek-canli-oturum kapisini ve sirket tavanini
      // zaten uyguluyor; kapi reddederse gorev ASSIGNED kuyrugunda bekler.
      async startAgentTurn({ companyId, agentId, taskId }) {
        await app.agentWorkflowStarter?.({ companyId, agentId, taskId });
      },
      async signalInbox({ companyId, agentId, item }) {
        await temporalClient.workflow.signalWithStart("agentInboxWorkflow", {
          taskQueue: "agent-tasks",
          workflowId: `agent-inbox.${agentId}`,
          args: [{ companyId, agentId }],
          signal: "inboxItem",
          signalArgs: [item],
        });
      },
    };
    app.approvalSignalPort = async ({ workflowId, approvalId, verdict, note }) => {
      try {
        await temporalClient.workflow
          .getHandle(workflowId)
          .signal("approvalVerdict", { approvalId, verdict, note });
        return true;
      } catch (err) {
        // workflow already finished/cancelled — the DB verdict stays authoritative (19 §7)
        app.log.warn({ err, workflowId, approvalId }, "approvalVerdict signal undeliverable");
        return false;
      }
    };
    const { createAgentWorkflowStarter } = await import("./modules/workflows/client.js");
    app.agentWorkflowStarter = createAgentWorkflowStarter(
      temporalClient,
      (err, input) => app.log.warn({ err, ...input }, "agentTaskWorkflow start failed"),
      guardedDb, // ajan başına tek canlı oturum kapısı (kuyruk)
      config.agentRuntime.maxLiveSessionsPerCompany, // E4/A: şirket eşzamanlılık tavanı
    );
    // T53: request_review → incelemecinin reviewWorkflow'u. Sunucu bu workflow'u
    // ZATEN başlatabiliyordu (aşağıda sweep'in `review_reopened` bulgusu için),
    // eksik olan yalnızca MCP dispatcher'ın dep'iydi — CLI şeridinde inceleme
    // zincirinin hiç başlamamasının tek sebebi buydu.
    const { createReviewWorkflowStarter } = await import("./modules/workflows/client.js");
    app.reviewWorkflowStarter = createReviewWorkflowStarter(
      temporalClient,
      (err, input) => app.log.warn({ err, ...input }, "reviewWorkflow start failed"),
    );
    // project creation → projectIntakeWorkflow on the intake queue (T42)
    app.intakeStarter = async ({ companyId, projectId, source }) => {
      await temporalClient.workflow
        .start("projectIntakeWorkflow", {
          taskQueue: "intake",
          workflowId: `intake.${projectId}`,
          args: [{ companyId, projectId, source }],
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") {
            throw err;
          }
        });
    };
    // TASK 18: imported READY → kullanıcı hedefi → analiz + planlama akışı
    app.goalStarter = async ({ companyId, projectId, projectName, objective, constraints }) => {
      await temporalClient.workflow
        .start("projectGoalWorkflow", {
          taskQueue: "intake",
          workflowId: `goal.${projectId}.${Date.now()}`,
          args: [{ companyId, projectId, projectName, objective, constraints }],
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") {
            throw err;
          }
        });
    };
    // E2/W5: Founder onayı, öneriyi BEKLEYEN planlama iş akışını uyandırır.
    // workflowId öneri satırında durur — akış id'si zamana bağlı üretildiği
    // için tahmin edilemez, o yüzden öneriyi yazan aktivite kendi id'sini
    // kaydeder ve onay ucu onu okur.
    app.proposalSignaller = async ({ workflowId, proposalId, decision }) => {
      await temporalClient.workflow
        .getHandle(workflowId)
        .signal("staffingProposalDecided", { proposalId, decision });
    };
    app.log.info("comms delivery signal port attached (Temporal)");
  } catch (err) {
    app.log.error({ err }, "Temporal unavailable — comms delivery signalling disabled");
  }

  // cost rollup refresh (26 §7, T49): every 5 min — the server interval is a
  // recorded narrowing of the Temporal-cron scheduler activity
  const { sql: rawSql } = await import("drizzle-orm");
  const rollupDb = createDb(pool);
  const rollupRefresh = setInterval(() => {
    rollupDb
      .execute(rawSql`REFRESH MATERIALIZED VIEW cost_rollup_daily`)
      .catch((err) => app.log.error({ err }, "cost rollup refresh failed"));
  }, 300_000);

  // retrieval-count batch (12 §7.4, T45): every 60s aggregate UNLOGGED
  // memory_retrievals into memories.retrieval_count + 14-day sweep
  const { applyRetrievalCounts } = await import("@acos/db");
  const retrievalDb = createDb(pool);
  const retrievalBatch = setInterval(() => {
    applyRetrievalCounts(retrievalDb).catch((err) =>
      app.log.error({ err }, "retrieval-count batch failed"),
    );
  }, 60_000);

  // approval expiry + reminder sweep (19 §6, T35): every 30s; expired rows
  // deliver verdict `expired` (= rejected semantics) into waiting workflows
  const { sweepApprovals } = await import("@acos/db");
  const sweepDb = createDb(pool);
  const approvalSweep = setInterval(() => {
    void (async () => {
      const result = await sweepApprovals(sweepDb, guardedDb);
      for (const expired of result.expired) {
        if (expired.workflowId && app.approvalSignalPort) {
          await app.approvalSignalPort({
            workflowId: expired.workflowId,
            approvalId: expired.approvalId,
            verdict: "expired",
          });
        }
      }
    })().catch((err) => app.log.error({ err }, "approval sweep failed"));
  }, 30_000);

  // D4 — per-project egress allowlist (27 §12). The include is rendered from
  // projects.settings.egressDomains onto the volume the proxy reads; squid's
  // own watcher reloads only when the file actually changes. Polling keeps
  // this correct no matter WHERE the settings changed (API, agent, seed).
  const egressIncludePath = process.env.EGRESS_INCLUDE_PATH;
  const egressSweep = egressIncludePath
    ? setInterval(() => {
        void (async () => {
          const { writeEgressInclude } = await import("./modules/projects/egress.js");
          if (await writeEgressInclude(sweepDb, egressIncludePath)) {
            app.log.info({ path: egressIncludePath }, "egress allowlist include rewritten");
          }
        })().catch((err) => app.log.error({ err }, "egress include render failed"));
      }, 30_000)
    : null;
  if (egressIncludePath) {
    // boot: the proxy must not run a stale allowlist while we wait for a tick
    const { writeEgressInclude } = await import("./modules/projects/egress.js");
    await writeEgressInclude(sweepDb, egressIncludePath).catch((err: unknown) =>
      app.log.error({ err }, "initial egress include render failed"),
    );
  }

  // A6 — stuck-task sweep (09 §9 Schedules: `stuck-task-sweep`, every 30m;
  // 07 §7–8). Work only ever advanced from three places: an HTTP route, a
  // `delegate_task`, and intake. A task parked in WAITING (guard, dependency,
  // approval) had NOTHING to pull it back, and if the owner's workflow had
  // died the task sat there forever with no sign of it anywhere. The interval
  // is the same recorded narrowing of the Temporal-cron scheduler the other
  // three sweeps use.
  const { sweepStuckTasks, describeStuckTask } = await import("@acos/db");
  const stuckSweep = setInterval(() => {
    void (async () => {
      const result = await sweepStuckTasks(sweepDb, guardedDb);
      for (const finding of result.findings) {
        app.log.warn(
          { taskId: finding.taskId, kind: finding.kind, stuckForMs: finding.stuckForMs },
          describeStuckTask(finding),
        );
        // P0-2: kadro tamamlanınca yeniden açılan inceleme — reviewer'ın
        // reviewWorkflow'u burada başlar (worker main'deki starter ile aynı
        // id şeması: review.<reviewId>; duplicate start yutulur)
        // T53: `review_never_started` de aynı işlemi ister — incelemeci atanmış
        // ama turu hiç açılmamış. Aynı `review.<reviewId>` id'si kullanıldığı
        // için dispatcher ile sweep yarışırsa ikinci başlatma zararsız yutulur.
        if (
          (finding.kind === "review_reopened" || finding.kind === "review_never_started") &&
          finding.review &&
          temporalClientRef
        ) {
          await temporalClientRef.workflow
            .start("reviewWorkflow", {
              taskQueue: "agent-tasks",
              workflowId: WORKFLOW_IDS.review(finding.review.reviewId),
              args: [
                {
                  companyId: finding.companyId,
                  reviewId: finding.review.reviewId,
                  taskId: finding.taskId,
                  reviewerAgentId: finding.review.reviewerAgentId,
                  authorAgentId: finding.review.authorAgentId,
                },
              ],
            })
            .catch((err: unknown) => {
              if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") {
                app.log.error({ err, taskId: finding.taskId }, "review reopen start failed");
              }
            });
          continue;
        }
        // the owner's loop is gone → restart it, otherwise the escalation
        // event alone would just tell the Founder about a task nobody works
        if (finding.needsWorkflowRestart && finding.ownerAgentId && app.agentWorkflowStarter) {
          await app
            .agentWorkflowStarter({
              companyId: finding.companyId,
              agentId: finding.ownerAgentId,
              taskId: finding.taskId,
            })
            .catch((err: unknown) =>
              app.log.error({ err, taskId: finding.taskId }, "stuck-task workflow restart failed"),
            );
        }
      }
      if (result.findings.length > 0) {
        app.log.info(
          { stuck: result.findings.length, blocked: result.blocked },
          "stuck-task sweep finished",
        );
      }
    })().catch((err) => app.log.error({ err }, "stuck-task sweep failed"));
  }, 30 * 60_000);

  const nats = await natsConnect({ servers: config.nats.url }).catch((err: unknown) => {
    app.log.error({ err }, "NATS unavailable at boot — outbox relay disabled");
    return null;
  });
  let relay: OutboxRelay | null = null;
  let dlq: DlqHandler | null = null;
  let memoryTrigger: import("./modules/memory/trigger.js").MemoryTriggerHandle | null = null;
  let breakerConsumer:
    | import("./modules/costs/breaker-consumer.js").BreakerConsumerHandle
    | null = null;
  let dependencyBridge:
    | import("./modules/tasks/dependency-signal.js").DependencyBridgeHandle
    | null = null;
  if (nats) {
    app.attachOfficeNats?.(nats); // projector publishes office.* (T25)
    app.realtime?.attachNats(nats); // /ws live fanout (T23)
    await provisionJetStream(nats);
    relay = new OutboxRelay({
      connectionString: config.database.url,
      nats,
      onError: (err) => app.log.error({ err }, "outbox relay error"),
    });
    await relay.start();
    dlq = new DlqHandler(nats, createDb(pool));
    await dlq.start();
    app.log.info("outbox relay + DLQ handler started");

    // Kuyruk drain'i (2026-08-18, Founder kararı — ajan başına tek oturum):
    // oturum kapanınca aynı ajanın EN ESKİ ASSIGNED görevi başlatılır.
    // Starter'daki tek-oturum kapısıyla birlikte "aynı kişiye iki iş →
    // sıraya girer, tek tek ilerler" davranışını verir; 30 dk'lık stuck
    // sweep yedek ağdır (drain kaçarsa görevi o yakalar).
    void (async () => {
      // REVISION TASK 1: sıradaki iş artık salt FIFO değil — öncelik
      // (P0 önce) + çözülmemiş bağımlılığı olan görevleri atlayan
      // Scheduler seçicisi (pickNextQueuedTaskId) kullanılır.
      const { pickNextQueuedTaskId } = await import("@acos/db");
      const drainSub = nats.subscribe("co.>");
      for await (const message of drainSub) {
        try {
          const envelope = JSON.parse(new TextDecoder().decode(message.data)) as {
            type?: string;
            companyId?: string;
            payload?: { sessionId?: string };
            subject?: { agentId?: string | null };
          };
          // CodeIndex tam indeks artık intake workflow'unun SENKRON kapısı
          // (TASK 3, /internal/v1/code-index/rebuild) — olay tabanlı kopya
          // yalnız yedek ağ olarak durur ve sha-skip ile ucuzdur.
          if (envelope.type === "project.imported" && envelope.companyId) {
            const projectId = (envelope as { payload?: { projectId?: string } }).payload
              ?.projectId;
            if (projectId) {
              const { rebuildCodeIndex } = await import("./modules/code-index/service.js");
              void rebuildCodeIndex(
                {
                  guardedDb,
                  sandbox: {
                    url: config.sandbox.managerUrl,
                    token: config.security.internalApiToken,
                  },
                },
                envelope.companyId,
                projectId,
              )
                .then((r) => app.log.info({ projectId, ...r }, "code index built after intake"))
                .catch((err: unknown) =>
                  app.log.warn({ err, projectId }, "code index intake build failed"),
                );
            }
            continue;
          }
          if (envelope.type !== "agent.session.ended") continue;
          const agentId = envelope.subject?.agentId;
          const companyId = envelope.companyId;
          if (!agentId || !companyId || !app.agentWorkflowStarter) continue;
          // Önce kapanan ajanın KENDİ kuyruğu (2026-08-18 davranışı aynen).
          const nextId = await pickNextQueuedTaskId(guardedDb, companyId, agentId);
          if (nextId) {
            const started = await app.agentWorkflowStarter({ companyId, agentId, taskId: nextId });
            if (started) app.log.info({ agentId, taskId: nextId }, "queued task drained");
          }
          // E4/A (T30): şirket tavanı altında boşalan kapasite SADECE bu ajanın
          // kuyruğuna gitmemeli — tavanı dolduranların arkasında bekleyen iş
          // yoksa süresiz bekler. Kalan kapasite kadar, öncelik/yaş sırasıyla,
          // canlı oturumu olmayan ajanların işleri başlatılır.
          const { pickCompanyQueuedTasks } = await import("@acos/db");
          const liveNow = await guardedDb.execute(
            rawSql`SELECT count(*)::int AS n FROM agent_sessions
                    WHERE company_id = ${companyId} AND status IN ('starting','running')`,
          );
          const live = Number((liveNow.rows[0] as { n: number }).n);
          const free = config.agentRuntime.maxLiveSessionsPerCompany - live;
          for (const queued of await pickCompanyQueuedTasks(guardedDb, companyId, free)) {
            const started = await app.agentWorkflowStarter({ companyId, ...queued });
            if (started) {
              app.log.info({ ...queued, live, free }, "company capacity drained");
            }
          }
        } catch (err) {
          app.log.warn({ err }, "session-ended drain failed");
        }
      }
    })();

    // 12 §5.0 triggers → memoryConsolidationWorkflow (T44/M1) — rides the T21
    // memory-trigger durable; the deterministic workflow id
    // `memory-consolidation-<companyId>-<triggerRef>` dedupes (12 §5)
    if (temporalClientRef) {
      const temporalClient = temporalClientRef;
      const { startMemoryTrigger } = await import("./modules/memory/trigger.js");
      const { ExecutiveReportService, companyContext: reportCtx } = await import("@acos/db");
      const { CompanyService } = await import("./modules/companies/service.js");
      const reportService = new ExecutiveReportService(guardedDb);
      const companyService = new CompanyService(guardedDb);
      memoryTrigger = await startMemoryTrigger({
        nats,
        // demo 23–24 (T49): terminal task → project-completion check → the
        // CEO's executive report (artifact + Founder DM)
        onTaskTerminal: async ({ companyId, taskId }) => {
          await reportService
            .onTaskTerminal(reportCtx(companyId), taskId)
            .catch((err) => app.log.error({ err, taskId }, "executive report hook failed"));
        },
        // 12 §5.0 row 2: N comes from the existing company setting, not a new one
        thresholdFor: async (companyId) => {
          const settings = await companyService.getSettings(reportCtx(companyId));
          return settings?.consolidationEventThreshold ?? 25;
        },
        start: async ({ companyId, taskId, agentId, sourceEventIds, trigger, triggerRef }) => {
          await temporalClient.workflow
            .start("memoryConsolidationWorkflow", {
              taskQueue: "memory",
              workflowId: `memory-consolidation-${companyId}-${triggerRef}`,
              args: [{ companyId, taskId, agentId, sourceEventIds, trigger }],
            })
            .catch((err: unknown) => {
              if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") {
                throw err;
              }
            });
        },
        onError: (err) => app.log.error({ err }, "memory-trigger consumer error"),
      });
      app.log.info("memory-trigger consumer started");

      // 26 §5 madde 3: kesicinin ikinci yarısı — koşan oturumlara
      // managerDirective(pause). Veritabanı yarısı (agents → paused)
      // CostService.tripBreaker'da; o satırı koşan workflow okumadığı için
      // kesici tek başına bir sonraki adımı durdurmuyordu.
      const { startBreakerConsumer } = await import("./modules/costs/breaker-consumer.js");
      const { agentSessions } = await import("@acos/db/schema");
      const { and: sqlAnd, eq: sqlEq, inArray, sql: rawSql } = await import("drizzle-orm");
      // workflow id'yi yeniden kurmuyoruz: oturum satırı onu zaten taşıyor
      // (agent_sessions.workflow_id NOT NULL), yani kimlik kuralı değişse
      // bile sinyal doğru workflow'a gider.
      const liveSessions = async (companyId: string, agentIds: string[]) =>
        agentIds.length === 0
          ? []
          : guardedDb
              .select({ workflowId: agentSessions.workflowId, agentId: agentSessions.agentId })
              .from(agentSessions)
              .where(
                sqlAnd(
                  sqlEq(agentSessions.companyId, companyId),
                  inArray(agentSessions.agentId, agentIds),
                  rawSql`${agentSessions.status} IN ('starting','running','waiting')`,
                ),
              );
      breakerConsumer = await startBreakerConsumer({
        nats,
        signal: async ({ companyId, agentIds, directive, reason }) => {
          for (const session of await liveSessions(companyId, agentIds)) {
            if (!session.workflowId) continue;
            await temporalClient.workflow
              .getHandle(session.workflowId)
              .signal("managerDirective", { directive, reason })
              // bitmiş/hiç başlamamış workflow: ajan satırı zaten paused,
              // yeni başlatmalar onu görür (26 §5 "new workflow starts refused")
              .catch((err: unknown) =>
                app.log.debug({ err, agentId: session.agentId }, "managerDirective undeliverable"),
              );
          }
        },
        // budget.restored: kesicinin duraklattıkları restoreBudget içinde zaten
        // `active`e döndü; sinyal onların park edilmiş döngülerini uyandırır.
        // Zaten koşan bir döngüye resume göndermek etkisiz — güvenli.
        resumedAgentIds: async (companyId) => {
          const rows = await guardedDb
            .select({ id: agentSessions.agentId })
            .from(agentSessions)
            .where(
              sqlAnd(
                sqlEq(agentSessions.companyId, companyId),
                rawSql`${agentSessions.status} IN ('starting','running','waiting')`,
              ),
            );
          return [...new Set(rows.map((r) => r.id))];
        },
        onError: (err) => app.log.error({ err }, "breaker consumer error"),
      });
      app.log.info("cost circuit-breaker consumer started");

      // A4 (07 §3): "when a predecessor reaches DONE … signals
      // `dependencyResolved` into every waiting dependent workflow". The emit
      // and the handler both existed; nothing sent the signal, so a blocked
      // task only ever woke on its own timeout.
      const { startDependencySignalBridge } = await import("./modules/tasks/dependency-signal.js");
      dependencyBridge = await startDependencySignalBridge({
        nats,
        signal: async ({ companyId, taskId, dependsOnTaskId, result }) => {
          const sessions = await guardedDb
            .select({ workflowId: agentSessions.workflowId })
            .from(agentSessions)
            .where(
              sqlAnd(
                sqlEq(agentSessions.companyId, companyId),
                sqlEq(agentSessions.taskId, taskId),
                rawSql`${agentSessions.status} IN ('starting','running','waiting')`,
              ),
            );
          for (const session of sessions) {
            if (!session.workflowId) continue;
            await temporalClient.workflow
              .getHandle(session.workflowId)
              .signal("dependencyResolved", { dependsOnTaskId, result })
              // fire-and-forget (09 §9): the dependency row is already
              // resolved in the DB, and the stuck-task sweep picks up a task
              // whose workflow is gone
              .catch((err: unknown) =>
                app.log.debug({ err, taskId }, "dependencyResolved signal undeliverable"),
              );
          }
        },
        onError: (err) => app.log.error({ err }, "dependency signal bridge error"),
      });
      app.log.info("dependency signal bridge started");
    }
  }

  const close = async () => {
    clearInterval(approvalSweep);
    clearInterval(stuckSweep);
    if (egressSweep) clearInterval(egressSweep);
    clearInterval(retrievalBatch);
    clearInterval(rollupRefresh);
    await memoryTrigger?.stop().catch(() => {});
    await breakerConsumer?.stop().catch(() => {});
    await dependencyBridge?.stop().catch(() => {});
    await relay?.stop();
    await dlq?.stop();
    await nats?.close().catch(() => {});
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);

  await app.listen({ port: config.serverPort, host: "0.0.0.0" });
  app.log.info({ port: config.serverPort }, "ACOS server up");
}

main().catch((err) => {
  console.error("server boot failed:", err);
  process.exit(1);
});
