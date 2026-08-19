// One-time sprite generation (36 §15 / PixelLab-ASSET-BRIEF.md — U15).
// Produces the character library as baked PNG atlases + avatars.json.
// CURRENT SOURCE: procedural pixel art ported from the approved mockup's
// portrait/drawChar routines (docs/architecture/docs/ui/acos-final.html) —
// recorded decision: no PixelLab API key available; the OUTPUT CONTRACT
// (atlas layout, frame names, avatars.json) matches the brief exactly, so a
// later PixelLab run only swaps the art, not the integration.
//
//   node scripts/generate-sprites.mjs      (from apps/web)
//
// Outputs under public/sprites/characters/:
//   characters.png / characters.json  — single-page PixiJS spritesheet
//   portraits/avNN.png                — 24×24 DOM-usable faces
//   avatars.json                      — [{avatarId, portrait, walk, idle}]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "pngjs";

const { PNG } = pkg;

const OUT = join(process.cwd(), "public", "sprites", "characters");
mkdirSync(join(OUT, "portraits"), { recursive: true });

// ---- palette (mockup) ----
const HAIR = ["#2b2118", "#4a3222", "#141414", "#5c3a1e", "#7a5a34", "#8a8f96", "#b5651d", "#d64f7a"];
const SKIN = ["#e8c9a0", "#d9b48c", "#c99a72", "#a9744f"];
const SHIRT = ["#3d6fd6", "#9264d6", "#2fb08a", "#d67443", "#d65f7a", "#4a5568", "#c9a227", "#2b3440"];

const CHARACTER_COUNT = 24;
const PORTRAIT = 24;
const FRAME_W = 16;
const FRAME_H = 20;
const DIRS = ["down", "up", "left", "right"];
// 4 walk frames (classic cycle) + 1 idle per direction
const WALK_FRAMES = 4;

function hex(color) {
  const n = parseInt(color.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function shade(color, delta) {
  const [r, g, b] = hex(color);
  const clamp = (v) => Math.max(0, Math.min(255, v + delta));
  return `#${((clamp(r) << 16) | (clamp(g) << 8) | clamp(b)).toString(16).padStart(6, "0")}`;
}

class Px {
  constructor(width, height) {
    this.png = new PNG({ width, height });
  }
  rect(x, y, w, h, color) {
    const [r, g, b] = hex(color);
    for (let yy = Math.round(y); yy < Math.round(y + h); yy++) {
      for (let xx = Math.round(x); xx < Math.round(x + w); xx++) {
        if (xx < 0 || yy < 0 || xx >= this.png.width || yy >= this.png.height) continue;
        const idx = (this.png.width * yy + xx) * 4;
        this.png.data[idx] = r;
        this.png.data[idx + 1] = g;
        this.png.data[idx + 2] = b;
        this.png.data[idx + 3] = 255;
      }
    }
  }
  blitTo(target, dx, dy) {
    PNG.bitblt(this.png, target.png, 0, 0, this.png.width, this.png.height, dx, dy);
  }
}

// character variants — same recipe as the mockup's AV[] table
function characterSpec(i) {
  return {
    avatarId: `av${String(i + 1).padStart(2, "0")}`,
    hair: HAIR[i % 8],
    skin: SKIN[(i * 3) % 4],
    shirt: SHIRT[i % 8],
    glasses: i % 3 === 0,
    beard: i % 5 === 0,
    hat: i % 7 === 0,
    suit: i % 4 === 0,
    hairstyle: i % 3,
  };
}

// ---- portrait (24×24) — direct port of the mockup portrait() ----
function drawPortrait(a) {
  const px = new Px(PORTRAIT, PORTRAIT);
  const P = (x, y, w, h, c) => px.rect(x, y, w, h, c);
  if (a.suit) {
    P(3, 17, 18, 7, "#20262e");
    P(9, 17, 6, 7, a.shirt);
    P(11, 17, 2, 5, "#c9ccd1");
  } else P(3, 17, 18, 7, a.shirt);
  P(10, 14, 4, 4, a.skin);
  P(7, 4, 10, 11, a.skin);
  if (a.hairstyle === 0) {
    P(6, 2, 12, 4, a.hair);
    P(6, 4, 1, 6, a.hair);
    P(17, 4, 1, 6, a.hair);
  } else if (a.hairstyle === 1) {
    P(7, 2, 10, 3, a.hair);
  } else {
    P(6, 2, 12, 3, a.hair);
    P(6, 4, 2, 8, a.hair);
    P(16, 4, 2, 8, a.hair);
  }
  if (a.hat) P(6, 1, 12, 3, "#2b3440");
  P(9, 9, 2, 2, "#1b1b1b");
  P(13, 9, 2, 2, "#1b1b1b");
  if (a.glasses) {
    P(8, 9, 4, 1, "#0b0e13");
    P(12, 9, 4, 1, "#0b0e13");
  }
  P(10, 12, 4, 1, shade(a.skin, -35));
  if (a.beard) P(7, 12, 10, 3, shade(a.hair, -10));
  return px;
}

// ---- top-down walk frame (16×20) — port of the mockup drawChar() ----
// frame 0/2 = stand, 1 = left step, 3 = right step
function drawWalkFrame(a, dir, frame) {
  const px = new Px(FRAME_W, FRAME_H);
  const ox = 3;
  const oy = 2;
  const P = (x, y, w, h, c) => px.rect(ox + x, oy + y, w, h, c);
  const dark = "#2b3440";
  const shoe = "#1c232d";
  const bodyShirt = a.suit ? "#20262e" : a.shirt;

  if (dir === "down" || dir === "up") {
    P(3, 0, 4, 1, a.hair);
    P(2, 1, 6, 1, a.hair);
    P(2, 2, 1, 3, a.hair);
    P(7, 2, 1, 3, a.hair);
    if (dir === "down") {
      P(3, 2, 4, 4, a.skin);
      P(3, 4, 1, 1, "#1b1b1b");
      P(6, 4, 1, 1, "#1b1b1b");
      if (a.glasses) P(3, 4, 4, 1, "#0b0e13");
    } else {
      P(2, 2, 6, 4, a.hair);
    }
    if (a.hat) P(2, 0, 6, 1, "#2b3440");
    P(3, 6, 4, 1, a.skin);
  } else {
    const flip = dir === "right";
    const fx = (x) => (flip ? 9 - x : x);
    P(fx(3), 0, 3, 1, a.hair);
    P(fx(2), 1, 4, 1, a.hair);
    P(fx(3), 2, 3, 4, a.skin);
    P(fx(4), 4, 1, 1, "#1b1b1b");
    if (a.hat) P(fx(2), 0, 4, 1, "#2b3440");
    P(fx(3), 6, 3, 1, a.skin);
  }

  P(2, 7, 6, 5, bodyShirt);
  P(2, 7, 6, 1, shade(bodyShirt, 40));
  if (a.suit) P(4, 8, 2, 3, a.shirt);
  P(1, 7, 1, 3, bodyShirt);
  P(8, 7, 1, 3, bodyShirt);
  P(1, 10, 1, 1, a.skin);
  P(8, 10, 1, 1, a.skin);

  // legs: classic 4-frame cycle
  const step = frame === 1 ? "L" : frame === 3 ? "R" : "S";
  if (dir === "left" || dir === "right") {
    const front = step === "L" ? 3 : step === "R" ? 2 : 2.5;
    P(3, 12, 3, front, dark);
    P(3, 12 + front, 3, 0.5, dark);
    P(3, 15, 3, 1, shoe);
  } else {
    const leftLen = step === "L" ? 3 : 2;
    const rightLen = step === "R" ? 3 : 2;
    P(3, 12, 2, leftLen, dark);
    P(5, 12, 2, rightLen, dark);
    P(3, 15, 2, 1, shoe);
    P(5, 15, 2, 1, shoe);
  }
  return px;
}

// ---- pack the single-page atlas ----
// row per character: [portrait 24×24][4 dirs × (4 walk + 1 idle) 16×20]
const ROW_H = PORTRAIT;
const FRAMES_PER_DIR = WALK_FRAMES + 1; // + idle
const ROW_W = PORTRAIT + DIRS.length * FRAMES_PER_DIR * FRAME_W;
const atlas = new Px(ROW_W, ROW_H * CHARACTER_COUNT);
const frames = {};
const avatars = [];

for (let i = 0; i < CHARACTER_COUNT; i++) {
  const spec = characterSpec(i);
  const rowY = i * ROW_H;

  const portrait = drawPortrait(spec);
  portrait.blitTo(atlas, 0, rowY);
  const portraitName = `${spec.avatarId}_portrait`;
  frames[portraitName] = {
    frame: { x: 0, y: rowY, w: PORTRAIT, h: PORTRAIT },
    sourceSize: { w: PORTRAIT, h: PORTRAIT },
    spriteSourceSize: { x: 0, y: 0, w: PORTRAIT, h: PORTRAIT },
  };
  writeFileSync(
    join(OUT, "portraits", `${spec.avatarId}.png`),
    PNG.sync.write(portrait.png),
  );

  const walk = {};
  const idle = {};
  let cursorX = PORTRAIT;
  for (const dir of DIRS) {
    walk[dir] = [];
    for (let f = 0; f < WALK_FRAMES; f++) {
      const name = `${spec.avatarId}_${dir}_${f}`;
      drawWalkFrame(spec, dir, f).blitTo(atlas, cursorX, rowY);
      frames[name] = {
        frame: { x: cursorX, y: rowY, w: FRAME_W, h: FRAME_H },
        sourceSize: { w: FRAME_W, h: FRAME_H },
        spriteSourceSize: { x: 0, y: 0, w: FRAME_W, h: FRAME_H },
      };
      walk[dir].push(name);
      cursorX += FRAME_W;
    }
    const idleName = `${spec.avatarId}_${dir}_idle`;
    drawWalkFrame(spec, dir, 0).blitTo(atlas, cursorX, rowY);
    frames[idleName] = {
      frame: { x: cursorX, y: rowY, w: FRAME_W, h: FRAME_H },
      sourceSize: { w: FRAME_W, h: FRAME_H },
      spriteSourceSize: { x: 0, y: 0, w: FRAME_W, h: FRAME_H },
    };
    idle[dir] = idleName;
    cursorX += FRAME_W;
  }
  avatars.push({ avatarId: spec.avatarId, portrait: portraitName, walk, idle });
}

writeFileSync(join(OUT, "characters.png"), PNG.sync.write(atlas.png));
writeFileSync(
  join(OUT, "characters.json"),
  JSON.stringify(
    {
      frames,
      meta: { image: "characters.png", format: "RGBA8888", scale: "1" },
    },
    null,
    1,
  ),
);
writeFileSync(join(OUT, "avatars.json"), JSON.stringify(avatars, null, 1));
writeFileSync(
  join(OUT, "CREDITS.md"),
  `# Sprite credits (U15)

- characters.png / portraits/: PROCEDURAL pixel art generated by
  \`apps/web/scripts/generate-sprites.mjs\` — ported from the approved mockup's
  drawing routines (docs/architecture/docs/ui/acos-final.html). Internal work,
  no external assets, no license constraints.
- PixelLab: NOT used in this pass (no API key at build time — recorded
  decision). The atlas/JSON contract matches PixelLab-ASSET-BRIEF.md §2, so a
  later PixelLab render only replaces the art files.
- Office tiles/props: drawn at runtime by the U04 floorplan painter
  (features/office/floorplan.ts + OfficeCanvas) — no baked tile atlas needed.
`,
);
console.log(
  `generated ${CHARACTER_COUNT} characters — atlas ${ROW_W}×${ROW_H * CHARACTER_COUNT}, ${Object.keys(frames).length} frames`,
);
