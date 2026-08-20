// Communication core (11 §0–7; T33). Lives in @acos/db for the same reason
// as the task engine: ONE send path (11 §0.2) shared by the worker's
// sendMessageActivity and the server's REST routes — guards, counters and
// events cannot be bypassed. Persistence-first: the message row + outbox
// events commit before any signal fires (delivery is the caller's post-commit
// concern via the SignalPort).
// Deviations from doc 11's sketch, bounded by the canonical schema (20 §8):
// ordering rides the time-ordered uuidv7 id (no channel_seq column), unread
// tracking is last_read_at, and mention ids are persisted as refs entries.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { parseEventPayload } from "@acos/events";
import { appendEvents, type NewEventInput, type Tx } from "./outbox.js";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { agents, channelMembers, channels, messages } from "./schema/index.js";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

export type ChannelRow = typeof channels.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

export class CommsError extends Error {
  constructor(
    public readonly code: "NOT_A_MEMBER" | "CHANNEL_NOT_FOUND" | "BAD_MESSAGE" | "MENTION_UNRESOLVED",
    message: string,
  ) {
    super(message);
    this.name = "CommsError";
  }
}

export interface SendInput {
  channelId: string;
  /** null sender = the Founder (11 §1). */
  senderAgentId: string | null;
  kind: "text" | "help_request" | "review_request" | "escalation" | "status" | "system";
  body: string;
  refs?: Array<{ kind: string; id: string }> | undefined;
  mentions?: string[] | undefined;
  replyToMessageId?: string | undefined;
  /** stepId-derived for agents (08 §11); server mints for Founder sends. */
  idempotencyKey: string;
}

export interface DeliveryPlan {
  message: MessageRow;
  channel: ChannelRow;
  /** member agents minus the sender; mentioned ids carry priority. */
  recipients: Array<{ agentId: string; mentioned: boolean }>;
}

export class ChannelService {
  constructor(private readonly db: GuardedDb) {}

  /** Race-free get-or-create (unique partial indexes; 11 §2). */
  async provisionInTx(
    tx: Tx,
    ctx: CompanyContext,
    input:
      | { kind: "task_thread"; taskId: string; memberAgentIds: string[] }
      | { kind: "team" | "department"; orgUnitId: string; name: string }
      | { kind: "dm"; agentA: string | null; agentB: string | null },
  ): Promise<ChannelRow> {
    const FOUNDER = "founder";
    const values =
      input.kind === "task_thread"
        ? { kind: input.kind, taskId: input.taskId }
        : input.kind === "dm"
          ? {
              kind: input.kind,
              dmKey: [input.agentA ?? FOUNDER, input.agentB ?? FOUNDER].sort().join(":"),
            }
          : { kind: input.kind, orgUnitId: input.orgUnitId, name: input.name };

    const existing = await tx
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.companyId, ctx.companyId),
          eq(channels.kind, input.kind),
          input.kind === "task_thread"
            ? eq(channels.taskId, input.taskId)
            : input.kind === "dm"
              ? eq(channels.dmKey, (values as { dmKey: string }).dmKey)
              : eq(channels.orgUnitId, input.orgUnitId),
        ),
      );
    if (existing[0]) return existing[0];

    const [channel] = await tx
      .insert(channels)
      .values({ companyId: ctx.companyId, ...values })
      .onConflictDoNothing()
      .returning();
    if (!channel) {
      // lost the race — re-select (11 §2 provisioning rule)
      const [row] = await tx
        .select()
        .from(channels)
        .where(
          and(
            eq(channels.companyId, ctx.companyId),
            eq(channels.kind, input.kind),
            input.kind === "task_thread"
              ? eq(channels.taskId, input.taskId)
              : input.kind === "dm"
                ? eq(channels.dmKey, (values as { dmKey: string }).dmKey)
                : eq(channels.orgUnitId, input.orgUnitId),
          ),
        );
      return row!;
    }

    await emitDomainEvent(tx, ctx, {
      type: "channel.created",
      actor: { kind: "system", id: null },
      ...(input.kind === "task_thread" && { taskId: input.taskId }),
      payload: {
        channelId: channel.id,
        kind: input.kind,
        ...("name" in values && values.name && { name: values.name }),
      },
    });

    const memberIds =
      input.kind === "task_thread"
        ? input.memberAgentIds
        : input.kind === "dm"
          ? [input.agentA, input.agentB]
          : [];
    for (const agentId of memberIds) {
      await this.addMemberInTx(tx, ctx, channel.id, agentId ?? null);
    }
    return channel;
  }

  async addMemberInTx(
    tx: Tx,
    ctx: CompanyContext,
    channelId: string,
    agentId: string | null,
  ): Promise<void> {
    const inserted = await tx
      .insert(channelMembers)
      .values({ companyId: ctx.companyId, channelId, agentId })
      .onConflictDoNothing()
      .returning({ id: channelMembers.id });
    if (inserted.length > 0) {
      await emitDomainEvent(tx, ctx, {
        type: "channel.member.added",
        actor: { kind: "system", id: null },
        payload: { channelId, ...(agentId ? { agentId } : { founder: true }) },
      });
    }
  }

  async list(ctx: CompanyContext, filters: { kind?: string | undefined } = {}) {
    return this.db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.companyId, ctx.companyId),
          isNull(channels.archivedAt),
          ...(filters.kind ? [eq(channels.kind, filters.kind)] : []),
        ),
      )
      .orderBy(desc(channels.createdAt));
  }

  async members(ctx: CompanyContext, channelId: string) {
    return this.db
      .select()
      .from(channelMembers)
      .where(
        and(
          eq(channelMembers.companyId, ctx.companyId),
          eq(channelMembers.channelId, channelId),
          isNull(channelMembers.leftAt),
        ),
      );
  }

  /** DM get-or-create as its own transaction (REST POST /channels). */
  async getOrCreateDm(ctx: CompanyContext, agentA: string | null, agentB: string | null) {
    return this.db.transaction((tx) =>
      this.provisionInTx(tx, ctx, { kind: "dm", agentA, agentB }),
    );
  }

  async markRead(ctx: CompanyContext, channelId: string, agentId: string | null): Promise<void> {
    await this.db
      .update(channelMembers)
      .set({ lastReadAt: sql`now()` })
      .where(
        and(
          eq(channelMembers.companyId, ctx.companyId),
          eq(channelMembers.channelId, channelId),
          agentId === null ? isNull(channelMembers.agentId) : eq(channelMembers.agentId, agentId),
          isNull(channelMembers.leftAt),
        ),
      );
  }
}

export class MessageService {
  constructor(
    private readonly db: GuardedDb,
    private readonly channelService: ChannelService = new ChannelService(db),
  ) {}

  /** The ONE send path (11 §4): validate → persist + events in one tx →
   *  return the delivery plan for the caller's post-commit signalling. */
  async send(ctx: CompanyContext, input: SendInput): Promise<DeliveryPlan> {
    if (input.body.length < 1 || input.body.length > 8000) {
      throw new CommsError("BAD_MESSAGE", "body must be 1..8000 chars");
    }
    if (input.kind === "help_request" && !(input.refs ?? []).some((r) => r.kind === "task")) {
      throw new CommsError("BAD_MESSAGE", "help_request must reference a task (11 §3)");
    }

    const plan = await this.db.transaction(async (tx) => {
      const [channel] = await tx
        .select()
        .from(channels)
        .where(and(eq(channels.companyId, ctx.companyId), eq(channels.id, input.channelId)))
        .for("update"); // serializes sends per channel (ordering by uuidv7 id)
      if (!channel) throw new CommsError("CHANNEL_NOT_FOUND", "channel not found");

      const members = await tx
        .select()
        .from(channelMembers)
        .where(
          and(
            eq(channelMembers.companyId, ctx.companyId),
            eq(channelMembers.channelId, channel.id),
            isNull(channelMembers.leftAt),
          ),
        );
      const isMember = members.some((m) =>
        input.senderAgentId === null ? true : m.agentId === input.senderAgentId,
      ); // the Founder is an implicit member of every channel (11 §2)
      if (!isMember && input.senderAgentId !== null) {
        throw new CommsError("NOT_A_MEMBER", "sender is not a channel member");
      }

      // mention resolution: ids must be company agents (11 §7)
      const mentions = input.mentions ?? [];
      for (const mention of mentions) {
        const [agent] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, mention)));
        if (!agent) throw new CommsError("MENTION_UNRESOLVED", `mention ${mention} is not an agent`);
      }

      const [existing] = await tx
        .select()
        .from(messages)
        .where(and(eq(messages.companyId, ctx.companyId), eq(messages.id, input.idempotencyKey)));
      if (existing) {
        return { message: existing, channel, recipients: [] }; // replay — already delivered
      }

      const refs = [
        ...(input.refs ?? []),
        ...mentions.map((id) => ({ kind: "mention", id })),
      ];
      const [message] = await tx
        .insert(messages)
        .values({
          id: input.idempotencyKey, // caller idempotency key = message id (08 §11)
          companyId: ctx.companyId,
          channelId: channel.id,
          senderAgentId: input.senderAgentId,
          kind: input.kind,
          body: input.body,
          refs,
          replyToMessageId: input.replyToMessageId ?? null,
        })
        .returning();

      const taskRef = channel.taskId ?? (input.refs ?? []).find((r) => r.kind === "task")?.id ?? null;
      await emitDomainEvent(tx, ctx, {
        type: "agent.message.sent",
        actor: input.senderAgentId
          ? { kind: "agent", id: input.senderAgentId }
          : { kind: "founder", id: null },
        ...(input.senderAgentId && { agentId: input.senderAgentId }),
        ...(taskRef && { taskId: taskRef }),
        payload: {
          messageId: message!.id,
          channelId: channel.id,
          senderAgentId: input.senderAgentId ?? undefined,
          kind: input.kind,
          mentions,
        },
      });
      if (input.kind === "help_request") {
        await emitDomainEvent(tx, ctx, {
          type: "agent.help.requested",
          actor: input.senderAgentId
            ? { kind: "agent", id: input.senderAgentId }
            : { kind: "founder", id: null },
          ...(taskRef && { taskId: taskRef }),
          payload: {
            messageId: message!.id,
            topic: input.body.slice(0, 200),
            audience: "team",
            targetAgentId: mentions[0],
          },
        });
      }

      // guard (e) anti-ping-pong (11 §9, 08 §9e): >8 strictly alternating
      // messages between the same pair on this channel trips the guard —
      // centrally, so no workflow can bypass it
      if (input.kind !== "status" && input.kind !== "system") {
        const recent = await tx
          .select({ senderAgentId: messages.senderAgentId })
          .from(messages)
          .where(and(eq(messages.companyId, ctx.companyId), eq(messages.channelId, channel.id)))
          .orderBy(desc(messages.id))
          .limit(10);
        const chain = recent.map((r) => r.senderAgentId ?? "founder");
        const pair = new Set(chain.slice(0, 2));
        let alternating = 1;
        for (let i = 1; i < chain.length; i++) {
          if (chain[i] !== chain[i - 1] && pair.has(chain[i]!)) alternating += 1;
          else break;
        }
        if (pair.size === 2 && alternating > 8) {
          await emitDomainEvent(tx, ctx, {
            type: "agent.guard.triggered",
            actor: { kind: "system", id: null },
            ...(input.senderAgentId && { agentId: input.senderAgentId }),
            payload: {
              guard: "ping_pong",
              context: { channelId: channel.id, alternating },
            },
          });
        }
      }

      // sender auto-joins open channels on first message (11 §2 task_thread rule)
      if (input.senderAgentId && !members.some((m) => m.agentId === input.senderAgentId)) {
        await this.channelService.addMemberInTx(tx, ctx, channel.id, input.senderAgentId);
      }

      const mentionSet = new Set(mentions);
      const recipients = members
        .filter((m): m is typeof m & { agentId: string } => m.agentId !== null)
        .filter((m) => m.agentId !== input.senderAgentId)
        .map((m) => ({ agentId: m.agentId, mentioned: mentionSet.has(m.agentId) }));
      for (const mention of mentions) {
        if (!recipients.some((r) => r.agentId === mention) && mention !== input.senderAgentId) {
          recipients.push({ agentId: mention, mentioned: true });
        }
      }
      return { message: message!, channel, recipients };
    });

    // status/system kinds never wake recipients (11 §4.4)
    if (plan.message && (input.kind === "status" || input.kind === "system")) {
      return { ...plan, recipients: [] };
    }
    return plan;
  }

  async page(
    ctx: CompanyContext,
    channelId: string,
    opts: { beforeId?: string | undefined; limit?: number | undefined } = {},
  ): Promise<MessageRow[]> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.companyId, ctx.companyId),
          eq(messages.channelId, channelId),
          ...(opts.beforeId ? [sql`${messages.id} < ${opts.beforeId}`] : []),
        ),
      )
      .orderBy(desc(messages.id)) // uuidv7 = time-ordered
      .limit(limit);
    return rows.reverse();
  }

  /** Working-Set slice (11 §6): last N thread messages for a task. */
  async taskThreadSlice(ctx: CompanyContext, taskId: string, limit = 15): Promise<MessageRow[]> {
    const [channel] = await this.db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.companyId, ctx.companyId),
          eq(channels.kind, "task_thread"),
          eq(channels.taskId, taskId),
        ),
      );
    if (!channel) return [];
    return this.page(ctx, channel.id, { limit });
  }
}

/** Post-commit delivery (11 §4.4) — the transport is injected: Temporal
 *  signal to active sessions, signalWithStart to idle inboxes. */
export interface SignalPort {
  signalActiveSession(input: {
    workflowId: string;
    item: InboxItem;
  }): Promise<boolean>;
  signalInbox(input: { companyId: string; agentId: string; item: InboxItem }): Promise<void>;
  /**
   * T38: bir bekleyis COZULDUGUNDE, sahibinin turunu CANLI WORKFLOW YOKKEN de
   * yeniden baslatabilmek icin. Opsiyonel — taşımayan cagirici icin davranis
   * degismez (mesaj yine dayanikli inbox'a duser).
   */
  startAgentTurn?(input: { companyId: string; agentId: string; taskId: string }): Promise<void>;
}

export interface InboxItem {
  signalId: string;
  messageId: string;
  channelId: string;
  senderAgentId: string | null;
  kind: string;
  preview: string;
  mentioned: boolean;
  sentAt: string;
}

export async function deliverMessage(
  db: GuardedDb,
  ctx: CompanyContext,
  plan: DeliveryPlan,
  port: SignalPort,
): Promise<void> {
  const { agentSessions } = await import("./schema/index.js");
  for (const recipient of plan.recipients) {
    const item: InboxItem = {
      signalId: `${plan.message.id}:${recipient.agentId}`,
      messageId: plan.message.id,
      channelId: plan.channel.id,
      senderAgentId: plan.message.senderAgentId,
      kind: plan.message.kind,
      // 2026-08-14: 300 → 2000 — Founder direktifleri ajanın working set'ine
      // preview marker'ıyla girer (thread bölümü T45'e dek placeholder);
      // 300 karakter talimatların çoğunu kırpıyordu.
      preview: plan.message.body.slice(0, 2000),
      mentioned: recipient.mentioned,
      sentAt: plan.message.createdAt.toISOString(),
    };
    const sessions = await db
      .select({ taskId: agentSessions.taskId })
      .from(agentSessions)
      .where(
        and(
          eq(agentSessions.companyId, ctx.companyId),
          eq(agentSessions.agentId, recipient.agentId),
          sql`${agentSessions.status} IN ('starting','running','waiting')`,
        ),
      );
    let delivered = false;
    for (const session of sessions) {
      if (!session.taskId) continue;
      const ok = await port
        .signalActiveSession({
          workflowId: `agent-task.${session.taskId}.${recipient.agentId}`,
          item,
        })
        .catch(() => false);
      delivered = delivered || ok;
    }
    if (!delivered) {
      await port
        .signalInbox({ companyId: ctx.companyId, agentId: recipient.agentId, item })
        .catch(() => {});
      await wakeResolvedWait(db, ctx, plan, recipient.agentId, port);
    }
  }
}

/**
 * T38 — "cozulen bir bekleyis, canli workflow YOKKEN de sahibinin turunu
 * yeniden baslatmali."
 *
 * request_help sonrasi gorev WAITING'e park ediyor ve (CLI runtimeinda) oturum
 * KAPANIYOR. Yoneticinin cevabi yalnizca KOSAN bir workflow'a sinyal
 * tasidigindan, uyandirmasi gereken mesaj hicbir seyi uyandirmiyordu: gorev
 * 30 dakikalik sweep'e kadar oyle kaliyordu (T14 ile ayni sinif, farkli
 * tetikleyici).
 *
 * KASITLI OLARAK dar: `pickNextQueuedTaskId`'ye WAITING'i toptan EKLEMIYORUZ.
 * WAITING tek bir durum degil (timer / reply / review / approval / dependency);
 * toptan dahil etmek, bekleyisi HALA COZULMEMIS gorevleri de yeniden
 * baslatirdi — ajan uyanir, hicbir sey gelmedigini gorur, yine bekler, bir
 * oturum + LLM turu yakar ve esszamanlilik tavaninda kosulabilir isi ACLIGA
 * iter (log'da dongu gibi gorunur). Burada tetikleyici bir DURUM TARAMASI
 * degil, BEKLENEN SEYIN GELMESI: mesaj gorevin KENDI thread'ine dustu, alici o
 * gorevin SAHIBI, gorev WAITING ve sahibinin canli oturumu yok. Bu dort kosul
 * birlikte "bekleyis cozuldu"nun ta kendisidir.
 *
 * Esszamanlilik guvenligi cagiranin: starter tek-canli-oturum kapisini ve
 * sirket tavanini uyguluyor; kapi reddederse gorev ASSIGNED kuyrugunda bekler.
 * 30 dakikalik sweep artik BIRINCIL yol degil, BACKSTOP.
 */
async function wakeResolvedWait(
  db: GuardedDb,
  ctx: CompanyContext,
  plan: DeliveryPlan,
  recipientAgentId: string,
  port: SignalPort,
): Promise<void> {
  if (!port.startAgentTurn) return;
  const threadTaskId = plan.channel.taskId;
  if (!threadTaskId) return; // gorev thread'i degilse ortada cozulen bir bekleyis yok
  const { tasks } = await import("./schema/index.js");
  const [task] = await db
    .select({ id: tasks.id, status: tasks.status, ownerAgentId: tasks.ownerAgentId })
    .from(tasks)
    .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, threadTaskId)));
  if (!task || task.status !== "WAITING" || task.ownerAgentId !== recipientAgentId) return;
  await port
    .startAgentTurn({ companyId: ctx.companyId, agentId: recipientAgentId, taskId: task.id })
    .catch(() => {
      // uyandirma best-effort: 30 dakikalik sweep backstop olarak duruyor
    });
}
