// T16 acceptance: login/logout/PAT flows via fastify.inject; auth events
// audited; first-run wizard (demo step 1 API-level).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { eq, sql } from "drizzle-orm";
import { createDb, runMigrations, type Db } from "@acos/db";
import { auditLog } from "@acos/db/schema";
import { buildApp, type App } from "../../src/app.js";
import { totpCode } from "../../src/modules/auth/crypto.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const ok = async () => {};

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let app: App;

let sessionCookie = "";
let csrfToken = "";

const authHeaders = () => ({
  cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
  "x-csrf-token": csrfToken,
});

function captureCookies(setCookies: { name: string; value: string }[]) {
  for (const c of setCookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }
}

async function auditCount(action: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(eq(auditLog.action, action));
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  pool.on("error", () => {}); // teardown race: idle-client FATAL when the container stops
  db = createDb(pool);
  app = await buildApp({
    healthCheckers: { postgres: ok, nats: ok, temporal: ok },
    logger: false,
    db,
    masterKey: MASTER_KEY,
  });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await container?.stop();
});

describe("first-run wizard (demo step 1)", () => {
  it("reports setup needed, creates the Founder, then refuses a second run", async () => {
    const status = await app.inject({ method: "GET", url: "/api/v1/auth/setup" });
    expect(status.json()).toEqual({ needed: true });

    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { email: "founder@acme.local", password: "correct-horse-battery", displayName: "Founder" },
    });
    expect(setup.statusCode).toBe(200);
    expect(setup.json().user).toMatchObject({ email: "founder@acme.local", platformRole: "owner" });
    captureCookies(setup.cookies);
    expect(sessionCookie).toBeTruthy();
    expect(await auditCount("auth.setup.completed")).toBe(1);

    const again = await app.inject({
      method: "POST",
      url: "/api/v1/auth/setup",
      payload: { email: "x@y.local", password: "another-long-password", displayName: "X" },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("login / logout (18 §2)", () => {
  it("rejects bad credentials and audits the failure", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "founder@acme.local", password: "wrong-password" },
    });
    expect(bad.statusCode).toBe(401);
    expect(await auditCount("auth.login.failed")).toBeGreaterThanOrEqual(1);
  });

  it("logs in, serves /me, logs out (session revoked instantly)", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "founder@acme.local", password: "correct-horse-battery" },
    });
    expect(login.statusCode).toBe(200);
    captureCookies(login.cookies);
    expect(await auditCount("auth.login.succeeded")).toBeGreaterThanOrEqual(2); // setup + this

    const me = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: authHeaders() });
    expect(me.statusCode).toBe(200);
    expect(me.json().email).toBe("founder@acme.local");

    const staleCookie = sessionCookie;
    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: authHeaders(),
    });
    expect(logout.statusCode).toBe(200);
    expect(await auditCount("auth.logout")).toBe(1);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { cookie: `acos_session=${staleCookie}` },
    });
    expect(afterLogout.statusCode).toBe(401);

    // fresh session for the remaining suites
    const relogin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "founder@acme.local", password: "correct-horse-battery" },
    });
    captureCookies(relogin.cookies);
  });

  it("cookie-session mutations require the CSRF double-submit header", async () => {
    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/v1/auth/pats",
      headers: { cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}` },
      payload: { name: "cli", scopes: ["read:*"] },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe("PATs (18 §2)", () => {
  let patToken = "";
  let patId = "";

  it("creates a PAT (token shown once) and authenticates bearer requests", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/auth/pats",
      headers: authHeaders(),
      payload: { name: "cli", scopes: ["read:*", "write:tasks"] },
    });
    expect(created.statusCode).toBe(201);
    ({ token: patToken, id: patId } = created.json());
    expect(patToken).toMatch(/^acos_pat_/);
    expect(await auditCount("auth.pat.created")).toBe(1);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${patToken}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it("refuses founder:approve scope on PATs", async () => {
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/auth/pats",
      headers: authHeaders(),
      payload: { name: "evil", scopes: ["founder:approve"] },
    });
    expect(forbidden.statusCode).toBe(500); // service throws; refined mapping later
  });

  it("lists and revokes; revoked bearer is rejected", async () => {
    const list = await app.inject({ method: "GET", url: "/api/v1/auth/pats", headers: authHeaders() });
    expect(list.json().some((p: { id: string }) => p.id === patId)).toBe(true);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/pats/${patId}`,
      headers: authHeaders(),
    });
    expect(revoke.statusCode).toBe(200);
    expect(await auditCount("auth.pat.revoked")).toBe(1);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/auth/me",
      headers: { authorization: `Bearer ${patToken}` },
    });
    expect(me.statusCode).toBe(401);
  });
});

describe("TOTP (RFC 6238, sealed secret)", () => {
  let secret = "";

  it("enable → confirm turns 2FA on", async () => {
    const enable = await app.inject({
      method: "POST",
      url: "/api/v1/auth/totp/enable",
      headers: authHeaders(),
      payload: { password: "correct-horse-battery" },
    });
    expect(enable.statusCode).toBe(200);
    secret = enable.json().secret;
    expect(enable.json().otpauth).toContain("otpauth://totp/");

    const confirm = await app.inject({
      method: "POST",
      url: "/api/v1/auth/totp/confirm",
      headers: authHeaders(),
      payload: { code: totpCode(secret, Date.now()) },
    });
    expect(confirm.statusCode).toBe(200);
    expect(await auditCount("auth.totp.enabled")).toBe(1);
  });

  it("login now requires a valid TOTP code", async () => {
    const withoutCode = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "founder@acme.local", password: "correct-horse-battery" },
    });
    expect(withoutCode.statusCode).toBe(200);
    expect(withoutCode.json()).toEqual({ totpRequired: true });

    const wrongCode = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "founder@acme.local", password: "correct-horse-battery", totpCode: "000000" },
    });
    expect(wrongCode.statusCode).toBe(401);

    const withCode = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        email: "founder@acme.local",
        password: "correct-horse-battery",
        totpCode: totpCode(secret, Date.now()),
      },
    });
    expect(withCode.statusCode).toBe(200);
    captureCookies(withCode.cookies);
  });

  it("disable requires password + code and turns 2FA off", async () => {
    const disable = await app.inject({
      method: "POST",
      url: "/api/v1/auth/totp/disable",
      headers: authHeaders(),
      payload: { password: "correct-horse-battery", code: totpCode(secret, Date.now()) },
    });
    expect(disable.statusCode).toBe(200);
    expect(await auditCount("auth.totp.disabled")).toBe(1);
  });
});

describe("failed-login rate limiting (5 / 15min — 18 §2)", () => {
  it("returns 429 after five failures from one ip+user", async () => {
    for (let i = 0; i < 5; i++) {
      const attempt = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "founder@acme.local", password: `nope-${i}` },
        remoteAddress: "10.9.9.9",
      });
      expect(attempt.statusCode).toBe(401);
    }
    const sixth = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "founder@acme.local", password: "correct-horse-battery" },
      remoteAddress: "10.9.9.9",
    });
    expect(sixth.statusCode).toBe(429);
  });
});
