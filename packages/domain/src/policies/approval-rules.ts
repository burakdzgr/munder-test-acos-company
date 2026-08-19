// Approval Engine rules (19 §2, §6; _DECISIONS §12/§15; invariant S6).
// Pure data + functions — the engine (@acos/db) and the Tool Gateway (T39)
// consume these; nothing here is tenant-editable.
import type { Urgency } from "../entities/approval.js";

/**
 * S6: Founder-only action categories — platform-hard-coded, NEVER policy
 * rows (_DECISIONS §12, §20 S6). Every gateway decision touching one of
 * these is `require_approval(founder)` regardless of autonomy level; the
 * only carve-out is the explicitly delegated spend band (19 §8), modeled
 * as `hasStandingGrant` in `authorize()`.
 */
export const FOUNDER_ONLY_CATEGORIES = [
  "payments",
  "legal",
  "credentials",
  "destructive_prod",
] as const;
export type FounderOnlyCategory = (typeof FOUNDER_ONLY_CATEGORIES)[number];

export function isFounderOnlyCategory(value: string): value is FounderOnlyCategory {
  return (FOUNDER_ONLY_CATEGORIES as readonly string[]).includes(value);
}

/** Canonical approval kinds (20 §12.5 CHECK — the DB authority). */
export const APPROVAL_KINDS = [
  "tool_execution",
  "budget_increase",
  "hire",
  "promotion",
  "deployment",
  "vendor",
  "legal_financial",
  "other",
] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export function isApprovalKind(value: string): value is ApprovalKind {
  return (APPROVAL_KINDS as readonly string[]).includes(value);
}

/**
 * Kinds whose verdict can never be delegated to an agent or standing policy
 * (19 §2 mapped onto the canonical kind enum: vendor + legal/financial are
 * always Founder; promotion defaults to Founder per _DECISIONS §11).
 */
export const FOUNDER_ONLY_APPROVAL_KINDS: ReadonlySet<ApprovalKind> = new Set([
  "vendor",
  "legal_financial",
  "promotion",
]);

/**
 * Engine expiry window per urgency (19 §6 [WRITER-DECISION]): critical 24h,
 * high 48h, normal 72h, low 7d — never later than the business deadline.
 */
export const APPROVAL_EXPIRY_HOURS: Readonly<Record<Urgency, number>> = {
  critical: 24,
  high: 48,
  normal: 72,
  low: 168,
};

const HOUR_MS = 3_600_000;

/** Derived `expires_at` (19 §6) — min(created + window, business deadline). */
export function approvalExpiresAt(
  createdAt: Date,
  urgency: Urgency,
  deadline?: Date | null,
): Date {
  const windowEnd = new Date(createdAt.getTime() + APPROVAL_EXPIRY_HOURS[urgency] * HOUR_MS);
  if (deadline && deadline.getTime() < windowEnd.getTime()) return new Date(deadline.getTime());
  return windowEnd;
}

/** Reminder points inside the expiry window (19 §6): 50% and 85%. */
export const APPROVAL_REMINDER_FRACTIONS = [0.5, 0.85] as const;

export function approvalReminderAt(createdAt: Date, expiresAt: Date, fraction: number): Date {
  return new Date(createdAt.getTime() + (expiresAt.getTime() - createdAt.getTime()) * fraction);
}

/**
 * The verdict a waiting workflow receives when the window closes on silence:
 * `expired` MUST be treated exactly like `rejected` by every consumer —
 * nothing irreversible ever proceeds on silence (19 §6).
 */
export const EXPIRED_VERDICT_SEMANTICS = "rejected" as const;
