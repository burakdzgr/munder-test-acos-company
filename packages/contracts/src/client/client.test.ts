import { describe, expect, it } from "vitest";
import { AcosApiError, createAcosClient } from "./index.js";
import { problemFor } from "../errors.js";

const HEALTH = {
  status: "ok",
  service: "server",
  version: "0.0.0",
  dependencies: {
    postgres: { status: "ok", latencyMs: 2 },
    nats: { status: "ok", latencyMs: 1 },
    temporal: { status: "ok", latencyMs: 1 },
  },
};

function fakeFetch(status: number, body: unknown, capture?: { url?: string; headers?: unknown }) {
  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (capture) {
      capture.url = String(url);
      capture.headers = init?.headers;
    }
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

describe("createAcosClient (21 §6)", () => {
  it("calls /api/health with the PAT bearer and parses the response", async () => {
    const capture: { url?: string; headers?: Record<string, string> } = {};
    const client = createAcosClient({
      baseUrl: "http://localhost:3000",
      token: "acos_pat_x",
      fetch: fakeFetch(200, HEALTH, capture) as typeof fetch,
    });
    const health = await client.health.get();
    expect(health.status).toBe("ok");
    expect(capture.url).toBe("http://localhost:3000/api/health");
    expect(capture.headers).toMatchObject({ authorization: "Bearer acos_pat_x" });
  });

  it("maps problem+json to a typed AcosApiError", async () => {
    const problem = problemFor("task_transition_invalid", "REVIEW -> DONE is not legal");
    const client = createAcosClient({
      baseUrl: "http://x",
      fetch: fakeFetch(409, problem) as typeof fetch,
    });
    await expect(client.health.get()).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(AcosApiError);
      expect((err as AcosApiError).problem.code).toBe("task_transition_invalid");
      return true;
    });
  });
});
