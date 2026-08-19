// Shared payload shorthands. Catalog policy (10 §8): payload fields are
// declared optional (additive-friendly) unless an event's identity depends on
// them — type mismatches on present fields still fail parsing.
import { z } from "zod";

export const u = z.uuid().optional();
export const uReq = z.uuid();
export const s = z.string().optional();
export const sReq = z.string().min(1);
export const int = z.number().int().optional();
export const num = z.number().optional();
export const bool = z.boolean().optional();
export const diff = z.record(z.string(), z.unknown()).optional();
export const strArr = z.array(z.string()).optional();
export const uArr = z.array(z.uuid()).optional();
export const ts = z.iso.datetime().optional();
export const actorRef = z
  .object({ kind: z.enum(["agent", "founder", "system"]), id: z.uuid().nullable() })
  .optional();
export { z };
