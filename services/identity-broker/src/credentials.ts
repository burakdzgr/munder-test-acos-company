// Upstream credential resolution — the ONLY place in ACOS that ever sees the
// subscription credential (INV-2/S2: agents never receive raw secrets).
//
// Sources, in order:
//   1. CLAUDE_CODE_OAUTH_TOKEN  — long-lived token from `claude setup-token`
//      (recommended for unattended operation; no refresh problem).
//   2. ANTHROPIC_API_KEY        — plain API key (x-api-key header upstream).
//   3. CLAUDE_CREDENTIALS_FILE  — the host Claude Code login
//      (~/.claude/.credentials.json, `claudeAiOauth.accessToken`). Read FRESH
//      on every request because the host CLI rotates it; if it has expired and
//      nothing on the host refreshes it, upstream answers 401 and the broker
//      surfaces `upstream_credential_expired`.
//
// The resolved value is handed straight to the outbound request builder and
// never logged, never echoed in any response, never stored on a session.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CredentialKind = "oauth" | "api-key";

export interface UpstreamCredential {
  readonly kind: CredentialKind;
  readonly secret: string;
  /** For oauth file credentials: the recorded expiry (ms epoch), if known. */
  readonly expiresAt: number | null;
}

export interface CredentialSourceEnv {
  readonly CLAUDE_CODE_OAUTH_TOKEN?: string | undefined;
  readonly ANTHROPIC_API_KEY?: string | undefined;
  readonly CLAUDE_CREDENTIALS_FILE?: string | undefined;
}

export function defaultCredentialsFile(): string {
  return join(homedir(), ".claude", ".credentials.json");
}

export class CredentialError extends Error {
  constructor(
    readonly code: "missing" | "unreadable" | "malformed",
    message: string,
  ) {
    super(message);
    this.name = "CredentialError";
  }
}

/** Resolve once per request (cheap: env lookup or one small file read). */
export function resolveUpstreamCredential(
  env: CredentialSourceEnv,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): UpstreamCredential {
  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (oauth) return { kind: "oauth", secret: oauth, expiresAt: null };
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) return { kind: "api-key", secret: apiKey, expiresAt: null };

  const file = env.CLAUDE_CREDENTIALS_FILE?.trim() || defaultCredentialsFile();
  let raw: string;
  try {
    raw = readFile(file);
  } catch (err) {
    throw new CredentialError("unreadable", `credentials file not readable: ${file} (${String((err as Error).message)})`);
  }
  let parsed: { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new CredentialError("malformed", `credentials file is not JSON: ${file}`);
  }
  const token = parsed.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new CredentialError("missing", `credentials file has no claudeAiOauth.accessToken: ${file}`);
  }
  const exp = parsed.claudeAiOauth?.expiresAt;
  return { kind: "oauth", secret: token, expiresAt: typeof exp === "number" ? exp : null };
}

/** Beta flag Claude Code sends when authenticating with an OAuth token. */
export const OAUTH_BETA = "oauth-2025-04-20";

/**
 * Rewrite the inbound (container CLI) headers into the outbound (upstream)
 * headers: strip everything identity-bearing the CLI sent, inject ours.
 * Returns a NEW object; never mutates the request.
 */
export function buildUpstreamHeaders(
  inbound: Readonly<Record<string, string | string[] | undefined>>,
  cred: UpstreamCredential,
  upstreamHost: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inbound)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    // hop-by-hop + identity + framing headers are never forwarded verbatim
    if (
      key === "host" ||
      key === "authorization" ||
      key === "x-api-key" ||
      key === "content-length" ||
      key === "connection" ||
      key === "accept-encoding" || // we re-stream raw bytes; no transfer re-encoding surprises
      key === "transfer-encoding" ||
      key === "proxy-authorization" ||
      key === "proxy-connection"
    ) {
      continue;
    }
    out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  out["host"] = upstreamHost;
  if (cred.kind === "oauth") {
    out["authorization"] = `Bearer ${cred.secret}`;
    const betas = (out["anthropic-beta"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!betas.includes(OAUTH_BETA)) betas.unshift(OAUTH_BETA);
    out["anthropic-beta"] = betas.join(",");
  } else {
    out["x-api-key"] = cred.secret;
  }
  if (!out["anthropic-version"]) out["anthropic-version"] = "2023-06-01";
  return out;
}
