# 36 — UI OVERHAUL & DESKTOP PACKAGING

Status: v2.1 — FINAL, implementation-ready. Desktop shell = **Electron** (Founder decision; supersedes the
earlier Tauri choice). Hand to Claude Code after T50.
Authority: governs FRONTEND look/behavior + one desktop packaging target ONLY. Never changes backend,
DB schema, event catalog, WS protocol, or the invariants in 35-CLAUDE-CODE-HANDOFF.md §12.
On any data/contract conflict, existing architecture docs win. This is a **pure frontend + `apps/desktop`
+ additive read-only endpoints** effort. Visual reference: `docs/ui/acos-final.html` (the approved mockup
— commit it into the repo; it is the source of truth for layout & behavior).

Track this work in `PROGRESS-UI.md` as tasks U01–U16 (same table format as PROGRESS.md).

---

## 0. NON-NEGOTIABLE CONSTRAINTS

- N1. Backend/workers/sandbox-manager/DB/`packages/contracts` wire types/`/ws` protocol/event catalog:
  UNCHANGED. If a panel needs data not exposed, add a **read-only** GET endpoint following
  21-API-DESIGN.md conventions — never a new write path outside existing modules.
- N2. **Office invariant**: the client renders ONLY server `office.*` instructions, each carrying a
  `causeEventId`. Swapping circles→pixel sprites changes *how* an avatar is drawn, never *why* it moves.
  Keep the dev-mode throw on any instruction missing `causeEventId`.
- N3. **Realtime discipline**: domain events never dropped; terminal frames drop-oldest; reconnect/resume
  via existing `RealtimeClient`. No polling added.
- N4. **Autonomy-first preserved**: the office/board are observation + authorized override, not a
  micromanagement console. The "focus terminal → send prompt" feature (U06) routes as a **Founder
  directive message** through the existing comms path (T33 `MessageService`, Founder→agent DM), so it is
  persisted, audited, and visible — NOT a hidden bypass into the agent loop.
- N5. **Kanban drag = authorized transition**: a Founder drag calls the existing task-transition API
  (T27). Illegal transitions bounce with the real 409 (card returns to source). Agents still drive state
  normally via the state machine; the board only reflects + allows authorized Founder overrides.
- N6. All 14 existing views keep working. Overhaul is **additive**: the new Command Center becomes the
  default landing; existing views remain reachable as maximized panels / routes.
- N7. Accessibility: reduced-motion + no-WebGL DOM fallback (23 §15) preserved; layout degrades to a
  usable stacked layout under ~1100px width.

---

## 1. STACK ADDITIONS (only these)

| Concern | Choice | Notes |
|---|---|---|
| Panel/dock layout | **dockview** (`dockview-react`) | draggable/resizable/splittable/tabbed panels; persisted layouts |
| Office sprites | **PixelLab-generated** pixel characters (see `PixelLab-ASSET-BRIEF.md`) | portrait (picker) + 4-dir walk/idle spritesheets, baked into repo as PNG atlases; NOT a runtime dependency |
| Tilemap/props | hand-authored pixel tiles + CC0 props | floor/walls/desks/plants baked as an atlas |
| Desktop shell | **Electron** (`apps/desktop`; `electron` + `electron-builder`) | wraps the Vite build in a `BrowserWindow`; native window/menu/tray/notifications; can boot/monitor the compose stack; office detach = second `BrowserWindow`. Secure config: `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`, a minimal `preload` bridge; renderer loads the built SPA (or `ACOS_BASE_URL`). Heavier bundle (~150MB) accepted per Founder decision. |

**Packaging constraint (`electron-builder.json` cannot hold comments — recorded here instead).**
`electronVersion` is **pinned explicitly** and must be updated together with `devDependencies.electron`.
Two reasons, both hit in practice: electron-builder downloads platform-specific binaries so a range
(`^43.4.0`) cannot be resolved, and the repo's `.npmrc` sets `node-linker=hoisted`, so
`apps/desktop/node_modules` does not exist for the version to be read from. The shell also does **not**
bundle the SPA — it loads it from the running stack and clears the cache first
(`apps/desktop/src/main.ts`), so **UI changes need a fresh `web` image and an app restart, not a
repackage**; repackaging is only for main-process changes (window, tray, notifications, lifecycle).
| Terminal | **xterm.js** (already chosen T41) | multi-terminal grid |
| Graphs | **Cytoscape.js** (org) + **three.js/R3F** (memory galaxy, ADR-021) + custom canvas (office, memory 2D fallback) | |
| Charts | Recharts | costs/reports |

No other new deps. Reuse existing `packages/ui` + Radix primitives.

---

## 2. DESIGN LANGUAGE (dark command-center) — U01

Add `acosDark` theme to `packages/ui` as CSS variables + Tailwind extension; dark is the ONLY shell theme.

- Surfaces (near-black, cool): `--bg-0 #0a0c10` (app), `--bg-1 #0f1218` (panel), `--bg-2 #151a22`
  (raised), `--bg-3 #1c232d` (hover), border `--line #232b36`.
- Text: `--fg-0 #e6edf3`, `--fg-1 #9aa7b4`, `--fg-2 #5c6773`.
- Department accents (org zones, avatars, cost bars): engineering `#4c9aff`, product `#a879ff`,
  marketing `#ff8a5c`, operations `#3fd0a0`, sales `#ffcb47`, support `#ff6b8a`, executive `#c9d1d9`.
  Map in `packages/ui/theme/departmentColors.ts`.
- Presence status (11-state set): working `#4c9aff`, thinking `#a879ff`, communicating `#3fd0a0`,
  reviewing `#ffcb47`, testing `#3fd0a0`, learning `#a879ff`, blocked `#ff6b8a`, escalating `#ff4d4d`,
  waiting `#ffcb47`, idle `#5c6773`, offline `#3a424c`.
- Type: UI = Inter (13px base, dense); data/terminals/numbers = JetBrains Mono, tabular numerals.
- Density: 28px panel headers, 1px hairlines, flat panels (no big shadows), thin themed scrollbars.
- Deliverable: `apps/web/src/theme/PREVIEW` page rendering tokens/pills/buttons/mock-panel.

---

## 3. LAYOUT — Command Center (default) — U02, U03

New default route `/c/$companyId` = **CommandCenter** built on dockview with a persisted default layout
(per user in `uiPrefsStore`). Three columns with draggable splitters; left icon rail keeps all 14 views
reachable (open as panels/tabs). Exactly mirrors `docs/ui/acos-final.html`:

- **Top bar**: brand · **team chips** (org teams of the active company with live headcount + "+ Takım")
  · global search · **token/cache indicator** (session tokens + cache-hit from `llm_calls`) ·
  **"+ Ajan Ekle"** button · approvals badge · notifications badge · settings · Founder menu.
- **LEFT column** (tabs): **Hafıza** (relational memory graph + list) · **Skiller** (current skills +
  promotion candidates) · **Tarayıcı** (Phase-2 placeholder, labelled).
- **CENTER column** (tabs): **Terminal** (S/M/L splittable grid) · **Raporlar** (executive reports viewer)
  · **Görevler** (drag-drop kanban).
- **RIGHT column**: top tabs **Ofis** (full-floorplan pixel office) / **Kod** (IDE-style diff/file view of
  the selected agent's workspace) with **+ Çalışan** and **⧉ Ayır** (detach); bottom tabs **Çalışanlar**
  (roster w/ pixel faces) / **Takım** (team summary) / **Konuşma** (agent chat).
- **Bottom-left**: "Bugünün Hedefleri" (goals/objectives) panel.
- **Bottom-right**: toast notifications (completed goals, new memory, approvals). **Status bar**: ws
  state · last event · cost burn strip.
- **Cross-panel focus**: selecting an agent (office avatar, roster, terminal) sets a shared
  `focusStore.selectedAgentId` → highlights that agent across all panels (its tasks, terminal, code, DMs).
- **Layout presets** (top-bar buttons): "Operations" (office-centric), "Engineering" (terminals+tasks big),
  "Overview" (costs+approvals+reports). Shipped as saved dockview JSON.

---

## 4. TERMINAL GRID — U05

- Center **Terminal** tab = tiling grid of live agent terminals (xterm.js), one cell per open
  `terminal_session`. Cell header: status dot · agent name · TASK-n · `⤢ öne çıkar` · `✕ kapat`.
- **S/M/L density** control sets grid columns: S=2 (big), **M=4 (≥8 terminals visible)**, L=6 (dense).
- **Open/close per agent**: roster (right-bottom Çalışanlar) has a "terminal +/✕" toggle per agent; the
  grid reflects the open set. Closing a cell just detaches the view (session keeps running server-side).
- **⤢ Focus + prompt (U06)**: expands one terminal to a modal with live output + a prompt input. Sending
  routes through `MessageService.send` as a Founder→agent directive DM (N4) — persisted + audited +
  emits `agent.message.sent` (so the office shows the interaction). NOT a direct write into the agent
  workflow. Live output streams via the existing terminal WS topic.

---

## 5. LEFT PANELS — U07

- **Hafıza (relational)**: top = animated relational graph — nodes = memories (color by type, size ∝
  importance, opacity ∝ confidence), edges = `memory_relations` (supports green / contradicts red-dashed /
  derived_from purple / supersedes grey); hover → provenance (scope owner/type/conf). Backed by the
  Observatory endpoints (T48). Below: live-updating memory list (new memories fade in on
  `memory.created`). Views: Graf / Liste / Zaman.
  - **Renderer (revised — ADR-021).** The graph is the **3D knowledge sphere**, in this panel exactly
    as on the full Observatory page: same scene, `variant="panel"` (no filter overlay, no labels).
    The original spec here was a 2D canvas "brain-field", and it shipped that way while the 3D view
    went only to the Observatory route — the Founder works in the Command Center panel, so it was
    invisible in practice. The defect was two surfaces rendering the same domain object differently,
    not the styling. The 2D strip survives **only** as the no-WebGL fallback, and that fallback now
    prints its reason on screen instead of degrading silently.
  - **The Graf tab shows the graph and nothing else** — it fills the panel; the memory list lives in
    the Liste / Zaman tabs. Stacking a graph strip above a list left neither readable.
- **Skiller**: two tabs. **Beceriler** = per-agent skill matrix with evidence-based levels (T47).
  **Terfi Adayı** = emergent skill candidates (see U12) with reason + evidence chips + "↑ Terfi Et"
  → Founder promotion; on approve the candidate becomes the agent's real skill.
- **Tarayıcı**: Phase-2 placeholder card (browser sandbox not in MVP).

---

## 6. CENTER: KANBAN + REPORTS — U08

- **Görevler**: real drag-drop kanban over the 16-state machine collapsed into columns
  (BACKLOG/ASSIGNED/IN_PROGRESS/REVIEW/CHANGES_REQUESTED/QA/APPROVAL/DONE… hide empty edge states).
  Founder drag → task-transition API; illegal → 409 bounce (N5). Cards show title, owner avatar, priority.
  Live-updates on `task.status.changed`. Tree + DAG available in pop-out.
- **Raporlar**: executive reports list (from `executive_report` artifacts, T49) + content viewer.

---

## 7. RIGHT: OFFICE FLOORPLAN + CODE — U04, U09

- **Ofis** = single continuous floor plan filling the whole panel edge-to-edge (per
  `acos-office-floorplan` / `acos-final`): outer walls, interior partition walls dividing **one room per
  department** (generated from `org_units` of kind=team/department), a cross corridor + lobby, an entrance
  door, desk clusters per zone, props (server rack, meeting table, plants, coffee). Zone count/layout is
  **dynamic** from the org graph.
  - Characters = PixelLab sprites; 4-directional walk (+ optional slow-walk variant), idle frame at rest;
    each agent deterministically mapped to its chosen `avatarId`; presence badge above head; name below.
  - Movement/interaction driven 1:1 by `office.*` instructions from the server projector (T25) — every
    motion carries `causeEventId` (N2). New hire walks in from the entrance door to its desk on
    `agent.hired`. DM → walk to recipient + bubble + return. Escalation → red ring.
  - **⧉ Ayır**: detaches office into a separate window (Electron second `BrowserWindow`; browser = popup window).
  - Perf: single-atlas batching, offscreen culling, pooled AnimatedSprites; keep 100-avatar/60fps budget;
    verify via `__acosOffice` debug hook + FPS smoke. DOM fallback (N7) preserved.
- **Kod** = IDE-style view of the selected agent's active workspace: file tree + read-only code/diff pane
  (from existing `git.diff` / reviews branch-diff endpoint, T43). Shows `Task: TASK-n` context.

---

## 8. HIRE MODAL ("Ajan Ekle") — U10

Opened from top-bar "+ Ajan Ekle" or office "+ Çalışan". Fields (per `acos-final` modal), all wired to the
existing hire flow (T19 `AgentsService.hire`) — **no new tables**, only new params on the hire endpoint:

- **Ajan adı** → `agents.name`.
- **Rol (rol kütüphanesi)** categorized (Leadership/Engineering/Product/Marketing) → `position_id` /
  role + department (org placement, T18/T19).
- **Karakter (avatar)** grid = the full PixelLab avatar library; selection → `agents.avatar_url` /
  `avatarId`. This is the character shown in the office.
- **AI engine** (Claude Code/Codex/Groq/DeepSeek/Kimi/Ollama) → provider; **Model** sub-select →
  `agent_model_bindings` (identity stays decoupled from model, INV).
- **Expertise** tags → initial `agent_skills` seed (T47).
- **Proje** select (existing projects) → `project_members` (T42).
- **Yerleştir** → hire transaction; on success the new avatar walks into the office and appears in roster.

Add hire-endpoint params: `avatarId`, `expertise[]`, `projectId?`, `modelBinding{provider,model}`.
Validate server-side; keep the single-transaction hire (T19) intact.

---

## 9. TOKEN/COST INDICATOR + NOTIFICATIONS — U11

- **Token/cache indicator** (top bar): session output tokens + cache-hit ratio from `llm_calls`
  (cached-token accounting already exists, T29). Read-only aggregate endpoint if not already exposed.
- **Toasts + notifications**: subscribe to WS; on `approval.requested`, `task.completed` (goal-level),
  `memory.created`, `security.alert` → toast (bottom-right) + increment notifications badge + (Electron)
  native OS notification. "Bugünün Hedefleri" panel reads goal-level tasks (kind=goal) + completion.

---

## 10. EMERGENT SKILL DISCOVERY — U12 (small backend addition, allowed)

The one feature beyond current T47. Add a read-model + proposal flow (NOT a schema change to the skill
evidence model): a periodic job scans each agent's recent `agent_steps` + task `context.skills` + memories
for repeated work patterns (e.g. ≥N similar tasks of a kind not yet a skill) and surfaces **skill
candidates** (`agent_id`, suggested skill name, reason, evidence refs, score). Founder "↑ Terfi Et" creates
the `agent_skills` row (starting level) + seeds `skill_evidence` from the cited work. Reuse existing
tables; the candidate list is a derived read-model (materialized or computed). Emit
`agent.skill.candidate.proposed` / on promote reuse `agent.skill.updated`. Keep it evidence-based (no
gamification): a candidate needs real repeated, accepted work — same discipline as T47.

---

## 11. DESKTOP SHELL (Electron) — U13, U14

New `apps/desktop` (Electron). Wraps the built web app; backend still runs via docker compose. Electron is
a shell over the SAME `apps/web` bundle — not a fork; the app must still run unchanged in a browser.

- U13a Scaffold Electron: `main.ts` (main process) + `preload.ts` (context-isolated bridge) +
  `electron-builder` config. Main window: dark titlebar, 1440×900 default, min 1100×720, remembers
  geometry (electron-store or a small JSON). Dev mode loads the Vite dev server
  (`http://localhost:$WEB_PORT`); production loads the built SPA from disk (or `ACOS_BASE_URL`).
  **Security (mandatory)**: `contextIsolation:true`, `nodeIntegration:false`, `sandbox:true`,
  `webSecurity:true`; the renderer reaches the OS only through the preload bridge (no raw Node in the SPA).
- U13b **Backend lifecycle helper** (optional path, off critical path): first-run screen checks Docker,
  runs `docker compose up -d` from the main process (`child_process`), waits for `/api/health` green, then
  loads the app; tray menu Start/Stop stack + open logs + quit. Must also work pointed at an
  already-running stack via `ACOS_BASE_URL` (skip the boot step).
- U14a **Native notifications**: renderer forwards `approval.requested`/`security.alert` WS events over the
  preload bridge → main process uses Electron `Notification` (click → focus window + Approvals view).
- U14b **Office detach** (⧉ Ayır) → main process opens a second `BrowserWindow` rendering the office panel
  route standalone (frameless/always-on-top optional).
- U14c **Tray** (`Tray`) presence icon reflects company state (idle/active/needs-approval), fed by a light
  WS summary over the bridge; tray menu: show/hide, open Approvals, quit.
- Package: `pnpm --filter @acos/desktop build` → `electron-builder` produces a local installer for the
  target OS (nsis/dmg/AppImage as appropriate). Do NOT bundle Postgres/Temporal into the app — the stack
  stays containerized; Electron orchestrates it, doesn't replace it.

---

## 12. TASK LIST (U01–U16, dependency order)

- U01 Dark theme tokens + Tailwind theme + PREVIEW page. (—)
- U02 App shell restyle: icon rail, top bar (teams/token/approvals/notifications/+Ajan Ekle). (U01)
- U03 dockview CommandCenter + panel-wrapper HOC for existing views + 3 presets + `focusStore`. (U02)
- U04 Office floorplan renderer (walls/corridor/zones dynamic from org) — still circles until U15. (U01)
- U05 Terminal S/M/L grid + per-agent open/close. (U03)
- U06 Focus-terminal + Founder-directive prompt (via MessageService). (U05)
- U07 Left panels: relational memory graph + list; skills matrix. (U03)
- U08 Kanban drag-drop (authorized transitions/409) + Reports viewer. (U03)
- U09 Right: office panel wiring + Kod (IDE diff) + Çalışanlar/Takım/Konuşma. (U04)
- U10 Hire modal (avatar/role/engine/model/expertise/project) + hire-endpoint params. (U03, U15)
- U11 Token/cache indicator + toasts + notifications + goals panel. (U03)
- U12 Emergent skill discovery read-model + promotion flow. (U07)
- U13 Electron scaffold (main+preload+builder, secure config) + backend lifecycle helper. (U02)
- U14 Electron native notifications + office detach (2nd BrowserWindow) + tray. (U13, U09, U11)
- U15 PixelLab asset integration: bake atlases, avatar library, wire `avatarId` to sprites (see brief). (U04)
- U16 Visual QA: Playwright screenshots per preset + office spawn/DM animation smoke + FPS smoke +
  responsive/degrade + a11y fallback; keep all existing e2e (14/14) green (selectors preserved). (all)

**Parallel lanes**: Theme/shell/panels (U01→U02→U03→U05→U07→U08) ∥ Office+assets (U04→U15→U09) ∥
Electron (U13→U14). Meet at U16.

---

## 13. DEFINITION OF DONE

- Launch (browser or Electron) lands on the dark 3-column Command Center matching `docs/ui/acos-final.html`.
- Watching the 25-step demo on one screen: real pixel avatars walk on delegation/DM across a full-floorplan
  office; terminals stream real output (S/M/L, per-agent open/close, focus+prompt as audited directive);
  events/tasks/memory/skills/costs all live; kanban drag does authorized transitions (409 on illegal);
  hire modal places an agent that walks in; approvals badge lights only for real Founder decisions.
- Every office animation traces to a `causeEventId` (debug inspector) — no random motion.
- Emergent skill candidate can be promoted → becomes agent's real skill (evidence-backed).
- All existing e2e green; new visual smokes green; office within FPS budget; graceful <1100px + no-WebGL.
- `electron-builder` (`pnpm --filter @acos/desktop build`) yields a working desktop installer: launches
  (optionally boots the compose stack), shows native approval notifications, tray presence, and office
  detach in a second window; the SAME `apps/web` bundle still runs unchanged in a browser. Electron
  security config verified (contextIsolation on, nodeIntegration off, sandbox on, preload-only bridge).
- `git diff` touches only `apps/web`, `apps/desktop`, `packages/ui`, and additive read-only endpoints +
  the hire-endpoint param extension. No schema/event/WS/contract-wire breaking change.
