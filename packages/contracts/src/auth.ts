// Auth request/response schemas (21 §3 auth surface, 18 §2–3).
import { z } from "zod";

export const SessionUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  platformRole: z.enum(["owner", "admin", "member"]),
  totpEnabled: z.boolean(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const SetupStatusSchema = z.object({ needed: z.boolean() });

export const SetupRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(12),
  displayName: z.string().min(1),
});

export const LoginRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});

export const LoginResponseSchema = z.object({
  user: SessionUserSchema,
  totpRequired: z.literal(false),
});
export const TotpRequiredResponseSchema = z.object({ totpRequired: z.literal(true) });

export const PatCreateRequestSchema = z.object({
  name: z.string().min(1),
  scopes: z.array(z.string().regex(/^[a-z*]+:[a-z*]+$/)).min(1),
  expiresAt: z.iso.datetime().optional(),
});

export const PatCreatedSchema = z.object({
  id: z.uuid(),
  /** shown exactly once */
  token: z.string(),
});

export const PatListItemSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime().nullable(),
  lastUsedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
});

export const TotpEnableRequestSchema = z.object({ password: z.string().min(1) });
export const TotpEnableResponseSchema = z.object({ secret: z.string(), otpauth: z.string() });
export const TotpConfirmRequestSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export const TotpDisableRequestSchema = z.object({
  password: z.string().min(1),
  code: z.string().regex(/^\d{6}$/),
});

export const OkSchema = z.object({ ok: z.literal(true) });
