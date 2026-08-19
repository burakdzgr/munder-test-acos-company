# ADR-021: Memory Graph Renderer — R3F/three.js "galaxy" as the default, Cytoscape as the fallback

Status: Accepted · Date: 2026-08-15 · Deciders: Founder + implementation agent

## Context

12 §8.2 requires a memory relation graph in the Observatory: nodes styled by the memory's own
attributes, edges by relation kind, capped at 500 nodes server-side. The first implementation
(T48) used **cytoscape + fcose** — a 2D force graph. It is correct and readable, but it renders the
memory as a flat diagram: the scope hierarchy that the domain actually has (company core → project
→ agent, 12 §2) is invisible, and a force layout re-shuffles positions on every load, so the same
memory never sits in the same place twice.

The Founder asked for the codebase-memory-mcp style: a 3D "galaxy" where the company's knowledge
reads as a structure you can fly through, with a slow wave motion and new memories appearing as
stars being born.

Constraints that shaped this:

- `apps/web` is React 19 + Vite (ADR-005). No renderer of its own — this is purely additive.
- The data model is **untouched** (ADR-003/ADR-007 unaffected). The API gained two projection
  fields on the existing graph endpoint — see "Payload addition" below; no migration, no new route.
- 500 nodes at 60fps is the stated acceptance bar.
- The visualization is a *presentation* layer: it must never be able to break the Observatory.

## Decision

**The 3D galaxy (react-three-fiber + three.js) is the default renderer for the memory graph; the
existing 2D cytoscape graph stays as the fallback when WebGL is unavailable.**

Stack: `three` · `@react-three/fiber` · `@react-three/drei` (OrbitControls, Html) ·
`@react-three/postprocessing` + `postprocessing` (Bloom).

Consequences of the design, and why each way:

1. **Instanced rendering.** All nodes are one `InstancedMesh` and all edges one `LineSegments`.
   500 separate meshes would be 500 draw calls; instancing is what makes the 60fps bar reachable.
   Colour rides the instance colour buffer, size the per-instance matrix.

2. **Deterministic placement, not a force layout.** A node's position is derived from its **id**
   (FNV-1a hash → shell + spiral arm + height). The same memory is always in the same place, and
   adding one memory never moves the others. A force layout would re-scatter the galaxy on every
   refresh, which destroys the spatial memory the visual is supposed to give.

3. **Scope is the layout.** `company` = dense bright core, `project` = spiral arms, `agent` =
   outer orbit. This is the one thing the 2D graph could not express, and it is the domain's own
   hierarchy (12 §2), not decoration.

4. **The wave is per-node, not per-camera.** Each node gets a small sine offset on Y whose phase
   comes from its id, and the whole cloud spins at 0.02 rad/s. Animating the camera instead would
   fight OrbitControls; animating positions with a shared phase would look like a single pulsing
   blob rather than a wave.

5. **New memories pop.** `memory.created` already invalidates `[companyId, "memories"]` via
   RealtimeDispatcher (24 §5: stores are the only socket consumers), so the scene detects new ids by
   diffing successive query results — no second socket listener, no backend change. A new node eases
   0→1 with a brief overshoot, and Bloom's low luminance threshold makes it flare as it appears.

6. **Labels are budgeted.** Only the nearest ~14 nodes plus hover/selection get a DOM label
   (`drei/Html`). 500 simultaneous DOM labels would cost more than the entire 3D scene.

7. **WebGL failure degrades, never breaks.** `webglAvailable()` is checked before mounting; without
   it the panel renders the 2D graph exactly as before. Same `memory-graph` test id either way.

## Alternatives considered

- **Keep cytoscape only.** Cheapest, but cannot express the scope hierarchy and re-shuffles on
  every load. Rejected against the Founder's explicit request.
- **Replace cytoscape entirely.** Would leave environments without WebGL (remote desktops, some CI
  images, old drivers) with no graph at all. Rejected: the Observatory must work everywhere.
- **Server-computed positions.** Preferred in the original brief and still the better long-term
  answer for per-project arms, but it means a payload change — out of scope here (see below).

## Payload addition (closed a limitation of the first cut)

The first implementation derived arms from the **node id**, because the graph payload carried
`scope` but not its owner — so two memories of different projects could land in the same arm and
the arms meant nothing. The Founder authorised the backend change, so
`MemoryGraphResponse.nodes[]` gained two fields:

- `scopeRef` — the project id (`project`), the agent id (`agent`), or `null` (`company`)
- `scopeLabel` — the human name of that owner, resolved server-side with two batched lookups
  (a per-node query would be 500 round trips)

Arms are now keyed on `scopeRef`: **every memory of a project shares one arm, different projects
get different arms**, and the tooltip can answer "whose memory is this" (`agent: Aylin Vural`).
No new endpoint, no schema migration — the columns already existed on `memories`; only the
response projection was missing.

## Shape: sphere, not disc (revision 2)

The first shape was a flat spiral disc. It read as a horizontal planet — and a knowledge graph is
not that: relations run in every direction, they do not lie in a plane. Viewed edge-on the disc also
collapsed on itself, so the camera angle decided whether structure was visible at all.

The layout is now three **spherical shells** — `company` core, `project` mid, `agent` outer — with
position *within* a shell clustered by `scopeRef`. That preserves what the spiral arms encoded (all
of a project's memories sit together, different projects sit apart) in a form that survives every
camera angle. `ARMS` / `ARM_TWIST` are gone; `FIELD_RADIUS` replaces them as the single shared
dimension.

Three consequences worth recording:

- **`GalaxyDust` → `KnowledgeField`.** A spherical cloud (uniform in *volume*, so `r ∝ ∛u`), a
  brighter surface shell, and a filament mesh. The filaments connect each hub to its **nearest**
  hubs; an earlier version linked random pairs and produced a spiky star rather than a web, because
  every strand crossed the whole sphere. They remain **decoration and carry no relational meaning** —
  they are drawn dim and never touch a memory node, while real `memory_relations` stay bright and
  colour-coded in `EdgeLines`. The distinction is deliberate: dim strands are texture, bright
  coloured lines are data.
- **`ClusterGlows` is data, not decoration.** One additive sprite per `scopeRef`, at that cluster's
  centroid, scaled by `√(node count)` — a project's halo grows as its memory grows. Capped at the 8
  largest clusters because each sprite is a draw call.
- **Camera distance is derived, not fixed.** The same scene renders in a ~1100px page and a ~260px
  panel. A fixed distance framed the page correctly and overflowed the panel badly, because the fov
  is *vertical*: a narrow box has a much smaller horizontal field. `homeDistance(fov, aspect)` solves
  for whichever half-angle is narrower.

## Both surfaces, one scene (revision)

The first cut wired the galaxy into the Observatory route (`MemoryView`) only. The Command Center's
left **Hafıza** panel (`MemoryPanel`) kept its own 2D `BrainGraph`, because 36 §5 specified a
"brain-field" strip there. That is where the Founder actually works, so the galaxy was effectively
invisible: the same domain object was being drawn two different ways on two screens, and the panel
kept showing bubbles. 36 §5 is revised; the panel now renders `GalaxyScene variant="panel"` — same
scene, same data, filter overlay and labels dropped because a 230px strip cannot carry them.

`BrainGraph` is retained solely as the no-WebGL fallback, and the fallback now prints its reason
(`webglStatus()`), because a silent downgrade is indistinguishable from a broken feature — this cost
a full debugging round.

Two further mechanics came out of that round:

- **`GalaxyDust`** — ~21k decorative points on the *same* spiral equation as the layout (`ARMS`,
  `ARM_TWIST` are shared exports, not duplicated constants) plus a bulge and a core glow sprite. It
  is not data and never reacts to filters. Without it 22 memories in empty space read as floating
  balls, not a galaxy: the structure has to come from the dust, with memories as the stars inside it.
- **`webglStatus()` is probed once and cached, and the probe context is explicitly released**
  (`WEBGL_lose_context`). The check sits in JSX, so it ran on every render, each run opening a WebGL
  context that browsers cap (~16 live in Chromium).

## Visual QA (what the screenshot caught that the tests could not)

The e2e test asserts behaviour — canvas mounted, real node count, live filtering — deliberately, not
pixels, because pixel comparison depends on the GPU driver. That left a class of defect the suite
could never see, and it happened twice, so the test now also attaches a `galaxy.png` artifact for
human review.

Both defects had the same root cause and it is worth recording: with `vertexColors` enabled, three
computes `vColor = color * instanceColor`. If the geometry has **no `color` attribute**, WebGL
supplies `(0,0,0)` for it and the product collapses to black — instance colours are silently
discarded. On a lit material with a white `emissive` this rendered as **grey** spheres; on the
unlit material it rendered as **black** ones. Every scope colour and every confidence brightness
was being thrown away, and nothing in the behavioural suite could notice. The fix is a white base
`color` attribute on the sphere geometry, which makes the multiplication a no-op so the colour comes
purely from the instance buffer.

Camera framing was tuned from the layout rather than by eye: the `agent` shell reaches radius 20, so
the home position sits at 36 units, not 30, or the outer orbit falls outside the frustum.

## Consequences

- `apps/web` gains ~5 runtime dependencies and a larger vendor chunk (three is ~600 KB gzipped).
  Acceptable for a desktop-first Founder console; the chunk is lazy only insofar as the route is.
- The memory Observatory now has a visual identity that scales with the company's knowledge instead
  of degrading into a hairball as node count grows.
- Above the 500-node server cap the panel keeps the existing warning (12 §8.2/§8.4) — the scene does
  not invent clustering of its own.
