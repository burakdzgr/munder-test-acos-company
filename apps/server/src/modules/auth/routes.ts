// Auth routes (T16): first-run wizard, login/logout/me, PATs, TOTP.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  LoginRequestSchema,
  LoginResponseSchema,
  TotpRequiredResponseSchema,
  OkSchema,
  PatCreateRequestSchema,
  PatCreatedSchema,
  PatListItemSchema,
  SetupRequestSchema,
  SetupStatusSchema,
  SessionUserSchema,
  TotpConfirmRequestSchema,
  TotpDisableRequestSchema,
  TotpEnableRequestSchema,
  TotpEnableResponseSchema,
} from "@acos/contracts";
import { ApiError } from "../../app.js";
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
  type AuthService,
  type UserRow,
} from "./service.js";

function toSessionUser(user: UserRow) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    platformRole: user.platformRole as "owner" | "admin" | "member",
    totpEnabled: user.totpEnabled,
  };
}

const cookieOptions = SESSION_COOKIE_OPTIONS;

export async function registerAuthRoutes(rawApp: FastifyInstance, auth: () => AuthService) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();
  app.get(
    "/api/v1/auth/setup",
    {
      schema: {
        operationId: "getSetupStatus",
        tags: ["auth"],
        response: { 200: SetupStatusSchema },
      },
    },
    async () => ({ needed: await auth().setupNeeded() }),
  );

  app.post(
    "/api/v1/auth/setup",
    {
      schema: {
        operationId: "completeSetup",
        tags: ["auth"],
        body: SetupRequestSchema,
        response: { 200: LoginResponseSchema },
      },
    },
    async (request, reply) => {
      if (!(await auth().setupNeeded())) {
        throw new ApiError("conflict", "setup already completed");
      }
      const user = await auth().createFounder({ ...request.body, ip: request.ip });
      const login = await auth().login({
        email: request.body.email,
        password: request.body.password,
        ip: request.ip,
      });
      if (login.kind !== "ok") throw new ApiError("internal", "post-setup login failed");
      reply
        .setCookie(SESSION_COOKIE, login.sessionToken, cookieOptions)
        .setCookie(CSRF_COOKIE, login.csrfToken, { ...cookieOptions, httpOnly: false });
      return { user: toSessionUser(user), totpRequired: false as const };
    },
  );

  app.post(
    "/api/v1/auth/login",
    {
      schema: {
        operationId: "login",
        tags: ["auth"],
        body: LoginRequestSchema,
        response: { 200: z.union([LoginResponseSchema, TotpRequiredResponseSchema]) },
      },
    },
    async (request, reply) => {
      const result = await auth().login({
        ...request.body,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      });
      if (result.kind === "rate_limited") throw new ApiError("rate_limited", "too many failed logins");
      if (result.kind === "invalid") throw new ApiError("unauthenticated", "invalid credentials");
      if (result.kind === "totp_required") return { totpRequired: true as const };
      reply
        .setCookie(SESSION_COOKIE, result.sessionToken, cookieOptions)
        .setCookie(CSRF_COOKIE, result.csrfToken, { ...cookieOptions, httpOnly: false });
      return { user: toSessionUser(result.user), totpRequired: false as const };
    },
  );

  app.post(
    "/api/v1/auth/logout",
    { schema: { operationId: "logout", tags: ["auth"], response: { 200: OkSchema } } },
    async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE];
      if (token) await auth().logout(token, request.ip);
      reply.clearCookie(SESSION_COOKIE, { path: "/" }).clearCookie(CSRF_COOKIE, { path: "/" });
      return { ok: true as const };
    },
  );

  app.get(
    "/api/v1/auth/me",
    { schema: { operationId: "getMe", tags: ["auth"], response: { 200: SessionUserSchema } } },
    async (request) => toSessionUser(request.requireUser()),
  );

  app.post(
    "/api/v1/auth/pats",
    {
      schema: {
        operationId: "createPat",
        tags: ["auth"],
        body: PatCreateRequestSchema,
        response: { 201: PatCreatedSchema },
      },
    },
    async (request, reply) => {
      const user = request.requireUser();
      const created = await auth().createPat({
        userId: user.id,
        name: request.body.name,
        scopes: request.body.scopes,
        expiresAt: request.body.expiresAt ? new Date(request.body.expiresAt) : null,
      });
      return reply.status(201).send(created);
    },
  );

  app.get(
    "/api/v1/auth/pats",
    {
      schema: {
        operationId: "listPats",
        tags: ["auth"],
        response: { 200: z.array(PatListItemSchema) },
      },
    },
    async (request) => {
      const user = request.requireUser();
      const pats = await auth().listPats(user.id);
      return pats.map((p) => ({
        ...p,
        createdAt: p.createdAt.toISOString(),
        expiresAt: p.expiresAt?.toISOString() ?? null,
        lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
        revokedAt: p.revokedAt?.toISOString() ?? null,
      }));
    },
  );

  app.delete(
    "/api/v1/auth/pats/:id",
    {
      schema: {
        operationId: "revokePat",
        tags: ["auth"],
        params: z.object({ id: z.uuid() }),
        response: { 200: OkSchema },
      },
    },
    async (request) => {
      const user = request.requireUser();
      const revoked = await auth().revokePat(user.id, request.params.id);
      if (!revoked) throw new ApiError("not_found", "pat not found");
      return { ok: true as const };
    },
  );

  app.post(
    "/api/v1/auth/totp/enable",
    {
      schema: {
        operationId: "totpEnable",
        tags: ["auth"],
        body: TotpEnableRequestSchema,
        response: { 200: TotpEnableResponseSchema },
      },
    },
    async (request) => {
      const user = request.requireUser();
      const result = await auth().totpEnable(user, request.body.password);
      if (!result) throw new ApiError("unauthenticated", "password verification failed");
      return result;
    },
  );

  app.post(
    "/api/v1/auth/totp/confirm",
    {
      schema: {
        operationId: "totpConfirm",
        tags: ["auth"],
        body: TotpConfirmRequestSchema,
        response: { 200: OkSchema },
      },
    },
    async (request) => {
      const user = request.requireUser();
      if (!(await auth().totpConfirm(user, request.body.code))) {
        throw new ApiError("state_precondition_failed", "totp confirmation failed");
      }
      return { ok: true as const };
    },
  );

  app.post(
    "/api/v1/auth/totp/disable",
    {
      schema: {
        operationId: "totpDisable",
        tags: ["auth"],
        body: TotpDisableRequestSchema,
        response: { 200: OkSchema },
      },
    },
    async (request) => {
      const user = request.requireUser();
      if (!(await auth().totpDisable(user, request.body.password, request.body.code))) {
        throw new ApiError("state_precondition_failed", "totp disable failed");
      }
      return { ok: true as const };
    },
  );

}
