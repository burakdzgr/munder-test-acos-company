# ADR-011: Frontend Framework — React 19 + Vite + TanStack Router/Query + Zustand + Tailwind

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

The frontend is a desktop-class company command center with fourteen major views (Office, Tasks,
Agents, Projects, Memory, Organization, Skills, Communication, Terminals, Approvals, Events,
Reports, Costs, Settings) (_BRIEF §8). Forces:

- **Heavy specialized surfaces.** The virtual office is a PixiJS canvas (ADR-012); org/memory/task
  graphs use Cytoscape.js; terminals use xterm.js; charts use Recharts. The framework must host
  imperative canvas/WebGL libraries cleanly.
- **Live data everywhere.** One WebSocket feeds events, presence, and terminals (ADR-008); server
  state arrives via the generated typed client from `packages/contracts`; caches must reconcile
  REST fetches with pushed events.
- **Deployment reality.** Self-hosted SPA served as static files by the compose stack; the client
  talks to `apps/server` on the same origin. There is no SEO, no public content, no edge — the
  app is behind login on the Founder's own server.
- **Team/tooling.** Claude Code implements the system; the largest possible ecosystem and training
  corpus of integration examples reduces risk for the exotic parts (Pixi/xterm/cytoscape
  interop).

## Options considered

### Option A: Next.js (App Router)

- **Description.** React meta-framework with SSR/RSC, file routing, server actions.
- **Pros.** Dominant ecosystem; excellent DX; RSC could theoretically slim client bundles.
- **Cons.** Every distinctive Next.js capability is dead weight here: SSR/SEO serve no purpose
  behind a login on localhost; server actions duplicate our Fastify API layer (contracts must
  stay in `packages/contracts` for workers and external consumers — a second server runtime
  fragments that); the Node server it wants to run competes with our topology where `web` is
  static files. RSC boundaries complicate hosting big imperative canvas components.
- **Rejected because** SSR is pointless for a self-hosted authenticated SPA and the embedded
  server conflicts with our contracts-first API architecture.

### Option B: SvelteKit or SolidStart

- **Description.** Compiler-first reactive frameworks with smaller runtimes and excellent
  performance characteristics.
- **Pros.** Genuinely faster fine-grained reactivity (relevant for high-frequency event updates);
  smaller bundles; pleasant authoring model.
- **Cons.** The decisive factor is ecosystem for our specific integrations: mature, maintained
  bindings and abundant examples for PixiJS, xterm.js, Cytoscape, TanStack tooling, and design
  systems are React-first; Svelte/Solid equivalents are thinner and often community-maintained.
  Raw framework performance is not our bottleneck — canvas rendering (Pixi) and WS handling are
  outside the framework's reactivity anyway.
- **Rejected because** integration ecosystem risk outweighs runtime elegance for this particular,
  integration-heavy product.

### Option C: React 19 + Vite + TanStack Router/Query + Zustand + Tailwind (chosen)

- **Description.** SPA built with Vite; TanStack Router (typed routes) and TanStack Query (server
  state); Zustand for client/live state (WS-fed stores); Tailwind CSS with the shared design
  system in `packages/ui`.
- **Pros.** Largest ecosystem for every required integration; TanStack Query's cache is the right
  tool for REST + event-driven invalidation; Zustand stores suit high-frequency WS updates
  (presence, terminal status) without re-render storms; Vite keeps builds trivial and output
  static.
- **Cons.** React's re-render model requires care around 60Hz-ish updates (solved by keeping
  Pixi/xterm state outside React); more boilerplate than compiler-first frameworks; library
  choices (router/query/state) are ours to keep coherent.

## Decision

The frontend (`apps/web`) is a **React 19 SPA built with Vite**, using **TanStack Router** (typed,
code-split routes per view), **TanStack Query** (all server state via the generated typed SDK from
`packages/contracts`), **Zustand** (live/client state fed by the WS gateway), and **Tailwind CSS**
with shared components in `packages/ui`.

Bounding rules:

- `apps/web` depends only on `packages/contracts` and `packages/ui` (ADR-001 dependency rule);
  it never imports domain or db packages.
- **State split is canonical:** TanStack Query owns request/response server state; domain events
  from the WS invalidate or patch Query caches; Zustand owns continuous live state (presence,
  office instructions, terminal status, connection state). No Redux; no state duplicated across
  the two.
- Imperative canvases (Pixi office, xterm terminals, Cytoscape graphs) mount inside thin React
  wrapper components; their internal state lives outside React, fed directly by Zustand
  subscriptions/WS frames to avoid render churn.
- The SPA is compiled to static assets and served by the compose stack; same-origin API and
  cookie auth (ADR-013) — no client-side token handling.

## Consequences

**Positive.**
- Every hard integration in the product has first-class React examples and maintained wrappers;
  Claude Code's generation reliability is highest in this stack.
- Typed end-to-end: contracts package → generated client → Query hooks → components; API drift is
  a compile error.
- Static-file deployment keeps `docker compose up` simple (nginx/static container), and the app
  works offline-from-internet by construction.

**Negative / accepted tradeoffs.**
- React re-render discipline is on us for high-frequency data; the "canvas state outside React"
  rule must be enforced in review.
- SPA means no server rendering of first paint; acceptable — the user is one authenticated
  Founder, and code-split routes keep initial load reasonable.
- Four library choices (Router/Query/Zustand/Tailwind) must be version-managed together; all are
  boring, stable dependencies.

**Revisit triggers.**
- Sustained UI jank (<50 FPS office or laggy timeline) traced to React reconciliation rather than
  canvas code → tighten store granularity; only if structurally unfixable, revisit Solid for leaf
  surfaces.
- React 19 ecosystem churn (e.g. compiler adoption) materially changes best practice → adopt
  within-React, no framework change.
- A public marketing/docs site is needed → separate static site; this ADR governs only the app.

## References

- _BRIEF.md §8 (frontend product)
- _DECISIONS.md §1 (frontend row), §3 (layout, dependency rule), §16 (realtime), §22 row 011
- ADR-008 (realtime transport), ADR-012 (office renderer), ADR-001 (monorepo)
