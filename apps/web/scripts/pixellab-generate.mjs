// PixelLab sprite üretimi (PixelLab-ASSET-BRIEF.md — U15 sözleşmesinin GERÇEK
// sanat koşumu). generate-sprites.mjs ile AYNI çıktı sözleşmesini üretir
// (characters.png/json + portraits/avNN.png + avatars.json + CREDITS.md),
// yalnız sanat kaynağı PixelLab API'sidir. Tek seferlik design-time aracı —
// runtime bağımlılığı YOK (brief §0).
//
//   PIXELLAB_API_KEY=... node scripts/pixellab-generate.mjs           (from apps/web)
//   PIXELLAB_API_KEY=... node scripts/pixellab-generate.mjs --tiles   (ofis tileset'i de)
//
// Boru hattı (karakter başına ~9 API çağrısı, tamamı .pixellab-cache/ altında
// önbelleklenir — yarıda kesilse bile yeniden koşum yalnız eksikleri üretir):
//   1. pixflux  : 64×64 taban karakter (low top-down, south, şeffaf zemin)
//   2. rotate   : south → east / west / north tabanları
//   3. animate-with-text: yön başına 4 karelik yürüme döngüsü (64×64 sabit)
//   4. idle     : yönün taban (duruş) karesi
//   5. pixflux  : 64×64 portre büstü
// Hücre boyutu 64×64 — OfficeCanvas ölçeği kare boyutundan türetir (32×40
// ayak izi), bu yüzden 16×20 prosedürel setle de bu setle de çalışır.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "pngjs";

const { PNG } = pkg;

const API = "https://api.pixellab.ai/v1";
const KEY = process.env.PIXELLAB_API_KEY ?? process.env.PIXELLAB_SECRET ?? "";
if (!KEY) {
  console.error("PIXELLAB_API_KEY env değişkeni gerekli (infrastructure/docker/.env'de duruyor).");
  process.exit(1);
}

const OUT = join(process.cwd(), "public", "sprites", "characters");
const TILES_OUT = join(process.cwd(), "public", "sprites", "tiles");
const CACHE = join(process.cwd(), "scripts", ".pixellab-cache");
mkdirSync(join(OUT, "portraits"), { recursive: true });
mkdirSync(CACHE, { recursive: true });

const CELL = 64; // animate-with-text sabit 64×64 üretir; atlas hücresi de bu
const DIRS = ["down", "up", "left", "right"];
const API_DIR = { down: "south", up: "north", left: "west", right: "east" };
const WALK_FRAMES = 4;
const CHARACTER_COUNT = 24;

// 24 karakter tarifi — brief §A: takım/hoodie/gözlük/sakal/şapka çeşitliliği,
// tek set gibi okunacak ortak stil son ekiyle.
const STYLE =
  "top-down RPG office worker sprite, readable at small size, flat colors, " +
  "single color black outline, transparent background, full body, standing";
const CHARACTERS = [
  "young woman, short black bob haircut, blue office shirt, dark trousers",
  "man with brown short hair and beard, grey hoodie, jeans",
  "woman with long blonde ponytail, purple blouse, black skirt",
  "man in navy business suit with white shirt and red tie, black shoes",
  "woman with curly red hair, green sweater, dark jeans",
  "bald man with glasses, white shirt, grey vest, dark trousers",
  "woman with dark skin and braided hair, orange cardigan, black trousers",
  "young man with black spiky hair, black t-shirt, beige chinos",
  "woman with grey bun and glasses, teal blouse, long dark skirt",
  "man with dark skin, short afro, yellow polo shirt, navy trousers",
  "woman with brown shoulder-length hair, red flannel shirt, jeans",
  "man with blonde undercut, dark green jacket, black trousers",
  "woman in charcoal business suit, white blouse, short black hair",
  "man with long brown hair in a man-bun, denim shirt, dark jeans",
  "east asian woman with straight black hair, pink cardigan, grey skirt",
  "man with red beard and flat cap, brown sweater, dark trousers",
  "woman with turquoise dyed short hair, black hoodie, ripped jeans",
  "older man with white hair and moustache, brown suit vest, tie",
  "woman with hijab in dark blue, lilac tunic, black trousers",
  "man with dreadlocks tied back, olive t-shirt, cargo trousers",
  "woman with pixie cut and big round glasses, mustard blouse, jeans",
  "tall man in black turtleneck and glasses, grey trousers",
  "woman with long dark braid, burgundy dress, flat shoes",
  "man with baseball cap worn backwards, white tee, blue overshirt, jeans",
];

let spentUsd = 0;
let spentGen = 0;
let apiCalls = 0;

async function pixellab(endpoint, body, attempt = 1) {
  const res = await fetch(`${API}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && attempt <= 5) {
    const wait = attempt * 15_000;
    console.log(`  429 — ${wait / 1000}s bekleniyor…`);
    await new Promise((r) => setTimeout(r, wait));
    return pixellab(endpoint, body, attempt + 1);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${endpoint} ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  apiCalls += 1;
  if (json.usage?.usd) spentUsd += json.usage.usd;
  if (json.usage?.generations) spentGen += json.usage.generations;
  return json;
}

const b64 = (buffer) => ({ type: "base64", base64: buffer.toString("base64") });
const fromB64 = (image) => Buffer.from(image.base64, "base64");

/** Önbellekli üretim: cache dosyası varsa API'ye hiç gitmez (yeniden koşum ucuz). */
async function cached(name, produce) {
  const path = join(CACHE, name);
  if (existsSync(path)) return readFileSync(path);
  const buffer = await produce();
  writeFileSync(path, buffer);
  return buffer;
}

async function generateCharacter(index) {
  const avatarId = `av${String(index + 1).padStart(2, "0")}`;
  const desc = CHARACTERS[index];
  console.log(`[${avatarId}] ${desc.slice(0, 60)}…`);

  // 1) taban (south) — tüm yönlerin ve animasyonların referansı
  const baseSouth = await cached(`${avatarId}_base_south.png`, async () => {
    const r = await pixellab("/generate-image-pixflux", {
      description: `${desc}, ${STYLE}`,
      image_size: { width: CELL, height: CELL },
      no_background: true,
      view: "low top-down",
      direction: "south",
      outline: "single color black outline",
      shading: "basic shading",
      detail: "medium detail",
      seed: 1000 + index,
    });
    return fromB64(r.image);
  });

  // 2) rotasyonlar — south tabanından
  const bases = { down: baseSouth };
  for (const dir of ["up", "left", "right"]) {
    bases[dir] = await cached(`${avatarId}_base_${API_DIR[dir]}.png`, async () => {
      const r = await pixellab("/rotate", {
        image_size: { width: CELL, height: CELL },
        from_view: "low top-down",
        to_view: "low top-down",
        from_direction: "south",
        to_direction: API_DIR[dir],
        from_image: b64(baseSouth),
        seed: 1000 + index,
      });
      return fromB64(r.image);
    });
  }

  // 3) yön başına yürüme döngüsü
  const walks = {};
  for (const dir of DIRS) {
    const frames = [];
    const missing = [...Array(WALK_FRAMES).keys()].some(
      (f) => !existsSync(join(CACHE, `${avatarId}_walk_${API_DIR[dir]}_${f}.png`)),
    );
    if (missing) {
      const r = await pixellab("/animate-with-text", {
        image_size: { width: CELL, height: CELL },
        description: `${desc}, top-down RPG office worker sprite`,
        action: "walk",
        view: "low top-down",
        direction: API_DIR[dir],
        n_frames: WALK_FRAMES,
        reference_image: b64(bases[dir]),
        seed: 1000 + index,
      });
      r.images.slice(0, WALK_FRAMES).forEach((img, f) => {
        writeFileSync(join(CACHE, `${avatarId}_walk_${API_DIR[dir]}_${f}.png`), fromB64(img));
      });
    }
    for (let f = 0; f < WALK_FRAMES; f++) {
      frames.push(readFileSync(join(CACHE, `${avatarId}_walk_${API_DIR[dir]}_${f}.png`)));
    }
    walks[dir] = frames;
  }

  // 4) portre büstü
  const portrait = await cached(`${avatarId}_portrait.png`, async () => {
    const r = await pixellab("/generate-image-pixflux", {
      description: `pixel art portrait bust of ${desc}, head and shoulders, facing the viewer, transparent background, single color black outline, flat colors`,
      image_size: { width: CELL, height: CELL },
      no_background: true,
      view: "side",
      direction: "south",
      detail: "medium detail",
      seed: 1000 + index,
    });
    return fromB64(r.image);
  });

  console.log(
    `  ✓ ${avatarId} (toplam $${spentUsd.toFixed(3)} + ${spentGen} gen, ${apiCalls} çağrı)`,
  );
  return { avatarId, portrait, bases, walks };
}

function decode(buffer) {
  return PNG.sync.read(buffer);
}

function blit(srcPng, atlasPng, dx, dy) {
  PNG.bitblt(srcPng, atlasPng, 0, 0, srcPng.width, srcPng.height, dx, dy);
}

async function main() {
  const balance = await fetch(`${API}/balance`, {
    headers: { Authorization: `Bearer ${KEY}` },
  }).then((r) => r.json());
  console.log(
    `PixelLab bakiyesi: $${balance.usd ?? 0} — abonelik "generations" kotası ayrıca kullanılabilir; ` +
      "kota biterse koşum hata verir, önbellek sayesinde yeniden koşum kaldığı yerden sürer.",
  );

  // 3'lü havuz: karakterler bağımsız — mütevazı paralellik, 429 backoff'u hazır
  const results = new Array(CHARACTER_COUNT);
  let next = 0;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < CHARACTER_COUNT) {
        const i = next++;
        results[i] = await generateCharacter(i);
      }
    }),
  );

  // ---- atlası paketle: satır başına [portre][4 yön × (4 yürüme + idle)] ----
  const FRAMES_PER_DIR = WALK_FRAMES + 1;
  const ROW_W = CELL + DIRS.length * FRAMES_PER_DIR * CELL;
  const atlas = new PNG({ width: ROW_W, height: CELL * CHARACTER_COUNT });
  const frames = {};
  const avatars = [];

  for (const [i, ch] of results.entries()) {
    const rowY = i * CELL;
    const portraitPng = decode(ch.portrait);
    blit(portraitPng, atlas, 0, rowY);
    const portraitName = `${ch.avatarId}_portrait`;
    frames[portraitName] = {
      frame: { x: 0, y: rowY, w: CELL, h: CELL },
      sourceSize: { w: CELL, h: CELL },
      spriteSourceSize: { x: 0, y: 0, w: CELL, h: CELL },
    };
    writeFileSync(join(OUT, "portraits", `${ch.avatarId}.png`), ch.portrait);

    const walk = {};
    const idle = {};
    let cursorX = CELL;
    for (const dir of DIRS) {
      walk[dir] = [];
      for (let f = 0; f < WALK_FRAMES; f++) {
        const name = `${ch.avatarId}_${dir}_${f}`;
        blit(decode(ch.walks[dir][f]), atlas, cursorX, rowY);
        frames[name] = {
          frame: { x: cursorX, y: rowY, w: CELL, h: CELL },
          sourceSize: { w: CELL, h: CELL },
          spriteSourceSize: { x: 0, y: 0, w: CELL, h: CELL },
        };
        walk[dir].push(name);
        cursorX += CELL;
      }
      const idleName = `${ch.avatarId}_${dir}_idle`;
      blit(decode(ch.bases[dir]), atlas, cursorX, rowY);
      frames[idleName] = {
        frame: { x: cursorX, y: rowY, w: CELL, h: CELL },
        sourceSize: { w: CELL, h: CELL },
        spriteSourceSize: { x: 0, y: 0, w: CELL, h: CELL },
      };
      idle[dir] = idleName;
      cursorX += CELL;
    }
    avatars.push({ avatarId: ch.avatarId, portrait: portraitName, walk, idle });
  }

  writeFileSync(join(OUT, "characters.png"), PNG.sync.write(atlas));
  writeFileSync(
    join(OUT, "characters.json"),
    JSON.stringify({ frames, meta: { image: "characters.png", format: "RGBA8888", scale: "1" } }, null, 1),
  );
  writeFileSync(join(OUT, "avatars.json"), JSON.stringify(avatars, null, 1));
  writeFileSync(
    join(OUT, "CREDITS.md"),
    `# Sprite credits\n\n- 24 characters (portraits + 4-dir walk cycles + idles): generated with the\n  [PixelLab](https://www.pixellab.ai) API (pixflux + rotate + animate-with-text),\n  ${new Date().toISOString().slice(0, 10)}. See PixelLab's asset license/ToS before\n  distribution/commercial use (PixelLab-ASSET-BRIEF.md §4).\n- Generation script: apps/web/scripts/pixellab-generate.mjs (design-time only;\n  PixelLab is not a runtime dependency).\n`,
  );
  console.log(`\nkarakterler tamam — $${spentUsd.toFixed(3)}, ${apiCalls} çağrı`);

  // ---- opsiyonel: ofis tileset'i (brief §B) — üretim; painter entegrasyonu ayrı iş
  if (process.argv.includes("--tiles")) {
    mkdirSync(TILES_OUT, { recursive: true });
    const PROPS = [
      ["desk", "pixel art office L-desk with computer monitor, top-down view, transparent background", 64, 48],
      ["chair", "pixel art office swivel chair, top-down view, transparent background", 32, 32],
      ["server_rack", "pixel art server rack cabinet with blinking lights, top-down RPG view, transparent background", 48, 64],
      ["meeting_table", "pixel art large oval meeting table, top-down view, transparent background", 96, 64],
      ["plant", "pixel art potted office plant, top-down RPG view, transparent background", 32, 40],
      ["coffee_machine", "pixel art coffee machine on small counter, top-down RPG view, transparent background", 32, 40],
      ["reception_desk", "pixel art curved reception lobby desk, top-down view, transparent background", 96, 48],
      ["floor_tile", "pixel art seamless office floor tile, neutral grey carpet, top-down", 32, 32],
      ["wall_tile", "pixel art office wall segment with top edge highlight, top-down RPG pseudo-3d", 32, 32],
      ["door_tile", "pixel art office door tile seen from above, top-down RPG", 32, 32],
    ];
    for (const [key, desc, w, h] of PROPS) {
      const buffer = await cached(`tile_${key}.png`, async () => {
        const r = await pixellab("/generate-image-pixflux", {
          description: desc,
          image_size: { width: w, height: h },
          no_background: !key.endsWith("_tile"),
          detail: "medium detail",
          outline: "single color black outline",
          seed: 7000,
        });
        return fromB64(r.image);
      });
      writeFileSync(join(TILES_OUT, `${key}.png`), buffer);
      console.log(`tile ${key} ✓`);
    }
    console.log(`tileset tamam — toplam $${spentUsd.toFixed(3)}`);
  }
}

await main();
