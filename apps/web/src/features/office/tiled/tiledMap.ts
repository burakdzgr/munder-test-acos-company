// FAZ 2B / 2B-2 — Tiled haritası okuyucu. SAF VERİ: Pixi yok, zamanlayıcı yok.
//
// Munder'ın TiledMapRenderer'ı doğrudan Pixi Sprite üretiyor. Bizde ofis lint
// kuralı render API'lerini TEK köprüye (OfficeCanvas) kilitliyor ve bu kural
// FAZ 2B kararında AÇIKÇA korunuyor. Bu yüzden okuyucu Pixi'ye hiç dokunmaz:
// haritayı "çizim kalemleri" listesine (hangi döşeme, hangi hücre, hangi
// katman) çevirir; köprü onları sprite'a döker. Ayrıştırma, yürünebilirlik,
// isimli koltuklar ve bölgeler burada — hepsi test edilebilir saf fonksiyon.
import { OFFICE_MAP_JSON } from "./officeMap.generated.js";

export interface TiledProperty {
  name: string;
  type: string;
  value: string | number | boolean;
}
export interface TiledLayer {
  name: string;
  type: "tilelayer" | "objectgroup";
  data?: number[];
  objects?: TiledObject[];
}
export interface TiledObject {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface TiledTileset {
  firstgid: number;
  name: string;
  tilecount: number;
  tiles: Array<{ id: number; properties?: TiledProperty[] }>;
}
export interface TiledMapData {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: TiledLayer[];
  tilesets: TiledTileset[];
}

export interface Cell {
  x: number;
  y: number;
}
export interface ZoneRect extends Cell {
  w: number;
  h: number;
}
/** Köprüye verilen tek çizim emri: şu döşemeyi şu hücreye koy. */
export interface DrawItem {
  /** döşeme anahtarı (tiles.ts sanatına çözülür) */
  key: string;
  cx: number;
  cy: number;
  layer: "floor" | "walls" | "furniture-below" | "furniture-above";
}

export interface OfficeMap {
  width: number;
  height: number;
  tileSize: number;
  /** gid → döşeme anahtarı */
  keyByGid: Map<number, string>;
  /** yürünebilirlik: [y][x] */
  walkable: boolean[][];
  /** isimli koltuklar: 'desk-ceo', 'pc-1' … → hücre */
  seats: Map<string, Cell>;
  /** haritadaki koltuk SIRASI — SeatPool aynı sırayı kullanır */
  seatOrder: string[];
  zones: Map<string, ZoneRect>;
  draw: DrawItem[];
}

const LAYER_ORDER: DrawItem["layer"][] = [
  "floor",
  "walls",
  "furniture-below",
  "furniture-above",
];

function tilesetKeys(map: TiledMapData): Map<number, string> {
  const keys = new Map<number, string>();
  for (const set of map.tilesets) {
    for (const tile of set.tiles ?? []) {
      const prop = tile.properties?.find((p) => p.name === "key");
      if (typeof prop?.value === "string") keys.set(set.firstgid + tile.id, prop.value);
    }
  }
  return keys;
}

export function parseOfficeMap(raw: string): OfficeMap {
  const data = JSON.parse(raw) as TiledMapData;
  const keyByGid = tilesetKeys(data);
  const layerByName = new Map(data.layers.map((l) => [l.name, l]));

  const walkable: boolean[][] = [];
  const collision = layerByName.get("collision")?.data ?? [];
  for (let y = 0; y < data.height; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < data.width; x += 1) row.push(collision[y * data.width + x] === 0);
    walkable.push(row);
  }

  const seats = new Map<string, Cell>();
  const seatOrder: string[] = [];
  for (const object of layerByName.get("spawn-points")?.objects ?? []) {
    const cell = {
      x: Math.round(object.x / data.tilewidth),
      y: Math.round(object.y / data.tileheight),
    };
    seats.set(object.name, cell);
    seatOrder.push(object.name);
  }

  const zones = new Map<string, ZoneRect>();
  for (const object of layerByName.get("zones")?.objects ?? []) {
    zones.set(object.name, {
      x: Math.round(object.x / data.tilewidth),
      y: Math.round(object.y / data.tileheight),
      w: Math.round(object.width / data.tilewidth),
      h: Math.round(object.height / data.tileheight),
    });
  }

  const draw: DrawItem[] = [];
  for (const name of LAYER_ORDER) {
    const layer = layerByName.get(name);
    if (!layer?.data) continue;
    for (let y = 0; y < data.height; y += 1) {
      for (let x = 0; x < data.width; x += 1) {
        const gid = layer.data[y * data.width + x] ?? 0;
        if (!gid) continue;
        const key = keyByGid.get(gid);
        if (key) draw.push({ key, cx: x, cy: y, layer: name });
      }
    }
  }

  return {
    width: data.width,
    height: data.height,
    tileSize: data.tilewidth,
    keyByGid,
    walkable,
    seats,
    seatOrder,
    zones,
    draw,
  };
}

export const isWalkable = (map: OfficeMap, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && y < map.walkable.length && x < map.width && !!map.walkable[y]?.[x];

/** Bölge merkezine en yakın YÜRÜNEBİLİR hücre (toplantı/kafeterya hedefleri). */
export function zoneAnchor(map: OfficeMap, zone: string): Cell | null {
  const rect = map.zones.get(zone);
  if (!rect) return null;
  const center = { x: Math.floor(rect.x + rect.w / 2), y: Math.floor(rect.y + rect.h / 2) };
  return nearestWalkable(map, center);
}

/** Verilen hücre yürünemezse en yakın yürünebilir komşusunu bulur (BFS). */
export function nearestWalkable(map: OfficeMap, from: Cell): Cell | null {
  if (isWalkable(map, from.x, from.y)) return from;
  const seen = new Set<string>([`${from.x},${from.y}`]);
  const queue: Cell[] = [from];
  while (queue.length > 0) {
    const cell = queue.shift() as Cell;
    for (const next of neighbours(cell)) {
      const id = `${next.x},${next.y}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (next.x < 0 || next.y < 0 || next.x >= map.width || next.y >= map.height) continue;
      if (isWalkable(map, next.x, next.y)) return next;
      queue.push(next);
    }
  }
  return null;
}

const neighbours = (cell: Cell): Cell[] => [
  { x: cell.x + 1, y: cell.y },
  { x: cell.x - 1, y: cell.y },
  { x: cell.x, y: cell.y + 1 },
  { x: cell.x, y: cell.y - 1 },
];

/**
 * Kat üstünde rota (BFS, 4 yön).
 *
 * NEDEN GEREKLİ: projektör talimatları SUNUCUNUN kendi yerleşimine göre
 * hesaplanmış yol taşıyor; kat artık sabit ve elle çizilmiş olduğu için o
 * yol bizim duvarlarımızın içinden geçerdi. Hareketin SEBEBİ ve ZAMANI
 * talimattan gelmeye devam eder (kimse talimatsız kıpırdamaz); yalnız
 * GÜZERGÂH bu kata yeniden yansıtılır.
 */
export function routeOnFloor(map: OfficeMap, from: Cell, to: Cell): Cell[] {
  const start = nearestWalkable(map, from);
  const goal = nearestWalkable(map, to);
  if (!start || !goal) return [];
  if (start.x === goal.x && start.y === goal.y) return [goal];

  const key = (c: Cell) => `${c.x},${c.y}`;
  const previous = new Map<string, Cell>();
  const seen = new Set<string>([key(start)]);
  const queue: Cell[] = [start];
  while (queue.length > 0) {
    const cell = queue.shift() as Cell;
    if (cell.x === goal.x && cell.y === goal.y) break;
    for (const next of neighbours(cell)) {
      if (!isWalkable(map, next.x, next.y)) continue;
      const id = key(next);
      if (seen.has(id)) continue;
      seen.add(id);
      previous.set(id, cell);
      queue.push(next);
    }
  }
  if (!seen.has(key(goal))) return [];

  const path: Cell[] = [];
  let cursor: Cell | undefined = goal;
  while (cursor && !(cursor.x === start.x && cursor.y === start.y)) {
    path.push(cursor);
    cursor = previous.get(key(cursor));
  }
  return path.reverse();
}

let cached: OfficeMap | null = null;
/** Uygulama ömründe bir kez ayrıştırılır. */
export function officeMap(): OfficeMap {
  cached ??= parseOfficeMap(OFFICE_MAP_JSON);
  return cached;
}
