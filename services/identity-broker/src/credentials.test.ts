import { describe, expect, it } from "vitest";
import { buildUpstreamHeaders, CredentialError, OAUTH_BETA, resolveUpstreamCredential } from "./credentials.js";

describe("resolveUpstreamCredential — source order, read fresh, never defaults to nothing", () => {
  it("prefers CLAUDE_CODE_OAUTH_TOKEN, then ANTHROPIC_API_KEY, then the credentials file", () => {
    expect(resolveUpstreamCredential({ CLAUDE_CODE_OAUTH_TOKEN: "oat", ANTHROPIC_API_KEY: "key" })).toMatchObject({ kind: "oauth", secret: "oat" });
    expect(resolveUpstreamCredential({ ANTHROPIC_API_KEY: "key" })).toMatchObject({ kind: "api-key", secret: "key" });
    const file = JSON.stringify({ claudeAiOauth: { accessToken: "from-file", expiresAt: 123 } });
    expect(resolveUpstreamCredential({ CLAUDE_CREDENTIALS_FILE: "/x" }, () => file)).toEqual({ kind: "oauth", secret: "from-file", expiresAt: 123 });
  });

  it("surfaces unreadable / malformed / missing-token files as typed errors", () => {
    expect(() =>
      resolveUpstreamCredential({ CLAUDE_CREDENTIALS_FILE: "/nope" }, () => {
        throw new Error("ENOENT");
      }),
    ).toThrowError(CredentialError);
    expect(() => resolveUpstreamCredential({ CLAUDE_CREDENTIALS_FILE: "/x" }, () => "not json")).toThrowError(/not JSON/);
    expect(() => resolveUpstreamCredential({ CLAUDE_CREDENTIALS_FILE: "/x" }, () => "{}")).toThrowError(/no claudeAiOauth/);
  });
});

describe("buildUpstreamHeaders — strip identity, inject ours, forward the rest", () => {
  it("oauth: Bearer + oauth beta prepended once; inbound Authorization/x-api-key/host dropped", () => {
    const h = buildUpstreamHeaders(
      {
        host: "host.docker.internal:3779",
        authorization: "Bearer acos-sess-xyz",
        "x-api-key": "should-vanish",
        "anthropic-beta": "claude-code-20250219",
        "content-length": "10",
        "accept-encoding": "gzip",
        "user-agent": "claude-cli/2.1.237",
      },
      { kind: "oauth", secret: "HOST", expiresAt: null },
      "api.anthropic.com",
    );
    expect(h).toEqual({
      host: "api.anthropic.com",
      authorization: "Bearer HOST",
      "anthropic-beta": `${OAUTH_BETA},claude-code-20250219`,
      "user-agent": "claude-cli/2.1.237",
      "anthropic-version": "2023-06-01",
    });
    // idempotent on the beta flag
    const h2 = buildUpstreamHeaders({ "anthropic-beta": `${OAUTH_BETA},x` }, { kind: "oauth", secret: "H", expiresAt: null }, "u");
    expect(h2["anthropic-beta"]).toBe(`${OAUTH_BETA},x`);
  });

  it("api-key: x-api-key injected, no Authorization", () => {
    const h = buildUpstreamHeaders({ authorization: "Bearer acos-sess-xyz" }, { kind: "api-key", secret: "K", expiresAt: null }, "u");
    expect(h["x-api-key"]).toBe("K");
    expect(h.authorization).toBeUndefined();
  });
});
