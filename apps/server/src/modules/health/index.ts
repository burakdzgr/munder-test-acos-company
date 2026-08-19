// GET /api/health — aggregates dependency checks (27 §14, T15 acceptance).
import type { FastifyInstance } from "fastify";
import { HealthResponseSchema, type DependencyStatus } from "@acos/contracts";

export type DependencyChecker = () => Promise<void>;

export interface HealthCheckers {
  postgres: DependencyChecker;
  nats: DependencyChecker;
  temporal: DependencyChecker;
}

async function probe(checker: DependencyChecker): Promise<DependencyStatus> {
  const startedAt = Date.now();
  try {
    await checker();
    return { status: "ok", latencyMs: Date.now() - startedAt };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  checkers: HealthCheckers,
  version: string,
): Promise<void> {
  app.get(
    "/api/health",
    {
      schema: {
        operationId: "getHealth",
        tags: ["platform"],
        response: { 200: HealthResponseSchema, 503: HealthResponseSchema },
      },
    },
    async (_request, reply) => {
      const [postgres, nats, temporal] = await Promise.all([
        probe(checkers.postgres),
        probe(checkers.nats),
        probe(checkers.temporal),
      ]);
      const dependencies = { postgres, nats, temporal };
      const degraded = Object.values(dependencies).some((d) => d.status === "down");
      const body = {
        status: degraded ? ("degraded" as const) : ("ok" as const),
        service: "server" as const,
        version,
        dependencies,
      };
      return reply.status(degraded ? 503 : 200).send(body);
    },
  );
}
