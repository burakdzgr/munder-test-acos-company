// T33 acceptance: a message to an IDLE agent wakes its inbox workflow
// (signalWithStart → triage → mark-read); a message to an ACTIVE agent
// delivers the messageReceived signal and wakes its wait_for(reply); the
// message row + agent.message.sent event are durable before any delivery
// (demo step 14).
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq, sql } from "drizzle-orm";
import { Client, Connection } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { uuidv7 } from "@acos/domain";
import {
  ChannelService,
  MessageService,
  companyContext,
  createDb,
  createGuardedDb,
  deliverMessage,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agents,
  channelMembers,
  channels,
  companies,
  events,
  messages,
  modelProviders,
  orgUnits,
  positions,
  tasks,
  users,
} from "@acos/db/schema";
import { ModelRouter, type ProviderAdapter } from "@acos/llm";
import { loadScript } from "@acos/llm/testing";
import { createScriptedAdapter } from "@acos/llm/testing";
import { TASK_QUEUES } from "@acos/config";
import { createAgentTaskActivities } from "../../src/activities/agent-task.js";
import { createTemporalSignalPort } from "../../src/delivery.js";
import { startPostgres, startTemporal } from "./helpers";

const require = createRequire(import.meta.url);
const workflowsPath = require.resolve("../../src/workflows/index.ts");

// waiter script: start → wait for a reply → then hand off to review
const WAITER_SCRIPT = `
match: { role: waiter-dev, taskFixture: wait-for-reply }
steps:
  - action: update_task_status
    args: { status: IN_PROGRESS }
  - action: wait_for
    args: { what: reply, timeoutMinutes: 60 }
  - action: request_review
    args: { summary: woke up after the reply }
`;

let pgContainer: Awaited<ReturnType<typeof startPostgres>>;
let temporal: Awaited<ReturnType<typeof startTemporal>>;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let nativeConnection: NativeConnection;
let clientConnection: Connection;
let client: Client;
let worker: Worker;
let workerRun: Promise<void>;
let channelService: ChannelService;
let messageService: MessageService;

let companyId = "";
let ACTIVE = ""; // agent with a running workflow (waits for a reply)
let IDLE = ""; // agent with no workflow — inbox path
let taskId = "";
const sessionId = uuidv7();

beforeAll(async () => {
  [pgContainer, temporal] = await Promise.all([startPostgres(), startTemporal()]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  channelService = new ChannelService(guardedDb);
  messageService = new MessageService(guardedDb, channelService);

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t33.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "CommsCo", slug: "commsco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "department", name: "Eng", slug: "eng" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "waiter-dev" })
    .returning();
  const hire = async (name: string, employeeNumber: number) =>
    (
      await db
        .insert(agents)
        .values({
          companyId,
          employeeNumber,
          name,
          status: "active",
          positionId: position!.id,
          orgUnitId: unit!.id,
          seniority: "mid",
          autonomyLevel: 2,
          persona: `${name}.`,
        })
        .returning()
    )[0]!.id;
  ACTIVE = await hire("Wanda Waiter", 1);
  IDLE = await hire("Ivan Idle", 2);
  const [task] = await db
    .insert(tasks)
    .values({
      companyId,
      number: 1,
      kind: "task",
      title: "Wait for input",
      objective: "Waits.",
      status: "ASSIGNED",
      ownerAgentId: ACTIVE,
      successCriteria: ["done"],
      context: { taskFixture: "wait-for-reply" },
    })
    .returning();
  taskId = task!.id;
  // the manual insert above bypassed the counter — seed it so
  // TasksService.create allocates from 2 (gap-free from here on)
  const { companySequences } = await import("@acos/db/schema");
  await db.insert(companySequences).values({ companyId, name: "task_number", value: 1 });

  const [provider] = await db
    .insert(modelProviders)
    .values({ kind: "ollama", name: "scripted" })
    .returning();
  const adapter: ProviderAdapter = {
    ...createScriptedAdapter([loadScript(WAITER_SCRIPT)], { taskId }),
    providerId: provider!.id,
  };
  const router = new ModelRouter({
    providers: new Map([[provider!.id, adapter]]),
    logCall: () => {},
  });

  nativeConnection = await NativeConnection.connect({ address: temporal.address });
  clientConnection = await Connection.connect({ address: temporal.address });
  client = new Client({ connection: clientConnection, namespace: "acos" });

  const activities = createAgentTaskActivities({
    guardedDb,
    router,
    routingFor: async () => ({
      bindings: [],
      profiles: [{ purpose: "reasoning", providerId: provider!.id, model: "scripted" }],
    }),
    signalPort: createTemporalSignalPort(client),
  });
  worker = await Worker.create({
    connection: nativeConnection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.agentTasks,
    workflowsPath,
    activities: activities as unknown as Record<string, (...args: never[]) => unknown>,
  });
  workerRun = worker.run();
}, 300_000);

afterAll(async () => {
  worker?.shutdown();
  await workerRun?.catch(() => {});
  await clientConnection?.close();
  await nativeConnection?.close();
  await pool?.end();
  await pgContainer?.stop();
  await temporal?.container.stop();
});

const signalPort = () => createTemporalSignalPort(client);

describe("comms + signals (T33)", () => {
  it("persists the message + agent.message.sent BEFORE delivery (demo step 14)", async () => {
    const dm = await channelService.getOrCreateDm(ctx, null, IDLE);
    const plan = await messageService.send(ctx, {
      channelId: dm.id,
      senderAgentId: null,
      kind: "text",
      body: "Hello from the Founder",
      idempotencyKey: uuidv7(),
    });
    const [row] = await db
      .select()
      .from(messages)
      .where(and(eq(messages.companyId, companyId), eq(messages.id, plan.message.id)));
    expect(row).toBeDefined();
    const sent = await db
      .select()
      .from(events)
      .where(sql`${events.companyId} = ${companyId} AND ${events.type} = 'agent.message.sent'`);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    // dm get-or-create is stable
    const again = await channelService.getOrCreateDm(ctx, null, IDLE);
    expect(again.id).toBe(dm.id);
    // replay with the same idempotency key returns the same row, no new event
    const replay = await messageService.send(ctx, {
      channelId: dm.id,
      senderAgentId: null,
      kind: "text",
      body: "Hello from the Founder",
      idempotencyKey: plan.message.id,
    });
    expect(replay.message.id).toBe(plan.message.id);
    expect(replay.recipients).toHaveLength(0);
  });

  it("a message to an IDLE agent wakes its inbox workflow (triage + mark-read)", async () => {
    const dm = await channelService.getOrCreateDm(ctx, null, IDLE);
    const plan = await messageService.send(ctx, {
      channelId: dm.id,
      senderAgentId: null,
      kind: "text",
      body: "Are you there?",
      idempotencyKey: uuidv7(),
    });
    expect(plan.recipients.map((r) => r.agentId)).toEqual([IDLE]);
    await deliverMessage(guardedDb, ctx, plan, signalPort());

    // the inbox workflow exists and processes the item (5s debounce + triage)
    const handle = client.workflow.getHandle(`agent-inbox.${IDLE}`);
    const description = await handle.describe();
    expect(["RUNNING", "COMPLETED"]).toContain(description.status.name);

    // triage(ignore) marks the channel read for the recipient
    const deadline = Date.now() + 30_000;
    let lastRead: Date | null = null;
    while (Date.now() < deadline) {
      const [membership] = await db
        .select()
        .from(channelMembers)
        .where(
          and(
            eq(channelMembers.companyId, companyId),
            eq(channelMembers.channelId, dm.id),
            eq(channelMembers.agentId, IDLE),
          ),
        );
      lastRead = membership?.lastReadAt ?? null;
      if (lastRead) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(lastRead).not.toBeNull();
  }, 60_000);

  it("a message to an ACTIVE agent delivers the signal and wakes wait_for(reply)", async () => {
    const execution = client.workflow.execute("agentTaskWorkflow", {
      taskQueue: TASK_QUEUES.agentTasks,
      workflowId: `agent-task.${taskId}.${ACTIVE}`,
      args: [{ companyId, agentId: ACTIVE, taskId, sessionId, attempt: 1 }],
    });

    // wait until the task parks in WAITING (wait_for reply)
    const deadline = Date.now() + 60_000;
    for (;;) {
      const [task] = await db
        .select({ status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)));
      if (task!.status === "WAITING") break;
      if (Date.now() > deadline) throw new Error(`never reached WAITING (now ${task!.status})`);
      await new Promise((r) => setTimeout(r, 500));
    }

    // the task thread was auto-provisioned? (direct insert bypassed the
    // service) — open a DM instead: ACTIVE has a live session, so delivery
    // must go the SIGNAL path, not the inbox
    const dm = await channelService.getOrCreateDm(ctx, null, ACTIVE);
    const plan = await messageService.send(ctx, {
      channelId: dm.id,
      senderAgentId: null,
      kind: "text",
      body: "Here is the input you were waiting for",
      idempotencyKey: uuidv7(),
    });
    await deliverMessage(guardedDb, ctx, plan, signalPort());

    // the signal wakes the workflow; the script then hands off to review
    const result = await execution;
    expect(result).toMatchObject({ outcome: "review_requested" });
    const [task] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId)));
    expect(task!.status).toBe("REVIEW");

    // no inbox workflow was started for the ACTIVE agent — signal path won
    await expect(client.workflow.getHandle(`agent-inbox.${ACTIVE}`).describe()).rejects.toThrow();

    // status trail includes the WAITING round-trip driven by wait_for
    const trail = await db
      .select()
      .from(events)
      .where(
        sql`${events.companyId} = ${companyId} AND ${events.type} = 'task.status.changed' AND ${events.taskId} = ${taskId}`,
      )
      .orderBy(events.seq);
    expect(
      trail.map((e) => `${(e.payload as { from: string }).from}→${(e.payload as { to: string }).to}`),
    ).toEqual(["ASSIGNED→IN_PROGRESS", "IN_PROGRESS→WAITING", "WAITING→IN_PROGRESS", "IN_PROGRESS→REVIEW"]);
  }, 120_000);

  it("guard (e): >8 strictly alternating messages trip the ping-pong guard centrally", async () => {
    const dm = await channelService.getOrCreateDm(ctx, null, IDLE);
    // Founder and IDLE alternate; the 10th message (alternation depth 9) trips
    for (let i = 0; i < 10; i++) {
      await messageService.send(ctx, {
        channelId: dm.id,
        senderAgentId: i % 2 === 0 ? null : IDLE,
        kind: "text",
        body: `volley ${i}`,
        idempotencyKey: uuidv7(),
      });
    }
    const tripped = await db
      .select()
      .from(events)
      .where(
        sql`${events.companyId} = ${companyId} AND ${events.type} = 'agent.guard.triggered'
            AND ${events.payload}->>'guard' = 'ping_pong'`,
      );
    expect(tripped.length).toBeGreaterThanOrEqual(1);
  });

  it("task creation auto-provisions the task thread (11 §2)", async () => {
    const { TasksService } = await import("@acos/db");
    const tasksService = new TasksService(guardedDb);
    const created = await tasksService.create(
      ctx,
      { kind: "task", title: "Threaded", objective: "x" },
      { kind: "agent", agentId: ACTIVE },
    );
    const [thread] = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.companyId, companyId),
          eq(channels.kind, "task_thread"),
          eq(channels.taskId, created.id),
        ),
      );
    expect(thread).toBeDefined();
    const members = await channelService.members(ctx, thread!.id);
    expect(members.map((m) => m.agentId)).toContain(ACTIVE);
  });

  it("T38: a reply on the task thread restarts a WAITING owner that has NO live workflow", async () => {
    // request_help sonrasi gorunen sekil: gorev WAITING'e park etti ve
    // (CLI runtimeinda) oturum KAPANDI. Yoneticinin cevabi yalnizca kosan bir
    // workflow'a sinyal tasidigi icin, uyandirmasi gereken mesaj hicbir seyi
    // uyandirmiyordu — gorev 30 dakikalik sweep'e kadar oyle kaliyordu.
    const { TasksService } = await import("@acos/db");
    const tasksService = new TasksService(guardedDb);
    const parked = await tasksService.create(
      ctx,
      { kind: "task", title: "Parked on help", objective: "x" },
      { kind: "agent", agentId: IDLE },
    );
    // IDLE'in KOSAN workflow'u yok; gorevi WAITING'e ve sahibine sabitle
    await db
      .update(tasks)
      .set({ status: "WAITING", ownerAgentId: IDLE })
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, parked.id)));
    const [thread] = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.companyId, companyId),
          eq(channels.kind, "task_thread"),
          eq(channels.taskId, parked.id),
        ),
      );

    const woken: Array<{ agentId: string; taskId: string }> = [];
    const spyPort = {
      ...signalPort(),
      async startAgentTurn({ agentId, taskId: t }: { companyId: string; agentId: string; taskId: string }) {
        woken.push({ agentId, taskId: t });
      },
    };

    const plan = await messageService.send(ctx, {
      channelId: thread!.id,
      senderAgentId: null,
      kind: "text",
      body: "Yoneticinin cevabi: su sekilde ilerle",
      idempotencyKey: uuidv7(),
    });
    await deliverMessage(guardedDb, ctx, plan, spyPort);

    // BEKLENEN SEY GELDI: gorevin KENDI thread'ine dustu, alici gorevin
    // SAHIBI, gorev WAITING ve canli oturum yok ⇒ tur yeniden baslatilir.
    expect(woken).toEqual([{ agentId: IDLE, taskId: parked.id }]);
  });

  it("T38: an UNRESOLVED wait is NOT woken — no blanket WAITING restart", async () => {
    // Kartin yuk tasiyan kisitlamasi: WAITING tek bir durum degil. Bekleyisi
    // cozmeyen bir mesaj turu yeniden baslatirsa ajan uyanir, hicbir sey
    // gelmedigini gorur, yine bekler ve esszamanlilik tavaninda kosulabilir isi
    // acliga iter. Burada mesaj gorev thread'ine DEGIL, bir DM'e dusuyor.
    const { TasksService } = await import("@acos/db");
    const tasksService = new TasksService(guardedDb);
    const parked = await tasksService.create(
      ctx,
      { kind: "task", title: "Still waiting", objective: "x" },
      { kind: "agent", agentId: IDLE },
    );
    await db
      .update(tasks)
      .set({ status: "WAITING", ownerAgentId: IDLE })
      .where(and(eq(tasks.companyId, companyId), eq(tasks.id, parked.id)));

    const woken: Array<{ agentId: string; taskId: string }> = [];
    const spyPort = {
      ...signalPort(),
      async startAgentTurn({ agentId, taskId: t }: { companyId: string; agentId: string; taskId: string }) {
        woken.push({ agentId, taskId: t });
      },
    };
    const dm = await channelService.getOrCreateDm(ctx, null, IDLE);
    const plan = await messageService.send(ctx, {
      channelId: dm.id,
      senderAgentId: null,
      kind: "text",
      body: "ilgisiz bir DM",
      idempotencyKey: uuidv7(),
    });
    await deliverMessage(guardedDb, ctx, plan, spyPort);
    expect(woken).toEqual([]);
  });
});
