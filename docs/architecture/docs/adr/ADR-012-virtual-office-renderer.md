# ADR-012: Virtual Office Renderer — PixiJS v8

Status: Accepted · Date: 2026-08-10 · Deciders: Architecture team

## Context

The virtual office is a **digital twin**, not a game: avatars sit in department areas and move or
interact only when driven 1:1 by real backend events — `agent.message.sent` makes an avatar walk
to the recipient; no random idle animation, ever (_BRIEF §8). Forces:

- **Render load.** Up to 100 agents per company (10–100), each an avatar with name label, status
  indicator, and occasional movement tweens; department floor areas, furniture-level decoration,
  interaction effects. Typically tens of animated sprites at 60 FPS in a browser tab that also
  runs terminals and graphs.
- **Event-driven animation.** The renderer consumes a stream of derived **office instructions**
  (`office.avatar.moved`, `office.interaction.started`, …) produced server-side by the Office
  Projector (_DECISIONS §16). The client must be a dumb interpolator: apply instruction, tween,
  settle. It needs no physics, no collision, no input-driven gameplay.
- **Longevity in a React SPA.** The office is one route among fourteen (ADR-011); the renderer
  must mount/unmount cleanly, share the WS feed, and not own application state.
- **2D is sufficient.** The spec describes a top-down/isometric office; 3D adds cost with no
  informational gain.

## Options considered

### Option A: DOM/CSS or plain Canvas2D

- **Description.** Avatars as absolutely-positioned DOM nodes with CSS transitions, or immediate-
  mode Canvas2D drawing.
- **Pros.** Zero new dependencies; DOM gives free accessibility/text rendering; simplest possible
  start.
- **Cons.** DOM: 100 animated nodes with labels, status badges and continuous tweens trigger
  layout/paint churn; smooth 60 FPS with many simultaneous movers is not dependable, and effects
  (paths, particles for interactions, camera zoom/pan over a large floor) get awkward. Canvas2D:
  we would hand-roll a scene graph, sprite batching, hit-testing, and a tween system — that is,
  rebuild a worse Pixi.
- **Rejected because** performance ceiling (DOM) and reinvention cost (raw canvas); the decision
  core explicitly rejects DOM/Canvas2D on perf grounds.

### Option B: Phaser 3/4

- **Description.** Full HTML5 game framework: scenes, physics, input, asset pipeline, camera.
- **Pros.** Everything an office sim could ever need exists out of the box (tilemaps, tweens,
  cameras, sprite animation); huge tutorial corpus.
- **Cons.** We would use perhaps 20% of it: physics engines, arcade collisions, game loop
  conventions, and scene lifecycle are overhead for an event-driven twin that explicitly must NOT
  behave like a game (no autonomous behaviors, no simulation). Phaser wants to own the loop and
  asset lifecycle, which fights the React-embedded, WS-driven architecture; bundle weight is
  materially larger.
- **Rejected because** game-framework overhead and inverted control for a renderer that must stay
  a dumb projection of domain events.

### Option C: Three.js (3D scene)

- **Description.** WebGL 3D office with camera controls.
- **Pros.** Visually impressive; theoretically future-proof for richer spatial UX.
- **Cons.** 3D assets (models, rigging, lighting) multiply content cost by an order of magnitude;
  camera/navigation UX complexity grows; none of it improves the actual job — showing who is
  doing what with whom. The brief calls the product "not a virtual-office game".
- **Rejected because** 3D is unneeded cost; information density, not immersion, is the goal.

### Option D: PixiJS v8 (chosen)

- **Description.** 2D WebGL/WebGPU scene-graph renderer: containers, sprites, text, filters,
  batched rendering; no game framework, no physics, no opinions about loops.
- **Pros.** Exactly the abstraction level needed — a fast scene graph we drive from events;
  v8 performance headroom (WebGPU where available, WebGL fallback) makes 100 avatars trivial;
  small conceptual surface; clean mount/unmount inside a React wrapper; mature ecosystem.
- **Cons.** No batteries: tweening, tilemap-ish floor layout, and hit-testing conventions are
  ours to assemble (small, well-trodden libraries or ~hundreds of lines); WebGPU/WebGL context
  loss handling must be implemented.

## Decision

The virtual office is rendered with **PixiJS v8** inside a thin React wrapper on the Office route.

Bounding rules:

- The renderer is a **pure projection**: its only inputs are Office Projector instructions
  (`office.avatar.moved`, `office.interaction.started`, …) received on the `presence:<companyId>`
  topic (ADR-008) plus a layout snapshot on mount. It computes no positions from domain logic
  itself and holds no authoritative state — the server-side Office Projector maps domain events →
  office instructions so the renderer stays dumb (_DECISIONS §16).
- **No fake animation invariant:** every visible motion or interaction maps to a specific backend
  event/instruction id; there is no idle wander, no decorative movement. Tweens are presentation
  interpolation between instructed positions only.
- Scene state lives outside React (ADR-011 rule); React handles mount/unmount, resize, and route
  transitions; a Zustand store bridges WS frames to the Pixi ticker.
- Rendering budget: target 60 FPS with 100 avatars + labels on the reference baseline (integrated
  GPU laptop); degrade gracefully (label culling, lower tween rates) below that.
- Assets are simple 2D sprites/atlases shipped with the SPA; no runtime asset pipeline in MVP.

## Consequences

**Positive.**
- The digital-twin guarantee is architecturally enforced end to end: events table → projector →
  instructions → renderer; the office can be replayed from history like any other projection.
- Pixi's batching makes the render load a non-issue, leaving headroom for interaction effects and
  camera zoom/pan.
- Small dependency with a stable API; replaceable behind the wrapper if ever needed.

**Negative / accepted tradeoffs.**
- We build modest scaffolding ourselves (tween helper, floor-layout renderer, avatar factory,
  hit-testing for click-to-inspect); accepted as a few days of work vs. adopting a game engine.
- WebGL context loss and tab-throttling edge cases (background tabs pause tickers) need explicit
  handling — on resume, the renderer re-syncs from a fresh presence snapshot rather than replaying
  missed tweens.
- Accessibility of canvas content is limited; mitigated by the office being a companion view —
  every fact it shows is also available in accessible list views (Agents, Communication).

**Revisit triggers.**
- Sustained <50 FPS with the target avatar count on baseline hardware after optimization →
  profile; only structural failure would reopen renderer choice.
- Product direction adds spatial gameplay-like mechanics (pathfinding around furniture,
  user-driven avatar control) → reconsider Phaser for those mechanics.
- Pixi v8 WebGPU instability on mainstream browsers → pin to WebGL renderer (config, not
  architecture).

## References

- _BRIEF.md §8 (virtual office = digital twin, no fake animation)
- _DECISIONS.md §1 (renderer row), §16 (Office Projector, presence topics), §22 row 012
- ADR-008 (realtime transport), ADR-011 (frontend framework)
