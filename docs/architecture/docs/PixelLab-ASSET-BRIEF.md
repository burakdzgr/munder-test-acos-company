# PixelLab Asset Production Brief

Purpose: produce the pixel-art avatar + tile library for the ACOS virtual office. Assets are generated
ONCE (design-time), baked into the repo as PNG atlases, and loaded by PixiJS at runtime. PixelLab is NOT a
runtime dependency (product stays self-hosted/offline-capable). Referenced by 36-UI-OVERHAUL §7/§15.

## 1. What to generate

### A. Character avatars (the library shown in the hire modal)
- **Count**: 24 base characters (variety of hair/skin/outfit; include suit, hoodie/tee, glasses, beard,
  hat variants) so roles look distinct. This is the picker grid; the user selects one per agent.
- Per character, TWO outputs:
  1. **Portrait/bust** (front-facing head+shoulders), ~24×24 px — used in the hire-modal grid + roster faces.
  2. **Top-down walk sheet**: 4 directions (down/up/left/right) × walk cycle (4 frames) + 1 idle frame per
     direction. Character footprint ~16×20 px on a transparent background. Optional **slow-walk** = reuse
     walk frames at lower playback rate (no extra art needed; engine controls speed).
- **Style**: top-down RPG office worker, readable at small size, flat shading, transparent bg, consistent
  palette/outline weight across all 24 so they read as one set.

### B. Office tileset (floor plan)
- Floor tiles per zone tint (neutral base + department accent overlay handled in code), wall tiles
  (straight, corner, with top-edge highlight for pseudo-3D), door/entrance tile, corridor/lobby floor.
- Props: desk (L-desk) + monitor (screen recolored in code to status color), office chair, server rack,
  meeting table, potted plant, coffee machine, reception/lobby desk. CC0 props acceptable where PixelLab
  isn't ideal.

## 2. Format & packing
- Export each character as an individual spritesheet PNG + a PixiJS-compatible `atlas.json` (frame rects,
  named `<avatarId>_<dir>_<frame>` and `<avatarId>_portrait`). Pack all characters into 1–2 atlas pages
  for single-batch rendering.
- Tiles/props → one `office-tiles.png` + `office-tiles.json`.
- Commit under `apps/web/public/sprites/` with `characters/`, `tiles/`, and an index
  `avatars.json` = `[{ avatarId, portraitFrame, walkFrames{down,up,left,right}, idleFrames{...} }]`.

## 3. Repo integration (done in U15)
- `features/office/characters.ts`: load `avatars.json`; expose `getAvatar(avatarId)`; the hire modal lists
  all entries (portrait), the office renders the walk/idle frames via PixiJS `AnimatedSprite`, picking the
  row by movement direction (dx/dy already available from the projector's Manhattan path).
- Agent → avatar link: `agents.avatar_url`/`avatarId` (chosen in the hire modal). Same employee always
  renders the same character (mirrors persistent-identity invariant visually).
- A one-time generation script (kept out of the runtime build) documents how the atlases were produced
  from PixelLab (API key via env, prompt list per character); re-runnable to add variants later.

## 4. Licensing
- Personal/local use: fine. Before any distribution/commercial use, verify PixelLab's asset license/ToS
  and record it in `apps/web/public/sprites/CREDITS.md` (per-asset source + license). CC0 props need
  attribution only if the license requires it.

## 5. Acceptance
- 24 characters present with portrait + 4-dir walk + idle; all load in PixiJS as AnimatedSprite; hire-modal
  grid shows portraits; office renders the selected character walking with correct facing.
- Tileset renders the full floor plan (walls/corridor/lobby/zones/props) edge-to-edge.
- Single-atlas batching keeps the office within the 100-avatar/60fps budget.
- `CREDITS.md` present with sources + licenses.
