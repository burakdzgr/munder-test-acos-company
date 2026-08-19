import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HealthResponseSchema, ProblemJsonSchema } from "@acos/contracts";
import { buildApp, type App } from "./app.js";
import type { HealthCheckers } from "./modules/health/index.js";

const ok = async () => {};
const down = async () => {
  throw new Error("connection refused");
};

function checkers(overrides: Partial<HealthCheckers> = {}): HealthCheckers {
  return { postgres: ok, nats: ok, temporal: ok, ...overrides };
}

let app: App;
beforeAll(async () => {
  app = await buildApp({ healthCheckers: checkers(), version: "0.0.0", logger: false });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("GET /api/health (T15 acceptance)", () => {
  it("aggregates dependency checks — all ok", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(200);
    const body = HealthResponseSchema.parse(response.json());
    expect(body.status).toBe("ok");
    expect(body.dependencies.postgres.status).toBe("ok");
    expect(body.dependencies.postgres.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("degrades to 503 when a dependency is down", async () => {
    const degraded = await buildApp({
      healthCheckers: checkers({ nats: down }),
      logger: false,
    });
    const response = await degraded.inject({ method: "GET", url: "/api/health" });
    expect(response.statusCode).toBe(503);
    const body = HealthResponseSchema.parse(response.json());
    expect(body.status).toBe("degraded");
    expect(body.dependencies.nats).toMatchObject({ status: "down", error: "connection refused" });
    expect(body.dependencies.postgres.status).toBe("ok");
    await degraded.close();
  });
});

describe("problem+json error envelope (21 §2.5)", () => {
  it("unknown routes return a typed not_found problem", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    const problem = ProblemJsonSchema.parse(response.json());
    expect(problem.code).toBe("not_found");
    expect(problem.type).toBe("https://acos.dev/errors/not_found");
    expect(problem.requestId).toBeTruthy();
  });
});

describe("OpenAPI snapshot (21 §6 — drift check)", () => {
  it("matches the committed packages/contracts/openapi.json", () => {
    const generated = app.swagger();
    const committedPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../packages/contracts/openapi.json",
    );
    const committed = JSON.parse(readFileSync(committedPath, "utf8"));
    expect(generated).toEqual(committed);
  });
});
