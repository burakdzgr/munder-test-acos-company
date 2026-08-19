# ADR-013: Authentication — Local Cookie Sessions, Argon2id, Optional TOTP, PATs

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

Authentication is for **humans and their API clients** — agents are not users; they act through
the domain with their own identity and permission model (ADR-014). Forces:

- **Single operator now, multi-user by design.** MVP has exactly one human (the Founder), but auth
  must be designed multi-user from the start (_DECISIONS §0 A1); multi-human org membership and
  OIDC are Phase 3.
- **Self-hosted, possibly offline.** The platform must work on a LAN with no internet
  (_DECISIONS §0 A3 degraded profile). Any hard dependency on a third-party IdP breaks the
  local-first promise and adds signup friction to `docker compose up`.
- **Session semantics needed.** The WebSocket gateway authenticates upgrades via session cookie
  (_DECISIONS §16); the Founder approves irreversible actions through this session — instant
  revocation matters.
- **Automation access.** CLI tools and external scripts need long-lived credentials: personal
  access tokens (PATs) scoped and revocable.
- **High-value target.** The session controls approval of R3 actions, secrets management, and
  spending; credential handling must be state of the art but operable by one person.

## Options considered

### Option A: Require an external IdP (OIDC — Auth0/Keycloak/authentik)

- **Description.** Delegate all authentication to an OIDC provider; the app only consumes tokens.
- **Pros.** Standards-based SSO; MFA/passkeys/lockout policies outsourced; the right answer for
  fleet/enterprise deployments.
- **Cons.** SaaS IdP breaks offline and adds third-party dependency for a one-user system;
  self-hosting Keycloak/authentik adds a heavyweight stateful service (own DB, upgrade cycle) to
  the compose stack — disproportionate for one Founder. First-run experience degrades from
  "open the page, create account" to IdP configuration.
- **Rejected as a requirement because** self-host friction; **OIDC lands as an optional Phase 3
  integration** for multi-human orgs, coexisting with local accounts.

### Option B: Stateless JWTs (access/refresh tokens)

- **Description.** Sign JWTs on login; verify statelessly; refresh-token rotation.
- **Pros.** No session store lookups; natural for distributed APIs; familiar pattern.
- **Cons.** Statelessness is the flaw here: instant revocation (stolen browser, panicked "log
  everything out") requires a denylist — reintroducing state and erasing the benefit. Token
  storage in the browser invites XSS exfiltration unless cookie-wrapped anyway. We have exactly
  one server and Postgres in-process latency; the scaling argument for statelessness is void.
- **Rejected because** revocation semantics; DB-backed sessions are strictly simpler and safer at
  this scale.

### Option C: Local accounts + server-side cookie sessions (chosen)

- **Description.** Users table in Postgres; opaque session tokens in HttpOnly cookies; Argon2id
  hashing; optional TOTP; PATs for programmatic access.
- **Pros.** Zero external dependencies; instant revocation (delete row); cookie flows directly
  authenticate WS upgrades; auditability in the same database as everything else.
- **Cons.** We own password/2FA/lockout code paths (small, well-specified, heavily-reviewed
  surface); no SSO until Phase 3; password reset for a self-hosted single user needs a CLI
  recovery path rather than email.

## Decision

Authentication is **local accounts with server-side sessions**, per _DECISIONS §1:

- **Passwords** hashed with **Argon2id** (memory-hard parameters tuned to ~100ms on baseline
  hardware); per-user rate limiting and exponential lockout on failures; all auth events written
  to `audit_log` (invariant S7).
- **Sessions:** opaque 256-bit tokens, stored hashed in a `sessions` table (platform-level, no
  company_id), delivered as **HttpOnly, SameSite=Lax, Secure** cookies; idle and absolute
  lifetimes; revocation = row deletion; the same cookie authenticates REST and the `/ws` upgrade.
  CSRF protection via SameSite=Lax plus same-origin checks on mutating requests.
- **Optional TOTP 2FA** (RFC 6238) with recovery codes; strongly recommended in setup UI when the
  server is exposed beyond localhost.
- **PAT tokens** for API/CLI: prefixed opaque tokens, stored hashed, scoped (read-only /
  company-scoped / admin), individually revocable, last-used tracking.
- **First-run bootstrap:** with zero users, the server enters setup mode and the compose logs
  print a one-time setup URL token; account recovery via a documented CLI command on the host
  (physical/SSH access = recovery authority).
- OIDC (authorization code + PKCE) is an optional Phase 3 addition for multi-human installs;
  local accounts remain the fallback so offline installs always work.

## Consequences

**Positive.**
- `docker compose up` → browser → create Founder account: no external services, works fully
  offline.
- Compromised-session response is immediate and total (revoke all sessions = one DELETE); the
  Approval Center's authority chain rests on revocable sessions, not un-revocable tokens.
- One auth model serves SPA, WS, and CLI consistently; everything audited in Postgres.

**Negative / accepted tradeoffs.**
- We carry the security-sensitive code ourselves; mitigated by using vetted libraries (argon2,
  otplib), keeping the surface minimal, and covering it with dedicated tests including negative
  cases.
- No SSO/passkeys in MVP; accepted for a single-operator product. Passkey (WebAuthn) support is a
  natural future addition under the same session model.
- Cookie+SameSite model assumes the SPA is same-origin with the API — true in our compose
  topology, and a constraint future deployments must respect (ADR-018).

**Revisit triggers.**
- Phase 3 multi-human orgs begin → implement the OIDC option and role provisioning.
- The platform is offered as a hosted/managed product → external IdP integration becomes
  first-class, reopening Option A.
- Credential-stuffing or exposure reports from self-hosters running on public internet → make
  TOTP default-on and add IP allowlist support.

## References

- _DECISIONS.md §1 (AuthN row), §16 (WS auth), §20 (S7 audit), §0 A1/A3, §22 row 013
- _BRIEF.md §9 (production-grade security)
- ADR-008 (WS gateway), ADR-014 (authorization — agents, not humans), ADR-018 (deployment)
