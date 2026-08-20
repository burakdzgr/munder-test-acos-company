// HTTP implementations of the driver's ports. Three services, three bearers:
//   sandbox-manager  — INTERNAL_API_TOKEN (execution plane, S1 owner)
//   identity broker  — ACOS_BROKER_SECRET (mint/usage/revoke; never the credential)
//   tool gateway     — INTERNAL_API_TOKEN (mints the per-session gateway bearer; T30)
// Plus the WorkspaceService SandboxPort over sandbox-manager (mirrors the
// server's dispatch port) so the worker can provision the task workspace
// itself before the session starts.
import type { IsolationLevel } from "@acos/tools";
import type { SandboxPort } from "@acos/db";
import type { BrokerPort, BrokerSessionSummary, GatewaySessionPort, SandboxSessionPort } from "./ports.js";
import { CliSessionError } from "./drive.js";

interface HttpOpts {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

async function call<T>(opts: HttpOpts, method: string, path: string, body?: unknown): Promise<{ status: number; json: T | null }> {
  const f = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await f(`${opts.baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${opts.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json: T | null = null;
    try {
      json = text ? (JSON.parse(text) as T) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- sandbox

export function createSandboxSessionClient(opts: HttpOpts): SandboxSessionPort {
  return {
    async open(input) {
      const r = await call<{ sessionId: string; opened: boolean }>(opts, "POST", `/internal/v1/terminals/${input.terminalSessionId}/agent-session/open`, {
        workspaceId: input.workspaceId,
        env: input.env,
        cwd: input.cwd,
        cols: input.cols,
        rows: input.rows,
      });
      if (r.status !== 200 && r.status !== 201) {
        throw new CliSessionError("sandbox_open_failed", `sandbox-manager agent-session/open → ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
      }
      return { opened: Boolean(r.json?.opened) };
    },
    async status(terminalSessionId) {
      const r = await call<{ running: boolean; exitCode: number | null }>(opts, "GET", `/internal/v1/terminals/${terminalSessionId}/agent-session`);
      if (r.status === 404 || !r.json) return null;
      return { running: r.json.running, exitCode: r.json.exitCode };
    },
    async end(terminalSessionId, graceMs) {
      const r = await call<{ running: boolean; exitCode: number | null }>(opts, "POST", `/internal/v1/terminals/${terminalSessionId}/agent-session/end`, { graceMs }, );
      if (r.status === 404 || !r.json) return null;
      return { running: r.json.running, exitCode: r.json.exitCode };
    },
  };
}

/** WorkspaceService's SandboxPort over sandbox-manager (same shapes as the
 *  server's dispatch port). `volumeName === ""` means "no worktree": the
 *  light session workspace for planning agents (ADR-022 §2). */
export function createWorkspaceSandboxPort(opts: HttpOpts, image: string, isolation: IsolationLevel): SandboxPort {
  return {
    async ensureRepo(projectId) {
      const r = await call<{ barePath: string; headCommit: string }>(opts, "POST", "/internal/v1/repos", { projectId });
      if (!r.json || r.status >= 300) throw new Error(`sandbox-manager ensureRepo → ${r.status}`);
      return r.json;
    },
    async provisionWorktree(input) {
      const r = await call<{ baseCommit: string }>(opts, "POST", "/internal/v1/worktrees", input);
      if (!r.json || r.status >= 300) throw new Error(`sandbox-manager provisionWorktree → ${r.status}`);
      return r.json;
    },
    async createContainer({ workspaceId, volumeName }) {
      const r = await call<{ containerId: string }>(opts, "POST", "/internal/v1/workspaces", {
        workspaceId,
        isolation,
        image,
        env: {},
        labels: {},
        mounts: volumeName ? [{ source: volumeName, target: "/work", readonly: false, type: "volume" }] : [],
      });
      if (!r.json || r.status >= 300) throw new Error(`sandbox-manager createWorkspace → ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
      return { containerId: r.json.containerId };
    },
    async destroyContainer(workspaceId) {
      await call(opts, "DELETE", `/internal/v1/workspaces/${workspaceId}`);
    },
    async removeWorktree(volumeName) {
      await call(opts, "DELETE", `/internal/v1/worktrees/${volumeName}`);
    },
  };
}

// ----------------------------------------------------------------- broker

export function createBrokerClient(opts: HttpOpts): BrokerPort {
  return {
    async mint(input) {
      const r = await call<{ token: string; baseUrl: string; expiresAt: number } | { code: string; message?: string }>(opts, "POST", "/internal/v1/sessions", input);
      if (r.status === 429) return { ok: false, saturated: true, retryAfterMs: 15_000 };
      if ((r.status !== 200 && r.status !== 201) || !r.json || !("token" in r.json)) {
        throw new Error(`identity-broker mint → ${r.status} ${JSON.stringify(r.json)?.slice(0, 200)}`);
      }
      return { ok: true, mint: { token: r.json.token, baseUrl: r.json.baseUrl, expiresAt: r.json.expiresAt } };
    },
    async summary(sessionId) {
      const r = await call<BrokerSessionSummary>(opts, "GET", `/internal/v1/sessions/${encodeURIComponent(sessionId)}`);
      return r.status === 200 ? r.json : null;
    },
    async revoke(sessionId) {
      const r = await call<BrokerSessionSummary>(opts, "DELETE", `/internal/v1/sessions/${encodeURIComponent(sessionId)}?forget=1`);
      return r.status === 200 ? r.json : null;
    },
  };
}

// ---------------------------------------------------------------- gateway

/**
 * Gateway session tokens — T30 contract (Oscar): POST /internal/v1/agent-sessions
 * → { token, ... }; DELETE /internal/v1/agent-sessions/:token. Until the
 * endpoint exists the worker fails the CLI turn fast and loudly
 * (`gateway_unavailable`) instead of running an un-audited session.
 * `containerGatewayUrl` is the address the CONTAINER uses (compose service
 * name through the egress proxy), not the worker's.
 */
export function createGatewaySessionClient(opts: HttpOpts & { containerGatewayUrl: string }): GatewaySessionPort {
  return {
    async mint(input) {
      const r = await call<{ token?: string; gatewaySessionToken?: string }>(opts, "POST", "/internal/v1/agent-sessions", input);
      const token = r.json?.token ?? r.json?.gatewaySessionToken;
      if ((r.status !== 200 && r.status !== 201) || !token) {
        throw new CliSessionError(
          "gateway_unavailable",
          `tool gateway agent-sessions mint → ${r.status} (T30 endpoint missing or refused) — refusing to run an un-audited CLI session`,
        );
      }
      return { token, containerGatewayUrl: opts.containerGatewayUrl };
    },
    async revoke(token) {
      await call(opts, "DELETE", `/internal/v1/agent-sessions/${encodeURIComponent(token)}`);
    },
  };
}
