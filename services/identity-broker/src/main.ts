// identity-broker boot. Runs on the HOST (where the Claude Code login lives)
// or as a compose service that receives CLAUDE_CODE_OAUTH_TOKEN — never
// inside a workspace container. Like sandbox-manager it needs only its own
// handful of env vars, not the control-plane config.
//
//   IDENTITY_BROKER_PORT        default 3779
//   IDENTITY_BROKER_HOST        default 0.0.0.0 (containers reach the host via host.docker.internal)
//   IDENTITY_BROKER_PUBLIC_URL  default http://host.docker.internal:<port> — what containers get as ANTHROPIC_BASE_URL
//   ACOS_BROKER_SECRET          REQUIRED, ≥16 chars — control-plane bearer (mint/revoke/usage)
//   ANTHROPIC_UPSTREAM_URL      default https://api.anthropic.com
//   BROKER_MAX_LIVE_SESSIONS    default 12 (global safety valve; the company cap is the Scheduler's)
//   BROKER_REAP_GRACE_MS        default 600000 — ended sessions are forgotten after this
//   credential: CLAUDE_CODE_OAUTH_TOKEN | ANTHROPIC_API_KEY | CLAUDE_CREDENTIALS_FILE (see credentials.ts)
import { createBrokerServer } from "./broker.js";
import { defaultCredentialsFile, resolveUpstreamCredential } from "./credentials.js";
import { SessionRegistry } from "./sessions.js";

function requireEnv(name: string, minLen = 1): string {
  const value = process.env[name];
  if (!value || value.trim().length < minLen) {
    console.error(`identity-broker: missing/short required env ${name} (min ${minLen} chars)`);
    process.exit(1);
  }
  return value;
}

function main(): void {
  const port = Number(process.env.IDENTITY_BROKER_PORT ?? 3779);
  const host = process.env.IDENTITY_BROKER_HOST ?? "0.0.0.0";
  const secret = requireEnv("ACOS_BROKER_SECRET", 16);
  const upstream = new URL(process.env.ANTHROPIC_UPSTREAM_URL ?? "https://api.anthropic.com");
  const publicBaseUrl = process.env.IDENTITY_BROKER_PUBLIC_URL ?? `http://host.docker.internal:${port}`;
  const maxLiveSessions = Number(process.env.BROKER_MAX_LIVE_SESSIONS ?? 12);
  const reapGraceMs = Number(process.env.BROKER_REAP_GRACE_MS ?? 10 * 60 * 1000);
  const log = (msg: string, meta?: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...meta }));

  const env = {
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    CLAUDE_CREDENTIALS_FILE: process.env.CLAUDE_CREDENTIALS_FILE,
  };
  // fail fast at boot if no credential source resolves — but never print it
  try {
    const c = resolveUpstreamCredential(env);
    log("upstream credential source ok", {
      kind: c.kind,
      source: env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY" : (env.CLAUDE_CREDENTIALS_FILE ?? defaultCredentialsFile()),
      expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null,
    });
  } catch (err) {
    console.error(`identity-broker: ${String((err as Error).message)}`);
    process.exit(1);
  }

  const registry = new SessionRegistry();
  const server = createBrokerServer({
    registry,
    secret,
    upstream,
    credential: () => resolveUpstreamCredential(env),
    publicBaseUrl,
    maxLiveSessions,
    log,
  });
  const reaper = setInterval(() => {
    const dropped = registry.reap(reapGraceMs);
    if (dropped.length) log("sessions reaped", { count: dropped.length });
  }, 60_000);

  server.listen(port, host, () => {
    log("identity-broker listening", { host, port, publicBaseUrl, upstream: upstream.origin, maxLiveSessions });
    if (host === "0.0.0.0") {
      log("note: bound on all interfaces so Docker containers can reach host.docker.internal; data plane needs a session token, control plane needs ACOS_BROKER_SECRET");
    }
  });

  const shutdown = () => {
    clearInterval(reaper);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
