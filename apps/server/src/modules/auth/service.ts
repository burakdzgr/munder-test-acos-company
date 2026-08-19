// Auth service (18 §2–3, §6): sessions, PATs, TOTP, failed-login rate
// limiting on the unlogged rate_limits table, and audit_log hooks (S7).
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@acos/db";
import {
  users,
  sessions,
  personalAccessTokens,
  rateLimits,
} from "@acos/db/schema";
import { auditLog } from "@acos/db/schema";
import {
  hashPassword,
  verifyPassword,
  opaqueToken,
  sha256,
  sealSecret,
  unsealSecret,
  generateTotpSecret,
  verifyTotp,
  otpauthUrl,
} from "./crypto.js";

export const SESSION_COOKIE = "acos_session";
export const CSRF_COOKIE = "acos_csrf";
/**
 * O8: the session cookie carries the Founder's identity, so outside
 * development it must never travel over plain HTTP. `secure` is on whenever
 * the process is not running in development — the prod overlay terminates TLS
 * at Caddy (27 §3), and a cookie without this flag is replayable by anyone on
 * the path. Left off in development so http://localhost still works.
 */
export const SESSION_COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
};
const SESSION_IDLE_HOURS = 24;
const SESSION_ABSOLUTE_DAYS = 30;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;

export interface AuditEntry {
  action: string; // dotted verb, e.g. 'auth.login.failed' (category = prefix)
  actorKind: "user" | "agent" | "system";
  actorId?: string | null;
  companyId?: string | null;
  targetKind?: string | null;
  targetId?: string | null;
  ip?: string | null;
  meta?: Record<string, unknown>;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly masterKey: string,
  ) {}

  async audit(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values({
      companyId: entry.companyId ?? null,
      actorKind: entry.actorKind,
      actorId: entry.actorId ?? null,
      action: entry.action,
      targetKind: entry.targetKind ?? null,
      targetId: entry.targetId ?? null,
      ip: entry.ip ?? null,
      meta: entry.meta ?? {},
    });
  }

  // ---------- first-run wizard ----------

  async setupNeeded(): Promise<boolean> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(users);
    return Number(row?.n ?? 0) === 0;
  }

  async createFounder(input: {
    email: string;
    password: string;
    displayName: string;
    ip?: string;
  }): Promise<UserRow> {
    const [user] = await this.db
      .insert(users)
      .values({
        email: input.email.toLowerCase(),
        passwordHash: await hashPassword(input.password),
        displayName: input.displayName,
        platformRole: "owner", // MVP: single user = platform owner + founder (18 §3)
      })
      .returning();
    await this.audit({
      action: "auth.setup.completed",
      actorKind: "user",
      actorId: user!.id,
      ip: input.ip ?? null,
    });
    return user!;
  }

  // ---------- login rate limiting (5 / 15min / user+IP — 18 §2) ----------

  private async failureCount(key: string): Promise<number> {
    const [row] = await this.db.select().from(rateLimits).where(eq(rateLimits.key, key));
    if (!row) return 0;
    if (Date.now() - row.refilledAt.getTime() > LOGIN_WINDOW_MS) {
      await this.db.delete(rateLimits).where(eq(rateLimits.key, key));
      return 0;
    }
    return row.tokens;
  }

  private async recordFailure(key: string): Promise<void> {
    await this.db
      .insert(rateLimits)
      .values({ key, tokens: 1, refilledAt: sql`now()` })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: { tokens: sql`${rateLimits.tokens} + 1` },
      });
  }

  // ---------- login ----------

  async login(input: {
    email: string;
    password: string;
    totpCode?: string | undefined;
    ip?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<
    | { kind: "ok"; user: UserRow; sessionToken: string; csrfToken: string }
    | { kind: "invalid" }
    | { kind: "totp_required" }
    | { kind: "rate_limited" }
  > {
    const email = input.email.toLowerCase();
    const limitKey = `login:${email}:${input.ip ?? "?"}`;
    if ((await this.failureCount(limitKey)) >= LOGIN_MAX_FAILURES) {
      await this.audit({ action: "auth.login.rate_limited", actorKind: "system", meta: { email } });
      return { kind: "rate_limited" };
    }

    const [user] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`);
    const passwordOk =
      user !== undefined &&
      user.status === "active" &&
      (await verifyPassword(user.passwordHash, input.password));
    if (!passwordOk) {
      await this.recordFailure(limitKey);
      await this.audit({
        action: "auth.login.failed",
        actorKind: "user",
        actorId: user?.id ?? null,
        ip: input.ip ?? null,
        meta: { email },
      });
      return { kind: "invalid" };
    }

    if (user.totpEnabled) {
      if (!input.totpCode) return { kind: "totp_required" };
      const secret = await unsealSecret(this.masterKey, Buffer.from(user.totpSecretEnc!));
      if (!verifyTotp(secret, input.totpCode)) {
        await this.recordFailure(limitKey);
        await this.audit({
          action: "auth.login.failed",
          actorKind: "user",
          actorId: user.id,
          ip: input.ip ?? null,
          meta: { email, reason: "totp" },
        });
        return { kind: "invalid" };
      }
    }

    const sessionToken = opaqueToken();
    const csrfToken = opaqueToken();
    await this.db.insert(sessions).values({
      userId: user.id,
      tokenHash: sha256(sessionToken),
      expiresAt: new Date(Date.now() + SESSION_IDLE_HOURS * 3_600_000),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    await this.db.delete(rateLimits).where(eq(rateLimits.key, limitKey));
    await this.db.update(users).set({ lastLoginAt: sql`now()` }).where(eq(users.id, user.id));
    await this.audit({
      action: "auth.login.succeeded",
      actorKind: "user",
      actorId: user.id,
      ip: input.ip ?? null,
    });
    return { kind: "ok", user, sessionToken, csrfToken };
  }

  /**
   * Single-user mode (AUTH_AUTOLOGIN, Founder decision 2026-08-13): mint a
   * real session for the platform owner without credentials. The session /
   * CSRF / audit substrate stays intact — only the password prompt is gone.
   * Unavailable until first-run setup (or seed) has created the owner.
   */
  async autologinFounder(input: {
    ip?: string | undefined;
    userAgent?: string | undefined;
  }): Promise<
    { kind: "ok"; user: UserRow; sessionToken: string; csrfToken: string } | { kind: "unavailable" }
  > {
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.platformRole, "owner"), eq(users.status, "active")))
      .orderBy(users.createdAt)
      .limit(1);
    if (!user) return { kind: "unavailable" };

    const sessionToken = opaqueToken();
    const csrfToken = opaqueToken();
    await this.db.insert(sessions).values({
      userId: user.id,
      tokenHash: sha256(sessionToken),
      expiresAt: new Date(Date.now() + SESSION_IDLE_HOURS * 3_600_000),
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    await this.db.update(users).set({ lastLoginAt: sql`now()` }).where(eq(users.id, user.id));
    await this.audit({
      action: "auth.autologin.succeeded",
      actorKind: "user",
      actorId: user.id,
      ip: input.ip ?? null,
    });
    return { kind: "ok", user, sessionToken, csrfToken };
  }

  /** Sliding renewal within the 30d absolute lifetime (18 §2). */
  async verifySession(token: string): Promise<UserRow | null> {
    const tokenHash = sha256(token);
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)));
    if (!row) return null;
    const { session, user } = row;
    if (session.expiresAt.getTime() < Date.now()) return null;
    const absoluteLimit = session.createdAt.getTime() + SESSION_ABSOLUTE_DAYS * 86_400_000;
    const renewed = Math.min(Date.now() + SESSION_IDLE_HOURS * 3_600_000, absoluteLimit);
    await this.db
      .update(sessions)
      .set({ lastSeenAt: sql`now()`, expiresAt: new Date(renewed) })
      .where(eq(sessions.id, session.id));
    return user.status === "active" ? user : null;
  }

  async logout(token: string, ip?: string): Promise<void> {
    const tokenHash = sha256(token);
    const [row] = await this.db
      .update(sessions)
      .set({ revokedAt: sql`now()` })
      .where(eq(sessions.tokenHash, tokenHash))
      .returning({ userId: sessions.userId });
    if (row) {
      await this.audit({
        action: "auth.logout",
        actorKind: "user",
        actorId: row.userId,
        ip: ip ?? null,
      });
    }
  }

  // ---------- PATs (scopes <action>:<module>; never founder:approve — 18 §2) ----------

  async createPat(input: {
    userId: string;
    name: string;
    scopes: string[];
    expiresAt?: Date | null;
  }): Promise<{ id: string; token: string }> {
    if (input.scopes.includes("founder:approve")) {
      throw new Error("PATs can never carry founder:approve");
    }
    const secret = opaqueToken();
    const [row] = await this.db
      .insert(personalAccessTokens)
      .values({
        userId: input.userId,
        name: input.name,
        tokenHash: "pending",
        tokenPrefix: "acos_pat_",
        scopes: input.scopes,
        expiresAt: input.expiresAt ?? null,
      })
      .returning({ id: personalAccessTokens.id });
    const token = `acos_pat_${row!.id}_${secret}`;
    await this.db
      .update(personalAccessTokens)
      .set({ tokenHash: sha256(token) })
      .where(eq(personalAccessTokens.id, row!.id));
    await this.audit({
      action: "auth.pat.created",
      actorKind: "user",
      actorId: input.userId,
      targetKind: "personal_access_token",
      targetId: row!.id,
      meta: { name: input.name, scopes: input.scopes },
    });
    return { id: row!.id, token };
  }

  async verifyPat(token: string): Promise<{ user: UserRow; scopes: string[] } | null> {
    const [row] = await this.db
      .select({ pat: personalAccessTokens, user: users })
      .from(personalAccessTokens)
      .innerJoin(users, eq(personalAccessTokens.userId, users.id))
      .where(and(eq(personalAccessTokens.tokenHash, sha256(token)), isNull(personalAccessTokens.revokedAt)));
    if (!row) return null;
    if (row.pat.expiresAt && row.pat.expiresAt.getTime() < Date.now()) return null;
    await this.db
      .update(personalAccessTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(personalAccessTokens.id, row.pat.id));
    return row.user.status === "active" ? { user: row.user, scopes: row.pat.scopes } : null;
  }

  async listPats(userId: string) {
    return this.db
      .select({
        id: personalAccessTokens.id,
        name: personalAccessTokens.name,
        scopes: personalAccessTokens.scopes,
        createdAt: personalAccessTokens.createdAt,
        expiresAt: personalAccessTokens.expiresAt,
        lastUsedAt: personalAccessTokens.lastUsedAt,
        revokedAt: personalAccessTokens.revokedAt,
      })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.userId, userId));
  }

  async revokePat(userId: string, patId: string): Promise<boolean> {
    const [row] = await this.db
      .update(personalAccessTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(personalAccessTokens.id, patId), eq(personalAccessTokens.userId, userId)))
      .returning({ id: personalAccessTokens.id });
    if (row) {
      await this.audit({
        action: "auth.pat.revoked",
        actorKind: "user",
        actorId: userId,
        targetKind: "personal_access_token",
        targetId: patId,
      });
    }
    return row !== undefined;
  }

  // ---------- TOTP (enable requires current password; audited — 18 §2) ----------

  async totpEnable(user: UserRow, password: string): Promise<{ secret: string; otpauth: string } | null> {
    if (!(await verifyPassword(user.passwordHash, password))) return null;
    const secret = generateTotpSecret();
    const sealed = await sealSecret(this.masterKey, secret);
    await this.db
      .update(users)
      .set({ totpSecretEnc: sealed, totpEnabled: false })
      .where(eq(users.id, user.id));
    return { secret, otpauth: otpauthUrl(user.email, secret) };
  }

  async totpConfirm(user: UserRow, code: string): Promise<boolean> {
    const [fresh] = await this.db.select().from(users).where(eq(users.id, user.id));
    if (!fresh?.totpSecretEnc) return false;
    const secret = await unsealSecret(this.masterKey, Buffer.from(fresh.totpSecretEnc));
    if (!verifyTotp(secret, code)) return false;
    await this.db.update(users).set({ totpEnabled: true }).where(eq(users.id, user.id));
    await this.audit({ action: "auth.totp.enabled", actorKind: "user", actorId: user.id });
    return true;
  }

  async totpDisable(user: UserRow, password: string, code: string): Promise<boolean> {
    if (!(await verifyPassword(user.passwordHash, password))) return false;
    const [fresh] = await this.db.select().from(users).where(eq(users.id, user.id));
    if (!fresh?.totpEnabled || !fresh.totpSecretEnc) return false;
    const secret = await unsealSecret(this.masterKey, Buffer.from(fresh.totpSecretEnc));
    if (!verifyTotp(secret, code)) return false;
    await this.db
      .update(users)
      .set({ totpEnabled: false, totpSecretEnc: null })
      .where(eq(users.id, user.id));
    await this.audit({ action: "auth.totp.disabled", actorKind: "user", actorId: user.id });
    return true;
  }
}
