// Agent CLI session routes (E4/T31) — the Docker layer is faked; the contract
// pinned here: auth, validation, the INV-2 raw-credential refusal at the seam,
// idempotent open, status + end passthrough.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { AgentSessionOpen, AgentSessionStatus, DockerSandbox } from "./docker.js";
import type { GitWorkspaces } from "./git.js";

const TOKEN = "internal-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const opens: AgentSessionOpen[] = [];
let running = true;

const fakeSandbox = {
  openAgentSession: async (input: AgentSessionOpen) => {
    opens.push(input);
    return { opened: opens.filter((o) => o.sessionId === input.sessionId).length === 1 };
  },
  agentSessionStatus: (sessionId: string): AgentSessionStatus | undefined =>
    sessionId === "known"
      ? { sessionId, workspaceId: "ws-1", running, startedAt: 1, endedAt: running ? null : 2, exitCode: running ? null : 0 }
      : undefined,
  endAgentSession: async (sessionId: string, graceMs: number): Promise<AgentSessionStatus | undefined> => {
    if (sessionId !== "known") return undefined;
    running = false;
    return { sessionId, workspaceId: "ws-1", running: false, startedAt: 1, endedAt: 2, exitCode: graceMs };
  },
} as unknown as DockerSandbox;

let app: FastifyInstance;
beforeAll(async () => {
  app = buildApp({ sandbox: fakeSandbox, git: {} as GitWorkspaces, internalApiToken: TOKEN, logger: false });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("agent-session routes (E4/T31, ADR-022)", () => {
  it("requires the internal bearer", async () => {
    const res = await app.inject({ method: "POST", url: "/internal/v1/terminals/s1/agent-session/open", payload: { workspaceId: "ws" } });
    expect(res.statusCode).toBe(401);
  });

  it("opens with the brokered env (201), idempotent re-open is 200/opened:false", async () => {
    const payload = {
      workspaceId: "ws-1",
      cols: 100,
      rows: 30,
      cwd: "/work",
      env: {
        ANTHROPIC_BASE_URL: "http://host.docker.internal:3779",
        ANTHROPIC_AUTH_TOKEN: "acos-sess-abc",
        ACOS_GATEWAY_URL: "http://server:3000",
        ACOS_GATEWAY_TOKEN: "gw-1",
        ACOS_PROMPT: "do the task",
      },
    };
    const a = await app.inject({ method: "POST", url: "/internal/v1/terminals/s1/agent-session/open", headers: auth, payload });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toEqual({ sessionId: "s1", opened: true });
    expect(opens[0]).toMatchObject({ sessionId: "s1", workspaceId: "ws-1", cols: 100, rows: 30, cwd: "/work" });
    expect(opens[0]!.env.ANTHROPIC_AUTH_TOKEN).toBe("acos-sess-abc");
    const b = await app.inject({ method: "POST", url: "/internal/v1/terminals/s1/agent-session/open", headers: auth, payload });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual({ sessionId: "s1", opened: false });
  });

  it("refuses a raw provider credential in env (INV-2 at the seam)", async () => {
    for (const env of [
      { ANTHROPIC_API_KEY: "whatever" },
      { CLAUDE_CODE_OAUTH_TOKEN: "whatever" },
      { ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-real-looking" },
      { SOMETHING: "sk-ant-api03-real-looking" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/internal/v1/terminals/s2/agent-session/open",
        headers: auth,
        payload: { workspaceId: "ws-1", env },
      });
      expect(res.statusCode, JSON.stringify(env)).toBe(400);
      expect(res.json().code).toBe("raw_credential_rejected");
    }
    expect(opens.some((o) => o.sessionId === "s2")).toBe(false);
  });

  it("validates env key shape and cwd", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/internal/v1/terminals/s3/agent-session/open",
      headers: auth,
      payload: { workspaceId: "ws-1", env: { "bad-key": "x" } },
    });
    expect(bad.statusCode).toBe(400);
    const rel = await app.inject({
      method: "POST",
      url: "/internal/v1/terminals/s3/agent-session/open",
      headers: auth,
      payload: { workspaceId: "ws-1", cwd: "relative" },
    });
    expect(rel.statusCode).toBe(400);
  });

  it("status: 404 unknown, live status otherwise", async () => {
    expect((await app.inject({ method: "GET", url: "/internal/v1/terminals/nope/agent-session", headers: auth })).statusCode).toBe(404);
    const res = await app.inject({ method: "GET", url: "/internal/v1/terminals/known/agent-session", headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ sessionId: "known", running: true });
  });

  it("end: passes graceMs, returns final status; 404 unknown", async () => {
    const res = await app.inject({ method: "POST", url: "/internal/v1/terminals/known/agent-session/end", headers: auth, payload: { graceMs: 1234 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ running: false, exitCode: 1234 });
    expect((await app.inject({ method: "POST", url: "/internal/v1/terminals/nope/agent-session/end", headers: auth, payload: {} })).statusCode).toBe(404);
  });
});
