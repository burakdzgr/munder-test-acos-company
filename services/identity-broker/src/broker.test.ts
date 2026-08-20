// Broker behaviour against a FAKE upstream: the tests pin the security
// contract (credential swapped, never leaked; session token required; budget
// refusals are non-retryable) and the metering contract (usage per session).
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrokerServer, type MintResponse } from "./broker.js";
import { OAUTH_BETA } from "./credentials.js";
import { SessionRegistry } from "./sessions.js";

const HOST_SECRET = "sk-ant-oat01-HOST-CREDENTIAL-NEVER-LEAKS";
const BROKER_SECRET = "broker-control-secret-0123456789";

interface Seen {
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

let upstream: Server;
let broker: Server;
let upstreamUrl: URL;
let brokerUrl: string;
const seen: Seen[] = [];
const logs: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
let upstreamMode: "sse" | "json401" | "hang" = "sse";

function sseBody(): string {
  const ev = (o: unknown) => `event: e\ndata: ${JSON.stringify(o)}\n\n`;
  return (
    ev({ type: "message_start", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 120, cache_read_input_tokens: 30 } } }) +
    ev({ type: "content_block_delta", delta: { type: "text_delta", text: "pong" } }) +
    ev({ type: "message_delta", usage: { output_tokens: 7 } }) +
    ev({ type: "message_stop" })
  );
}

async function call(
  path: string,
  opts: { method?: string; token?: string; body?: unknown; rawHeaders?: Record<string, string> } = {},
): Promise<{ status: number; headers: IncomingMessage["headers"]; text: string }> {
  const u = new URL(path, brokerUrl);
  const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method ?? (payload ? "POST" : "GET"),
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
          ...(opts.rawHeaders ?? {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (d) => (text += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function mint(sessionId: string, limits?: Record<string, number>): Promise<MintResponse> {
  const r = await call("/internal/v1/sessions", {
    token: BROKER_SECRET,
    body: { sessionId, companyId: "co-1", agentId: "ag-1", taskId: "task-1", ...(limits ? { limits } : {}) },
  });
  expect([200, 201]).toContain(r.status);
  return JSON.parse(r.text) as MintResponse;
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      if (upstreamMode === "hang") return; // never answers — client-abort test
      if (upstreamMode === "json401") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad" } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream", "x-upstream": "yes" });
      res.end(sseBody());
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamUrl = new URL(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);

  const registry = new SessionRegistry();
  broker = createBrokerServer({
    registry,
    secret: BROKER_SECRET,
    upstream: upstreamUrl,
    credential: () => ({ kind: "oauth", secret: HOST_SECRET, expiresAt: null }),
    publicBaseUrl: "http://host.docker.internal:3779",
    maxLiveSessions: 50,
    log: (msg, meta) => logs.push(meta ? { msg, meta } : { msg }),
  });
  await new Promise<void>((r) => broker.listen(0, "127.0.0.1", r));
  brokerUrl = `http://127.0.0.1:${(broker.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => broker.close(() => r()));
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe("identity broker — control plane", () => {
  it("healthz is open; session routes need the broker secret", async () => {
    expect((await call("/healthz")).status).toBe(200);
    expect((await call("/internal/v1/sessions")).status).toBe(401);
    expect((await call("/internal/v1/sessions", { token: "wrong" })).status).toBe(401);
  });

  it("mints a session token + hands back the public base URL; re-mint is idempotent", async () => {
    const a = await mint("s-idem");
    const b = await mint("s-idem");
    expect(a.token).toMatch(/^acos-sess-/);
    expect(a.baseUrl).toBe("http://host.docker.internal:3779");
    expect(b.token).toBe(a.token);
    expect(a.token).not.toContain(HOST_SECRET);
  });

  it("refuses to mint past the broker live-session ceiling (safety valve, 429); revoke frees the slot", async () => {
    const registry = new SessionRegistry();
    const b = createBrokerServer({
      registry,
      secret: BROKER_SECRET,
      upstream: upstreamUrl,
      credential: () => ({ kind: "oauth", secret: HOST_SECRET, expiresAt: null }),
      publicBaseUrl: "http://x",
      maxLiveSessions: 2,
    });
    await new Promise<void>((r) => b.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(b.address() as AddressInfo).port}`;
    const mintAt = (id: string) =>
      fetch(`${base}/internal/v1/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${BROKER_SECRET}`, "content-type": "application/json" },
        body: JSON.stringify({ sessionId: id, companyId: "c", agentId: "a" }),
      });
    expect((await mintAt("cap-1")).status).toBe(201);
    expect((await mintAt("cap-2")).status).toBe(201);
    expect((await mintAt("cap-3")).status).toBe(429);
    expect((await mintAt("cap-1")).status).toBe(200); // re-issue of a live one is not a new slot
    await fetch(`${base}/internal/v1/sessions/cap-1`, { method: "DELETE", headers: { authorization: `Bearer ${BROKER_SECRET}` } });
    expect((await mintAt("cap-3")).status).toBe(201);
    await new Promise<void>((r) => b.close(() => r()));
  });
});

describe("identity broker — data plane", () => {
  it("swaps the session token for the host credential, adds the oauth beta, streams SSE through, meters usage", async () => {
    upstreamMode = "sse";
    const m = await mint("s-proxy");
    const r = await call("/v1/messages?beta=true", {
      token: m.token,
      body: { model: "claude-sonnet-4-5", stream: true, messages: [{ role: "user", content: "ping" }] },
      rawHeaders: { "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14", "x-app": "cli" },
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toContain("text/event-stream");
    expect(r.headers["x-upstream"]).toBe("yes");
    expect(r.text).toContain('"text":"pong"');

    const up = seen.at(-1)!;
    expect(up.url).toBe("/v1/messages?beta=true");
    expect(up.headers.authorization).toBe(`Bearer ${HOST_SECRET}`); // injected
    expect(up.headers["anthropic-beta"]).toBe(`${OAUTH_BETA},claude-code-20250219,interleaved-thinking-2025-05-14`);
    expect(up.headers["x-app"]).toBe("cli"); // passthrough of non-identity headers
    expect(JSON.parse(up.body).messages[0].content).toBe("ping");

    const usage = await call("/internal/v1/sessions/s-proxy/usage", { token: BROKER_SECRET });
    const u = JSON.parse(usage.text) as { requestCount: number; totals: Record<string, number>; requests: Array<{ model: string; status: number }> };
    expect(u.requestCount).toBe(1);
    expect(u.requests[0]).toMatchObject({ model: "claude-sonnet-4-5", status: 200 });
    expect(u.totals).toMatchObject({ inputTokens: 120, outputTokens: 7, cacheReadInputTokens: 30, totalTokens: 157 });
  });

  it("the host credential never appears in any response or log line", async () => {
    const m = await mint("s-leak");
    const r = await call("/v1/messages", { token: m.token, body: { messages: [] } });
    expect(r.text).not.toContain(HOST_SECRET);
    const all = await call("/internal/v1/sessions", { token: BROKER_SECRET });
    expect(all.text).not.toContain(HOST_SECRET);
    expect(JSON.stringify(logs)).not.toContain(HOST_SECRET);
    const hdrs = JSON.stringify(r.headers);
    expect(hdrs).not.toContain(HOST_SECRET);
  });

  it("no token / unknown token / revoked token → 401 (non-retryable)", async () => {
    expect((await call("/v1/messages", { body: {} })).status).toBe(401);
    expect((await call("/v1/messages", { token: "acos-sess-unknown", body: {} })).status).toBe(401);
    const m = await mint("s-revoke");
    await call("/internal/v1/sessions/s-revoke", { method: "DELETE", token: BROKER_SECRET });
    const r = await call("/v1/messages", { token: m.token, body: {} });
    expect(r.status).toBe(401);
    expect(JSON.parse(r.text).error.type).toBe("authentication_error");
  });

  it("budget exhaustion → 403 permission_error (SDK does not retry 403) and usage survives revoke", async () => {
    const m = await mint("s-budget", { maxRequests: 1 });
    expect((await call("/v1/messages", { token: m.token, body: {} })).status).toBe(200);
    const r = await call("/v1/messages", { token: m.token, body: {} });
    expect(r.status).toBe(403);
    expect(JSON.parse(r.text).error.message).toContain("request_budget_exhausted");
    const del = await call("/internal/v1/sessions/s-budget", { method: "DELETE", token: BROKER_SECRET });
    expect(JSON.parse(del.text).requestCount).toBe(1);
  });

  it("only POST /v1/messages* is proxied — everything else 404 without touching upstream", async () => {
    const m = await mint("s-paths");
    const before = seen.length;
    expect((await call("/v1/models", { token: m.token })).status).toBe(404);
    expect((await call("/api/oauth/profile", { token: m.token })).status).toBe(404);
    expect((await call("/v1/messages", { method: "GET", token: m.token })).status).toBe(404);
    expect(seen.length).toBe(before);
    // CLI preflight answered locally
    expect((await call("/api/hello", { method: "HEAD" })).status).toBe(200);
    expect(seen.length).toBe(before);
  });

  it("upstream 401 is passed through and flagged as a host-credential problem", async () => {
    upstreamMode = "json401";
    const m = await mint("s-up401");
    const r = await call("/v1/messages", { token: m.token, body: {} });
    expect(r.status).toBe(401);
    expect(logs.some((l) => l.msg.includes("upstream 401"))).toBe(true);
    upstreamMode = "sse";
  });

  it("credential resolution failure → 503 api_error, nothing sent upstream", async () => {
    const registry = new SessionRegistry();
    const b = createBrokerServer({
      registry,
      secret: BROKER_SECRET,
      upstream: upstreamUrl,
      credential: () => {
        throw new Error("boom");
      },
      publicBaseUrl: "http://x",
    });
    await new Promise<void>((r) => b.listen(0, "127.0.0.1", r));
    const port = (b.address() as AddressInfo).port;
    const s = registry.mint({ sessionId: "s", companyId: "c", agentId: "a" });
    const before = seen.length;
    const r = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = httpRequest(
        { hostname: "127.0.0.1", port, path: "/v1/messages", method: "POST", headers: { authorization: `Bearer ${s.token}`, "content-length": 2 } },
        (res) => {
          let text = "";
          res.on("data", (d) => (text += d));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(r.status).toBe(503);
    expect(seen.length).toBe(before);
    await new Promise<void>((r2) => b.close(() => r2()));
  });
});
