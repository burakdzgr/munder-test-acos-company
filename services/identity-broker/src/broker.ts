// Identity broker (E4/T31, ADR-022 §4). A reverse proxy in front of the
// Anthropic Messages API that lets a `claude` CLI running INSIDE a workspace
// container authenticate with a per-session capability token, while the real
// subscription credential stays on the host, in this process only.
//
//   container CLI ──(ANTHROPIC_BASE_URL=broker, ANTHROPIC_AUTH_TOKEN=acos-sess-…)──▶ broker
//   broker ──(Authorization swapped for the host credential, stream passthrough)──▶ api.anthropic.com
//
// Two surfaces on one port:
//   * control plane (bearer = ACOS_BROKER_SECRET): mint / inspect / revoke sessions,
//     read metered usage (feeds session-level llm_calls).
//   * data plane (bearer = session token): POST /v1/messages* only. Everything
//     else is 404 — the broker is NOT a general Anthropic proxy.
//
// Zero domain state (INV-17 spirit): sessions live in memory; the runtime is
// the source of truth and re-mints after a broker restart.
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { buildUpstreamHeaders, CredentialError, type UpstreamCredential } from "./credentials.js";
import { SessionRegistry, type RefusalReason, type SessionLimits } from "./sessions.js";
import { UsageAccumulator } from "./usage.js";

export interface BrokerDeps {
  readonly registry: SessionRegistry;
  /** Control-plane bearer shared with the runtime that mints sessions. */
  readonly secret: string;
  /** Upstream API origin, e.g. https://api.anthropic.com */
  readonly upstream: URL;
  /** Resolved per request — see credentials.ts. Throws CredentialError. */
  readonly credential: () => UpstreamCredential;
  /** Base URL handed back to the minter so it can inject ANTHROPIC_BASE_URL. */
  readonly publicBaseUrl: string;
  /** Global safety valve on live sessions (NOT the company cap — that is the Scheduler's). */
  readonly maxLiveSessions?: number;
  readonly nowMs?: () => number;
  readonly log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Inbound body ceiling (bytes). */
  readonly maxBodyBytes?: number;
  /** Upstream socket inactivity timeout (ms). */
  readonly upstreamTimeoutMs?: number;
}

const MintSchema = z.object({
  sessionId: z.string().min(1).max(200),
  companyId: z.string().min(1).max(200),
  agentId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200).optional(),
  limits: z
    .object({
      maxTotalTokens: z.number().int().positive().optional(),
      maxWallMs: z.number().int().positive().optional(),
      maxRequests: z.number().int().positive().optional(),
    })
    .optional(),
});

export interface MintResponse {
  readonly sessionId: string;
  readonly token: string;
  readonly baseUrl: string;
  readonly expiresAt: number;
  readonly limits: SessionLimits;
}

const ALLOWED_DATA_PATHS = [/^\/v1\/messages(\?.*)?$/, /^\/v1\/messages\/count_tokens(\?.*)?$/];

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) return null;
  return h.slice("Bearer ".length).trim();
}

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** Anthropic-shaped error so the CLI renders it sensibly. */
function sendApiError(res: ServerResponse, status: number, type: string, message: string): void {
  sendJson(res, status, { type: "error", error: { type, message } });
}

function refusalStatus(reason: RefusalReason): { status: number; type: string } {
  switch (reason) {
    case "unknown_token":
    case "revoked":
    case "expired":
      // non-retryable for the CLI: it stops instead of backing off forever
      return { status: 401, type: "authentication_error" };
    case "token_budget_exhausted":
    case "request_budget_exhausted":
      // 403 (not 429): the Anthropic SDK retries 429 with backoff — a runaway
      // session must STOP, not wait. INV-19 at the session boundary.
      return { status: 403, type: "permission_error" };
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.byteLength;
      if (total > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createBrokerHandler(deps: BrokerDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const now = deps.nowMs ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  const maxBody = deps.maxBodyBytes ?? 32 * 1024 * 1024;
  const upstreamTimeout = deps.upstreamTimeoutMs ?? 10 * 60 * 1000;
  const maxLive = deps.maxLiveSessions ?? 12;
  const registry = deps.registry;
  let reqCounter = 0;

  const controlOk = (req: IncomingMessage): boolean => {
    const t = bearer(req);
    return t !== null && constantTimeEq(t, deps.secret);
  };

  return (req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    if (method === "GET" && url === "/healthz") {
      return sendJson(res, 200, {
        status: "ok",
        service: "identity-broker",
        liveSessions: registry.liveCount(),
        maxLiveSessions: maxLive,
      });
    }

    // CLI preflight (Bun `HEAD /api/hello`) — answered locally, no auth, no upstream.
    if (method === "HEAD" && url === "/api/hello") {
      res.writeHead(200);
      return res.end();
    }

    // ---------------- control plane ----------------
    if (url.startsWith("/internal/v1/sessions")) {
      if (!controlOk(req)) return sendJson(res, 401, { code: "unauthenticated", message: "broker secret required" });
      const m = /^\/internal\/v1\/sessions(?:\/([^/?]+))?(?:\/(usage))?(?:\?.*)?$/.exec(url);
      const sessionId = m?.[1] ? decodeURIComponent(m[1]) : null;
      const sub = m?.[2] ?? null;

      if (method === "POST" && !sessionId) {
        void readBody(req, 64 * 1024).then((buf) => {
          if (!buf) return sendJson(res, 413, { code: "payload_too_large" });
          let parsed: z.infer<typeof MintSchema>;
          try {
            parsed = MintSchema.parse(JSON.parse(buf.toString("utf8") || "{}"));
          } catch (err) {
            return sendJson(res, 400, { code: "validation_failed", message: String((err as Error).message) });
          }
          const existing = registry.get(parsed.sessionId);
          const isNew = !existing || existing.revokedAt !== null;
          if (isNew && registry.liveCount() >= maxLive) {
            log("mint refused: broker live-session ceiling", { sessionId: parsed.sessionId, maxLive });
            return sendJson(res, 429, {
              code: "broker_saturated",
              message: `broker live-session ceiling reached (${maxLive})`,
            });
          }
          const limits: Partial<SessionLimits> = {};
          if (parsed.limits?.maxTotalTokens !== undefined) (limits as { maxTotalTokens: number }).maxTotalTokens = parsed.limits.maxTotalTokens;
          if (parsed.limits?.maxWallMs !== undefined) (limits as { maxWallMs: number }).maxWallMs = parsed.limits.maxWallMs;
          if (parsed.limits?.maxRequests !== undefined) (limits as { maxRequests: number }).maxRequests = parsed.limits.maxRequests;
          const session = registry.mint({
            sessionId: parsed.sessionId,
            companyId: parsed.companyId,
            agentId: parsed.agentId,
            ...(parsed.taskId !== undefined ? { taskId: parsed.taskId } : {}),
            limits,
          });
          log(isNew ? "session minted" : "session re-issued", {
            sessionId: session.sessionId,
            companyId: session.companyId,
            agentId: session.agentId,
          });
          const body: MintResponse = {
            sessionId: session.sessionId,
            token: session.token,
            baseUrl: deps.publicBaseUrl,
            expiresAt: session.expiresAt,
            limits: session.limits,
          };
          return sendJson(res, isNew ? 201 : 200, body);
        });
        return;
      }
      if (method === "GET" && !sessionId) return sendJson(res, 200, { sessions: registry.list() });
      if (method === "GET" && sessionId) {
        const s = registry.summary(sessionId);
        if (!s) return sendJson(res, 404, { code: "not_found" });
        if (sub === "usage") {
          const full = registry.get(sessionId)!;
          return sendJson(res, 200, { ...s, requests: full.requests });
        }
        return sendJson(res, 200, s);
      }
      if (method === "DELETE" && sessionId) {
        const s = registry.revoke(sessionId);
        if (!s) return sendJson(res, 404, { code: "not_found" });
        log("session revoked", { sessionId, requests: s.requests.length });
        const summary = registry.summary(sessionId)!;
        // ?forget=1 → drop the record now (caller already drained usage)
        if (/[?&]forget=1/.test(url)) registry.forget(sessionId);
        return sendJson(res, 200, { ...summary, requests: s.requests });
      }
      return sendJson(res, 405, { code: "method_not_allowed" });
    }

    // ---------------- data plane ----------------
    if (!ALLOWED_DATA_PATHS.some((re) => re.test(url)) || method !== "POST") {
      return sendApiError(res, 404, "not_found_error", `broker: ${method} ${url.split("?")[0]} is not proxied`);
    }
    const token = bearer(req) ?? (typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : null);
    if (!token) return sendApiError(res, 401, "authentication_error", "broker: session token required");
    const admission = registry.admit(token);
    if (!admission.ok) {
      const { status, type } = refusalStatus(admission.reason);
      log("request refused", { reason: admission.reason });
      return sendApiError(res, status, type, `broker: session ${admission.reason}`);
    }
    const session = admission.session;

    let cred: UpstreamCredential;
    try {
      cred = deps.credential();
    } catch (err) {
      const code = err instanceof CredentialError ? err.code : "unknown";
      log("upstream credential unavailable", { code, sessionId: session.sessionId });
      return sendApiError(res, 503, "api_error", `broker: upstream credential unavailable (${code})`);
    }
    if (cred.expiresAt !== null && cred.expiresAt <= now()) {
      log("upstream credential expired on host — run `claude` on the host or set CLAUDE_CODE_OAUTH_TOKEN", {
        sessionId: session.sessionId,
      });
      // still try: the file may be stale while the token is actually fine
    }

    session.inflight++;
    const requestId = `${session.sessionId}:${++reqCounter}:${now()}`;
    const startedAt = now();
    const finish = (status: number, usage: ReturnType<UsageAccumulator["result"]>) => {
      session.inflight--;
      registry.record(session.sessionId, {
        requestId,
        model: usage.model,
        startedAt,
        durationMs: now() - startedAt,
        status,
        usage: usage.usage,
      });
      log("proxied", {
        sessionId: session.sessionId,
        agentId: session.agentId,
        status,
        durationMs: now() - startedAt,
        model: usage.model,
        usage: usage.usage,
      });
    };

    void readBody(req, maxBody).then(
      (body) => {
        if (!body) {
          finish(413, { usage: null, model: null });
          return sendApiError(res, 413, "invalid_request_error", "broker: request body too large");
        }
        const headers = buildUpstreamHeaders(req.headers, cred, deps.upstream.host);
        headers["content-length"] = String(body.byteLength);
        const doRequest = deps.upstream.protocol === "http:" ? httpRequest : httpsRequest;
        const up = doRequest(
          {
            protocol: deps.upstream.protocol,
            hostname: deps.upstream.hostname,
            port: deps.upstream.port || undefined,
            method: "POST",
            path: url,
            headers,
            timeout: upstreamTimeout,
          },
          (ur) => {
            const status = ur.statusCode ?? 502;
            const acc = new UsageAccumulator(ur.headers["content-type"]);
            const outHeaders: Record<string, string | string[]> = {};
            for (const [k, v] of Object.entries(ur.headers)) {
              if (v === undefined) continue;
              if (k === "content-encoding" || k === "transfer-encoding" || k === "connection") continue;
              outHeaders[k] = v;
            }
            res.writeHead(status, outHeaders);
            ur.on("data", (chunk: Buffer) => {
              acc.push(chunk);
              res.write(chunk);
            });
            ur.on("end", () => {
              res.end();
              if (status === 401 && cred.kind === "oauth") {
                log("upstream 401 with oauth credential — host credential likely expired/revoked", {
                  sessionId: session.sessionId,
                });
              }
              finish(status, acc.result());
            });
            ur.on("error", () => {
              res.destroy();
              finish(status, acc.result());
            });
          },
        );
        up.on("timeout", () => up.destroy(new Error("upstream timeout")));
        up.on("error", (err) => {
          if (!res.headersSent) sendApiError(res, 502, "api_error", `broker: upstream error (${err.message})`);
          else res.destroy();
          finish(0, { usage: null, model: null });
        });
        // client went away (CLI killed / session closed) → stop paying for the stream
        res.on("close", () => {
          if (!res.writableFinished) up.destroy();
        });
        up.end(body);
      },
      (err: Error) => {
        finish(0, { usage: null, model: null });
        if (!res.headersSent) sendApiError(res, 400, "invalid_request_error", `broker: ${err.message}`);
      },
    );
  };
}

export function createBrokerServer(deps: BrokerDeps): Server {
  return createServer(createBrokerHandler(deps));
}
