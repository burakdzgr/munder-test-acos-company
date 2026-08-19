// GET /api/health — aggregates dependency checks (27 §14, T15 acceptance).
import { z } from "zod";

export const DependencyStatusSchema = z.object({
  status: z.enum(["ok", "down"]),
  latencyMs: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type DependencyStatus = z.infer<typeof DependencyStatusSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  service: z.literal("server"),
  version: z.string(),
  dependencies: z.object({
    postgres: DependencyStatusSchema,
    nats: DependencyStatusSchema,
    temporal: DependencyStatusSchema,
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
