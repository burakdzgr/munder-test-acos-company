// E4/A (T30) — MCP oturum jetonu: konteynerdeki CLI'ın KİMLİĞİ.
//
// Konteynerde koşan `claude` oturumu ACOS eylemlerine MCP ile ulaşır. Kimliğini
// argümanda taşımaz — hiçbir MCP aracında agentId/companyId/taskId parametresi
// YOKTUR — sunucu her çağrıda bu satırdan türetir. Böylece bir oturum başka bir
// ajan, başka bir şirket ya da başka bir görev adına iş yapamaz: ne yanlış
// argümanla, ne prompt injection'la, ne de ele geçmiş bir konteynerle.
//
// Jeton neden yeni bir varlık: en ucuz yol INTERNAL_API_TOKEN'ı konteynere
// vermekti; o jeton ŞİRKET ÇAPINDA ana anahtardır ve kutudan bir kaçış bütün
// kontrol düzlemini teslim ederdi. Bunun yerine kısa ömürlü, tek oturuma mühürlü
// bir jeton basılır.
//
// Jetonun biçimi `"<companyId>.<secret>"`: baştaki şirket kimliği bir YETKİ
// İDDİASI değil, arama ipucudur (S4 kiracı koruması SELECT'te company_id şart
// koşar). Yetki tek şeyden gelir — özetin o şirkete ait bir satırla eşleşmesi.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { companyContext, type CompanyContext, type GuardedDb } from "@acos/db";
import { agents, mcpSessions, tasks } from "@acos/db/schema";

export const MCP_TOKEN_DEFAULT_TTL_SEC = 3600;
export const MCP_TOKEN_MAX_TTL_SEC = 43_200; // 12 saat — bir ajan turundan uzun

export interface MintedMcpSession {
  mcpSessionId: string;
  sessionToken: string;
  expiresAt: string;
}

export interface McpIdentity {
  companyId: string;
  agentId: string;
  taskId: string | null;
  agentSessionId: string | null;
  mcpSessionId: string;
}

export type McpAuthFailure =
  | { code: "unauthenticated"; message: string }
  | { code: "forbidden"; message: string }
  | { code: "conflict"; message: string };

const TERMINAL_TASK_STATUSES = ["DONE", "FAILED", "CANCELLED"];

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Basım: düz metin YALNIZ buradan çıkar, tabloda özeti durur. */
export async function mintMcpSession(
  db: GuardedDb,
  ctx: CompanyContext,
  input: {
    agentId: string;
    taskId?: string | null;
    agentSessionId?: string | null;
    ttlSec?: number | undefined;
  },
): Promise<MintedMcpSession> {
  const ttl = Math.min(Math.max(input.ttlSec ?? MCP_TOKEN_DEFAULT_TTL_SEC, 60), MCP_TOKEN_MAX_TTL_SEC);
  const secret = randomBytes(32).toString("base64url");
  const sessionToken = `${ctx.companyId}.${secret}`;
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const [row] = await db
    .insert(mcpSessions)
    .values({
      companyId: ctx.companyId,
      agentId: input.agentId,
      taskId: input.taskId ?? null,
      agentSessionId: input.agentSessionId ?? null,
      tokenHash: hashToken(sessionToken),
      expiresAt,
    })
    .returning();
  return {
    mcpSessionId: row!.id,
    sessionToken,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Doğrulama. Sırayla: biçim → (şirket, özet) satırı → süre/iptal → ajan hâlâ
 * aktif mi → görev hâlâ açık mı. Kapanmış bir görev için jeton çalışmaz:
 * teslim edilmiş işe geç gelen bir oturum kontrol düzlemine yazamaz.
 */
export async function verifyMcpToken(
  db: GuardedDb,
  token: string | undefined,
): Promise<{ ok: true; identity: McpIdentity } | { ok: false; failure: McpAuthFailure }> {
  const unauth = (message: string) =>
    ({ ok: false as const, failure: { code: "unauthenticated" as const, message } });
  if (!token) return unauth("mcp session token required");
  const dot = token.indexOf(".");
  if (dot <= 0) return unauth("malformed mcp session token");
  const companyId = token.slice(0, dot);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
    return unauth("malformed mcp session token");
  }
  const [row] = await db
    .select()
    .from(mcpSessions)
    .where(and(eq(mcpSessions.companyId, companyId), eq(mcpSessions.tokenHash, hashToken(token))));
  if (!row) return unauth("unknown mcp session token");
  // Özet zaten benzersiz; yine de sabit-zamanlı karşılaştırma alışkanlığı
  // korunur (jeton karşılaştırmalarında sızıntı sınıfı aynıdır).
  const provided = Buffer.from(hashToken(token));
  const stored = Buffer.from(row.tokenHash);
  if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) {
    return unauth("unknown mcp session token");
  }
  if (row.revokedAt) return unauth("mcp session revoked");
  if (row.expiresAt.getTime() <= Date.now()) return unauth("mcp session expired");

  const ctx = companyContext(companyId);
  const [agent] = await db
    .select({ status: agents.status })
    .from(agents)
    .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, row.agentId)));
  if (!agent || agent.status !== "active") {
    return { ok: false, failure: { code: "forbidden", message: "agent is not active" } };
  }
  if (row.taskId) {
    const [task] = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, row.taskId)));
    if (!task || TERMINAL_TASK_STATUSES.includes(task.status)) {
      return { ok: false, failure: { code: "conflict", message: "task closed" } };
    }
  }

  return {
    ok: true,
    identity: {
      companyId,
      agentId: row.agentId,
      taskId: row.taskId,
      agentSessionId: row.agentSessionId,
      mcpSessionId: row.id,
    },
  };
}

/** Kullanım izi — hangi jeton canlı, kaç çağrı yaptı (denetim + teşhis). */
export async function touchMcpSession(
  db: GuardedDb,
  ctx: CompanyContext,
  mcpSessionId: string,
): Promise<void> {
  await db
    .update(mcpSessions)
    .set({ lastUsedAt: new Date(), callCount: sql`${mcpSessions.callCount} + 1` })
    .where(and(eq(mcpSessions.companyId, ctx.companyId), eq(mcpSessions.id, mcpSessionId)));
}

export async function revokeMcpSession(
  db: GuardedDb,
  ctx: CompanyContext,
  mcpSessionId: string,
): Promise<{ revoked: boolean }> {
  const [row] = await db
    .update(mcpSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mcpSessions.companyId, ctx.companyId),
        eq(mcpSessions.id, mcpSessionId),
        isNull(mcpSessions.revokedAt),
      ),
    )
    .returning({ id: mcpSessions.id });
  return { revoked: Boolean(row) };
}

/**
 * Oturum kapanınca jetonu da kapat. Ajan turu bittiğinde konteyner ölür ama
 * jeton TTL'i dolana kadar yaşardı — kapanış, iptalin doğal tetikleyicisidir.
 */
export async function revokeMcpSessionsForAgentSession(
  db: GuardedDb,
  ctx: CompanyContext,
  agentSessionId: string,
): Promise<{ revoked: number }> {
  const rows = await db
    .update(mcpSessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mcpSessions.companyId, ctx.companyId),
        eq(mcpSessions.agentSessionId, agentSessionId),
        isNull(mcpSessions.revokedAt),
      ),
    )
    .returning({ id: mcpSessions.id });
  return { revoked: rows.length };
}
