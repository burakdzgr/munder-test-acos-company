// FAZ 2B / 2B-2 — ofis katının ÜRETECİ.
//
// Munder'ın kat KOMPOZİSYONUNU (sabit harita, isimli masalar, boardroom +
// cafeteria bölgeleri) alıyoruz; PİKSELLERİ kendimizin. Munder'ın döşeme
// atlasları LimeZu FREE lisanslı ve ticari kullanıma kapalı, bu yüzden repoya
// TEK BİR LimeZu dosyası girmiyor: gid'ler bizim kendi elle yazılmış
// döşemelerimize (features/office/tiles.ts) işaret ediyor.
//
// Çıktı Tiled JSON (.tmj) şemasına uyar: floor / walls / furniture-below /
// furniture-above / collision döşeme katmanları + spawn-points ve zones nesne
// katmanları. Döşeme seti haritanın İÇİNE gömülür (her gid'in `key`'i tile
// property'sinde) — böylece gid↔sanat eşlemesi için ikinci bir doğruluk
// kaynağı olmaz.
//
// Kullanım: node apps/web/scripts/gen-office-map.mjs
// Yazdığı dosya: apps/web/src/features/office/tiled/office.tmj
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../src/features/office/tiled/office.tmj");
// .tmj Tiled ile duzenlenebilir DEGIS-TOKUS bicimi; TS modulu ondan uretilir
// (bundler eklentisine bagimli olmadan hem vite hem vitest hem tsc okusun).
const OUT_TS = resolve(HERE, "../src/features/office/tiled/officeMap.generated.ts");

const W = 34;
const H = 22;
const TILE = 32; // ekran pikseli/hücre (mevcut köprüdeki CELL ile aynı)

// --- döşeme seti: sıra = gid-1. `key` çalışma anında sanata çözülür. ---
const TILES = [
  { key: "floor-open", solid: false },      // 1
  { key: "floor-corridor", solid: false },  // 2
  { key: "floor-wood", solid: false },      // 3  toplantı odası
  { key: "floor-cafe", solid: false },      // 4  kafeterya
  { key: "wall", solid: true },             // 5
  { key: "desk", solid: true },             // 6
  { key: "table", solid: true },            // 7  boardroom masası (5x2)
  { key: "plant", solid: true },            // 8
  { key: "coffee", solid: true },           // 9
  { key: "rack", solid: true },             // 10
  { key: "whiteboard", solid: true },       // 11
  { key: "sofa", solid: true },             // 12
  { key: "bookshelf", solid: true },        // 13
  { key: "cabinet", solid: true },          // 14
  { key: "watercooler", solid: true },      // 15
  { key: "rug", solid: false },             // 16
];
const gid = (key) => TILES.findIndex((t) => t.key === key) + 1;

const blank = () => new Array(W * H).fill(0);
const floor = blank();
const walls = blank();
const furnBelow = blank();
const furnAbove = blank();
const collision = blank();

const at = (x, y) => y * W + x;
const inside = (x, y) => x >= 0 && y >= 0 && x < W && y < H;
const set = (layer, x, y, value) => {
  if (inside(x, y)) layer[at(x, y)] = value;
};
const fill = (layer, rect, value) => {
  for (let y = rect.y; y < rect.y + rect.h; y += 1)
    for (let x = rect.x; x < rect.x + rect.w; x += 1) set(layer, x, y, value);
};
const border = (layer, rect, value) => {
  for (let x = rect.x; x < rect.x + rect.w; x += 1) {
    set(layer, x, rect.y, value);
    set(layer, x, rect.y + rect.h - 1, value);
  }
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    set(layer, rect.x, y, value);
    set(layer, rect.x + rect.w - 1, y, value);
  }
};

// --- zemin: her yer açık ofis, sonra odalar kendi zeminini boyar ---
fill(floor, { x: 0, y: 0, w: W, h: H }, gid("floor-open"));

// dış duvar
border(walls, { x: 0, y: 0, w: W, h: H }, gid("wall"));

// CEO odası (sol üst)
const ceo = { x: 1, y: 1, w: 9, h: 7 };
fill(floor, ceo, gid("floor-wood"));
border(walls, ceo, gid("wall"));
set(walls, ceo.x + ceo.w - 1, ceo.y + 4, 0); // kapı

// Toplantı odası (sağ üst)
const board = { x: 23, y: 1, w: 10, h: 8 };
fill(floor, board, gid("floor-wood"));
border(walls, board, gid("wall"));
set(walls, board.x, board.y + 4, 0); // kapı

// Kafeterya (sağ alt)
const cafe = { x: 23, y: 13, w: 10, h: 8 };
fill(floor, cafe, gid("floor-cafe"));
border(walls, cafe, gid("wall"));
set(walls, cafe.x, cafe.y + 3, 0); // kapı

// Koridorlar: dikey (CEO/açık ofis arası) + yatay (sağ odalara)
for (let y = 1; y < H - 1; y += 1) set(floor, 11, y, gid("floor-corridor"));
for (let x = 11; x < 23; x += 1) {
  set(floor, x, 5, gid("floor-corridor"));
  set(floor, x, 16, gid("floor-corridor"));
}

// --- mobilya + isimli masalar ---
const spawns = [];
const desks = [];
/** Masa: `anchor` masanın çizileceği hücre; avatar masanın ÖNÜNDE durur. */
const desk = (name, x, y) => {
  set(furnBelow, x, y, gid("desk"));
  set(collision, x, y, 1);
  desks.push({ name, x, y });
  spawns.push({ name, x, y: y + 1 }); // oturma/duruş hücresi
};

desk("desk-ceo", 4, 3);
desk("desk-team-lead", 14, 3);
desk("desk-product-manager", 17, 3);
desk("desk-backend-engineer", 14, 8);
desk("desk-frontend-engineer", 17, 8);
desk("desk-data-engineer", 14, 12);
desk("desk-project-manager", 17, 12);
for (let i = 0; i < 6; i += 1) {
  const x = 20;
  const y = 3 + i * 3;
  if (y < H - 2) desk(`pc-${i + 1}`, x, y);
}

// boardroom masası (5x2 çizilir, çapa hücresi işaretlenir)
set(furnBelow, board.x + 3, board.y + 3, gid("table"));
for (let x = board.x + 1; x < board.x + 8; x += 1)
  for (let y = board.y + 2; y < board.y + 5; y += 1) set(collision, x, y, 1);

// dekor
set(furnAbove, 2, 1 + 1, gid("bookshelf"));
set(furnBelow, 8, 6, gid("plant"));
set(furnAbove, 12, 1, gid("whiteboard"));
set(furnBelow, 25, 15, gid("coffee"));
set(furnBelow, 28, 15, gid("watercooler"));
set(furnBelow, 26, 18, gid("sofa"));
set(furnBelow, 31, 19, gid("plant"));
set(furnBelow, 21, 19, gid("rack"));
set(furnBelow, 9, 19, gid("cabinet"));
set(furnBelow, 6, 18, gid("rug"));
for (const [x, y] of [
  [2, 6],
  [12, 19],
  [22, 2],
])
  set(furnBelow, x, y, gid("plant"));

// duvarlar çarpışmaya girer
for (let y = 0; y < H; y += 1)
  for (let x = 0; x < W; x += 1) if (walls[at(x, y)]) collision[at(x, y)] = 1;
// dekor mobilyası da katı (rug hariç)
for (const layer of [furnBelow, furnAbove])
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1) {
      const g = layer[at(x, y)];
      if (!g) continue;
      const spec = TILES[g - 1];
      if (spec?.solid) collision[at(x, y)] = 1;
    }
// spawn hücreleri her hâlükârda yürünebilir kalmalı
for (const s of spawns) collision[at(s.x, s.y)] = 0;

const layer = (name, data) => ({
  name,
  type: "tilelayer",
  width: W,
  height: H,
  x: 0,
  y: 0,
  opacity: 1,
  visible: true,
  data,
});

const map = {
  compressionlevel: -1,
  width: W,
  height: H,
  tilewidth: TILE,
  tileheight: TILE,
  infinite: false,
  orientation: "orthogonal",
  renderorder: "right-down",
  type: "map",
  version: "1.10",
  tiledversion: "1.10.2-acos-gen",
  nextlayerid: 8,
  nextobjectid: spawns.length + 3,
  layers: [
    layer("floor", floor),
    layer("walls", walls),
    layer("furniture-below", furnBelow),
    layer("furniture-above", furnAbove),
    layer("collision", collision),
    {
      name: "spawn-points",
      type: "objectgroup",
      objects: spawns.map((s, i) => ({
        id: i + 1,
        name: s.name,
        x: s.x * TILE,
        y: s.y * TILE,
        width: TILE,
        height: TILE,
        type: "",
        visible: true,
      })),
    },
    {
      name: "zones",
      type: "objectgroup",
      objects: [
        {
          id: spawns.length + 1,
          name: "boardroom",
          x: board.x * TILE,
          y: board.y * TILE,
          width: board.w * TILE,
          height: board.h * TILE,
          type: "",
          visible: true,
        },
        {
          id: spawns.length + 2,
          name: "cafeteria",
          x: cafe.x * TILE,
          y: cafe.y * TILE,
          width: cafe.w * TILE,
          height: cafe.h * TILE,
          type: "",
          visible: true,
        },
      ],
    },
  ],
  tilesets: [
    {
      firstgid: 1,
      name: "acos-office",
      // ACOS: atlas PNG yok — her gid çalışma anında kendi piksel sanatımıza
      // (features/office/tiles.ts) çözülür. `key` tek doğruluk kaynağıdır.
      tilewidth: TILE,
      tileheight: TILE,
      tilecount: TILES.length,
      columns: 0,
      grid: { orientation: "orthogonal", width: TILE, height: TILE },
      tiles: TILES.map((t, i) => ({
        id: i,
        properties: [
          { name: "key", type: "string", value: t.key },
          { name: "solid", type: "bool", value: t.solid },
        ],
      })),
    },
  ],
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(map, null, 1)}\n`, "utf8");
writeFileSync(
  OUT_TS,
  [
    "// URETILMIS DOSYA — elle duzenlemeyin.",
    "// Kaynak: office.tmj (Tiled ile duzenlenebilir) · Uretec: scripts/gen-office-map.mjs",
    "// Yeniden uretmek icin: node apps/web/scripts/gen-office-map.mjs",
    "export const OFFICE_MAP_JSON = `" + JSON.stringify(map) + "`;",
    "",
  ].join(String.fromCharCode(10)),
  "utf8",
);
console.log(
  `office.tmj yazıldı: ${W}x${H}, ${spawns.length} isimli koltuk, 2 bölge, ${TILES.length} döşeme`,
);
