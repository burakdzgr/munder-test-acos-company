// Contract-shape tests for the HTTP ports against a fake server speaking the
// T30 v1.2 contract (mint/revoke/admit) and the sandbox-manager/broker routes.
// These pin the exact paths + bodies so a drift on either side fails here, not
// in a live container.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdmissionClient, createBrokerClient, createGatewaySessionClient, createSandboxSessionClient } from "./clients.js";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: unknown;
}
const seen: Seen[] = [];
let server: Server;
let base = "";
let admitMode: "ok" | "busy" | "missing" = "ok";

beforeAll(async () => {
  server = createServer((req, res) => {
    let text = "";
    req.on("data", (d) => (text += d));
    req.on("end", () => {
      const body = text ? JSON.parse(text) : undefined;
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization, body });
      const send = (code: number, obj?: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(obj === undefined ? "" : JSON.stringify(obj));
      };
      if (req.url === "/internal/v1/mcp/sessions") return send(200, { sessionToken: "tok-1", mcpSessionId: "mcps-1", mcpUrl: "http://server:3000/mcp/v1", expiresAt: "2026-08-20T23:00:00Z" });
      if (req.url === "/internal/v1/mcp/sessions/mcps-1/revoke") return send(204);
      if (req.url === "/internal/v1/agent-sessions/admit") {
        if (admitMode === "missing") return send(404, { code: "not_found" });
        if (admitMode === "busy") return send(200, { admitted: false, cap: 3, reason: "company_cap", liveSessions: 3, retryAfterMs: 30_000 });
        return send(200, { admitted: true, cap: 3 });
      }
      if (req.url === "/internal/v1/sessions") return send(201, { sessionId: "s", token: "acos-sess-x", baseUrl: "http://host.docker.internal:3779", expiresAt: 1 });
      if (req.url === "/internal/v1/sessions/s?forget=1") return send(200, { sessionId: "s", requestCount: 2, totals: { totalTokens: 5 }, requests: [] });
      if (req.url?.endsWith("/agent-session/open")) return send(201, { sessionId: "t", opened: true });
      if (req.url?.endsWith("/agent-session/end")) return send(200, { running: false, exitCode: 0 });
      if (req.url?.endsWith("/agent-session")) return send(200, { running: true, exitCode: null });
      return send(404, { code: "not_found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("gateway MCP session client (T30 §1.1)", () => {
  it("mints with the INTERNAL token at POST /internal/v1/mcp/sessions and revokes by mcpSessionId", async () => {
    const gw = createGatewaySessionClient({ baseUrl: base, token: "internal-xyz" });
    const m = await gw.mint({ companyId: "co", agentId: "ag", taskId: "t", agentSessionId: "as", ttlSec: 3600 });
    expect(m).toEqual({ token: "tok-1", mcpSessionId: "mcps-1", mcpUrl: "http://server:3000/mcp/v1", expiresAt: "2026-08-20T23:00:00Z" });
    const mint = seen.at(-1)!;
    expect(mint).toMatchObject({ method: "POST", url: "/internal/v1/mcp/sessions", auth: "Bearer internal-xyz" });
    expect(mint.body).toEqual({ companyId: "co", agentId: "ag", taskId: "t", agentSessionId: "as", ttlSec: 3600 });
    await gw.revoke("mcps-1", "co");
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/internal/v1/mcp/sessions/mcps-1/revoke", body: { companyId: "co" } });
  });

  it("a missing/refusing endpoint throws gateway_unavailable (never an un-audited session)", async () => {
    const gw = createGatewaySessionClient({ baseUrl: `${base}/nope`, token: "x" });
    await expect(gw.mint({ companyId: "co", agentId: "ag", taskId: "t", agentSessionId: "as" })).rejects.toThrow(/gateway_unavailable|mcp-sessions mint/);
  });
});

describe("admission client (T30 §10)", () => {
  it("admitted / not admitted with retryAfterMs / 404 → admit (older server)", async () => {
    const adm = createAdmissionClient({ baseUrl: base, token: "internal-xyz" });
    admitMode = "ok";
    expect((await adm.admit({ companyId: "co", agentId: "ag", taskId: "t" })).admitted).toBe(true);
    expect(seen.at(-1)).toMatchObject({ url: "/internal/v1/agent-sessions/admit", body: { companyId: "co", agentId: "ag", taskId: "t" } });
    admitMode = "busy";
    expect(await adm.admit({ companyId: "co", agentId: "ag", taskId: "t" })).toEqual({ admitted: false, retryAfterMs: 30_000 });
    admitMode = "missing";
    expect((await adm.admit({ companyId: "co", agentId: "ag", taskId: "t" })).admitted).toBe(true);
  });
});

describe("broker + sandbox clients", () => {
  it("broker mint/revoke paths + sandbox agent-session open/status/end paths", async () => {
    const broker = createBrokerClient({ baseUrl: base, token: "secret" });
    const m = await broker.mint({ sessionId: "s", companyId: "co", agentId: "ag", taskId: "t", limits: {} });
    expect(m.ok && m.mint.token).toBe("acos-sess-x");
    expect(seen.at(-1)).toMatchObject({ url: "/internal/v1/sessions", auth: "Bearer secret" });
    expect((await broker.revoke("s"))?.requestCount).toBe(2);
    const sb = createSandboxSessionClient({ baseUrl: base, token: "internal-xyz" });
    expect(await sb.open({ terminalSessionId: "t", workspaceId: "w", env: { A: "b" }, cwd: "/work", cols: 10, rows: 10 })).toEqual({ opened: true });
    expect(seen.at(-1)).toMatchObject({ url: "/internal/v1/terminals/t/agent-session/open", body: { workspaceId: "w", env: { A: "b" }, cwd: "/work", cols: 10, rows: 10 } });
    expect(await sb.status("t")).toEqual({ running: true, exitCode: null });
    expect(await sb.end("t", 500)).toEqual({ running: false, exitCode: 0 });
    expect(seen.at(-1)).toMatchObject({ url: "/internal/v1/terminals/t/agent-session/end", body: { graceMs: 500 } });
  });
});
