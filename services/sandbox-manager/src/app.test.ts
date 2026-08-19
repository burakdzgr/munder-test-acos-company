// Auth + routing unit tests — the Docker layer is faked so these run
// anywhere (no daemon). The Docker-gated round-trip lives in the integration
// suite (test/integration).
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { DockerSandbox } from "./docker.js";
import type { GitWorkspaces } from "./git.js";
import type { Workspace } from "@acos/contracts";

const TOKEN = "internal-token-0123456789";

const workspace: Workspace = {
  workspaceId: "018f0000-0000-7000-8000-000000000001",
  containerId: "deadbeef",
  isolation: "coding",
  status: "running",
  createdAt: "2026-08-11T00:00:00.000Z",
};

const RING_SESSION = "018f0000-0000-7000-8000-00000000ea11";
const ringFrames = [
  { seq: 1, ts: 1000, stream: "stdout", data: Buffer.from("hello ").toString("base64") },
  { seq: 2, ts: 2000, stream: "stdout", data: Buffer.from("world\n").toString("base64") },
];

const fakeSandbox = {
  createWorkspace: async () => workspace,
  list: async () => [workspace],
  exec: async () => ({ exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 5, timedOut: false }),
  destroyWorkspace: async () => {},
  newTerminalSession: () => ({}) as never,
  terminalSession: (id: string) =>
    id === RING_SESSION ? { ringFrames: () => ringFrames, currentSeq: 2 } : undefined,
} as unknown as DockerSandbox;

const HEAD = "a".repeat(40);
const fakeGit = {
  ensureBareRepo: async (projectId: string) => ({
    barePath: `/data/repos/${projectId}.git`,
    headCommit: HEAD,
    created: true,
  }),
  provisionWorktree: async (input: { volumeName: string }) => ({
    volumeName: input.volumeName,
    baseCommit: HEAD,
    created: true,
  }),
  removeWorktree: async () => {},
} as unknown as GitWorkspaces;

let app: FastifyInstance;
const auth = { authorization: `Bearer ${TOKEN}` };

beforeAll(async () => {
  app = buildApp({ sandbox: fakeSandbox, git: fakeGit, internalApiToken: TOKEN, logger: false });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});

describe("sandbox-manager API auth (18 §2)", () => {
  it("serves /healthz without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ service: "sandbox-manager" });
  });

  it("rejects every internal route without the bearer (401)", async () => {
    expect((await app.inject({ method: "GET", url: "/internal/v1/workspaces" })).statusCode).toBe(401);
    const wrong = await app.inject({
      method: "GET",
      url: "/internal/v1/workspaces",
      headers: { authorization: "Bearer nope" },
    });
    expect(wrong.statusCode).toBe(401);
  });
});

describe("sandbox-manager routes", () => {
  it("creates a workspace (201) from a valid request", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/v1/workspaces",
      headers: auth,
      payload: { workspaceId: workspace.workspaceId, isolation: "coding" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ workspaceId: workspace.workspaceId, status: "running" });
  });

  it("rejects a malformed create (400)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/internal/v1/workspaces",
      headers: auth,
      payload: { workspaceId: "not-a-uuid", isolation: "coding" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("buffered exec returns the result inline (200)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/internal/v1/workspaces/${workspace.workspaceId}/exec`,
      headers: auth,
      payload: { command: ["echo", "ok"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ exitCode: 0, stdout: "ok\n", timedOut: false });
  });

  it("streaming exec acks 202 with the sessionId", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/internal/v1/workspaces/${workspace.workspaceId}/exec`,
      headers: auth,
      payload: { command: ["sh"], sessionId: "018f0000-0000-7000-8000-0000000000ff" },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ streaming: true });
  });

  it("destroy returns 204", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/internal/v1/workspaces/${workspace.workspaceId}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
  });
});

describe("git model routes (T38)", () => {
  it("ensures a bare repo (201 on create) and validates the project id", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/internal/v1/repos",
      headers: auth,
      payload: { projectId: "018f0000-0000-7000-8000-00000000aaaa" },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ headCommit: HEAD, created: true });

    const bad = await app.inject({
      method: "POST",
      url: "/internal/v1/repos",
      headers: auth,
      payload: { projectId: "not-a-uuid" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("provisions a worktree and enforces the branch/volume patterns", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/internal/v1/worktrees",
      headers: auth,
      payload: {
        projectId: "018f0000-0000-7000-8000-00000000aaaa",
        volumeName: "ws-81-018f0000",
        branch: "task/81-add-oauth-login",
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ volumeName: "ws-81-018f0000", baseCommit: HEAD });

    const badBranch = await app.inject({
      method: "POST",
      url: "/internal/v1/worktrees",
      headers: auth,
      payload: {
        projectId: "018f0000-0000-7000-8000-00000000aaaa",
        volumeName: "ws-81-018f0000",
        branch: "main", // never a task branch
      },
    });
    expect(badBranch.statusCode).toBe(400);
  });

  it("removes a worktree volume (204) and rejects non-worktree names", async () => {
    const ok = await app.inject({
      method: "DELETE",
      url: "/internal/v1/worktrees/ws-81-018f0000",
      headers: auth,
    });
    expect(ok.statusCode).toBe(204);

    // the repos volume can never be addressed through this route
    const bad = await app.inject({
      method: "DELETE",
      url: "/internal/v1/worktrees/acos-repos",
      headers: auth,
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe("terminal ring/log routes (T41)", () => {
  it("serves the live ring for a tracked session", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/internal/v1/terminals/${RING_SESSION}/ring`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: "ring", currentSeq: 2 });
    expect(res.json().frames).toHaveLength(2);
  });

  it("falls back to `none` for unknown sessions without log storage", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/internal/v1/terminals/018f0000-0000-7000-8000-00000000dead/ring",
      headers: auth,
    });
    expect(res.json()).toMatchObject({ source: "none", frames: [], currentSeq: 0 });
  });

  it("requires the internal bearer on terminal routes too", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/internal/v1/terminals/${RING_SESSION}/ring`,
    });
    expect(res.statusCode).toBe(401);
  });
});
