// Pixi bridge (23 §5, §7; 36 §7 — U04): mounts the Pixi app, renders the
// derived floorplan (walls/corridor/rooms/props from floorplan.ts) plus the
// avatar/effect layers from the headless engine, and drives engine.tick from
// the Pixi ticker. This file is the ONLY place in the office module allowed
// to touch animation APIs (office lint rule — no fake motion; every visible
// change traces to a projector instruction). Avatars stay circles until U15
// swaps in the PixelLab sprites. React renders overlays only; per-frame
// state never enters React.
import { useEffect, useRef, useState } from "react";
import {
  AnimatedSprite,
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  Texture,
  TilingSprite,
  type Spritesheet,
} from "pixi.js";
import { useOfficeStore } from "../../stores/office.js";
import { useFocus } from "../../stores/focus.js";
import type { OfficeSceneEngine } from "./sceneState.js";
import { WALL, computeFloorplan, type Floorplan } from "./floorplan.js";
import {
  BOOKSHELF_ART,
  CABINET_ART,
  COFFEE_ART,
  DESK_ART,
  PLANT_ART,
  RACK_ART,
  RUG_ART,
  SOFA_ART,
  WATERCOOLER_ART,
  WHITEBOARD_ART,
  artSize,
  corridorTileArt,
  emitArt,
  floorTileArt,
  wallFaceArt,
  woodPlankArt,
  type PixelArt,
} from "./tiles.js";
import {
  SPRITE_BASE,
  loadAvatars,
  resolveAvatarId,
  type AvatarEntry,
  type WalkDir,
} from "./characters.js";

// presence palette (36 §2)
const BADGE_COLOR: Record<string, number> = {
  IDLE: 0x5c6773,
  WORKING: 0x4c9aff,
  COMMUNICATING: 0x3fd0a0,
  REVIEWING: 0xffcb47,
  ESCALATING: 0xff4d4d,
  OFFLINE: 0x3a424c,
  THINKING: 0xa879ff,
};

const BG = 0x0b0e13;

/**
 * Sanat pikseli başına ekran pikseli.
 *
 * 2 seçildi: hücre 32px, masa çizimi 32 sanat pikseli geniş → masa tam 2
 * hücre. 1 olsaydı pikseller görünmez, 4 olsaydı ofis ekrana sığmazdı.
 * Piksel sanatının "chunky" okunması bu katsayıdan geliyor.
 */
const PIXEL = 2;

const hexInt = (hex: string): number => parseInt(hex.slice(1), 16);
/**
 * Oda zemini taban tonu (2026-08-18 sanat turu): vurgu %25, AÇIK nötr gri
 * %75. Eski karışım app-koyusuna gidiyordu ve ofis "gece vardiyası" gibi
 * duruyordu; AGENTDESK referansı aydınlık karo ister — koridorla aynı
 * parlaklık bandında, ama departman vurgusunu taşıyan bir ton.
 */
const FLOOR_NEUTRAL = 0x8d94a1;
function roomBase(accent: string): string {
  const a = parseInt(accent.slice(1), 16);
  const d = FLOOR_NEUTRAL;
  const mix = (shift: number) =>
    Math.round(((a >> shift) & 255) * 0.25 + ((d >> shift) & 255) * 0.75);
  return `#${((mix(16) << 16) | (mix(8) << 8) | mix(0)).toString(16).padStart(6, "0")}`;
}

declare global {
  interface Window {
    __acosOffice?: {
      readonly lastAppliedEventId: string | null;
      readonly agentCount: number;
      readonly interactionCount: number;
      readonly snapshotCount: number;
      readonly debugRing: unknown[];
    };
  }
}

function installDebugHook(engine: OfficeSceneEngine, getSnapshotCount: () => number): void {
  window.__acosOffice = {
    get lastAppliedEventId() {
      return engine.lastAppliedEventId;
    },
    get agentCount() {
      return engine.avatars.size;
    },
    get interactionCount() {
      return engine.interactions.size;
    },
    get snapshotCount() {
      return getSnapshotCount();
    },
    get debugRing() {
      return [...engine.debugRing.slice(-20)];
    },
  };
}

/**
 * Bir piksel çizimini TEK SEFER dokuya pişirir.
 *
 * `scaleMode: "nearest"`: piksel sanatı büyütülürken yumuşatılırsa bulanır ve
 * bütün mesele kaybolur. Doku başına bir kez pişirilir, sonra sprite olarak
 * defalarca kullanılır — 40 masa tek dokudan 40 sprite demek.
 */
function bakeArt(app: Application, art: PixelArt, pixel: number): Texture {
  const g = new Graphics();
  emitArt(art, pixel, (x, y, w, h, color) => {
    g.rect(x, y, w, h).fill(color);
  });
  const texture = app.renderer.generateTexture({ target: g, resolution: 1 });
  texture.source.scaleMode = "nearest";
  g.destroy();
  return texture;
}

/**
 * Masa çiziminin sol-üst köşesi.
 *
 * Hücre = sandalyenin bulunduğu yer (avatar oraya oturur); masa üstü ve
 * monitör onun üstünde durur. Hem masa sprite'ı hem de canlı monitör
 * tonlaması BU fonksiyondan konumlanır — iki yerde ayrı ofset tutmak,
 * çizim değiştiğinde birinin kayması demekti.
 */
/** "Emre Şahin" → "Emre S." — plan üzerinde yan yana masalar için. */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return parts[0]?.slice(0, 12) ?? "";
  return `${parts[0]!.slice(0, 10)} ${parts[parts.length - 1]![0]}.`;
}

/**
 * Masa isim plakaları (2026-08-18 sanat turu, AGENTDESK dili): her sahipli
 * masanın üstünde koyu plaka + BÜYÜK harf ilk ad. Kadro/yerleşim değişince
 * yeniden kurulur — kare başına iş yok (plaka imzası ticker'da diff'lenir).
 */
function paintNamePlates(
  layer: Container,
  plan: Floorplan,
  cell: number,
  names: ReadonlyMap<string, string>,
): void {
  layer.removeChildren();
  for (const room of plan.rooms) {
    for (const desk of room.desks) {
      if (!desk.agentId) continue;
      const fullName = names.get(desk.agentId);
      if (!fullName) continue;
      const text = (fullName.trim().split(/\s+/)[0] ?? "").toUpperCase().slice(0, 10);
      if (!text) continue;
      const origin = deskOrigin(desk.cell, cell);
      const label = new Text({
        text,
        style: { fill: 0xe8ecf2, fontSize: 8, fontFamily: "monospace", fontWeight: "bold" },
      });
      const w = label.width + 8;
      const plate = new Graphics();
      plate
        .roundRect(desk.cell.x * cell - w / 2, origin.y - 11, w, 11, 2)
        .fill({ color: 0x131820, alpha: 0.88 })
        .stroke({ color: hexInt(room.accent), width: 1, alpha: 0.5 });
      label.anchor.set(0.5, 0);
      label.position.set(desk.cell.x * cell, origin.y - 9.5);
      layer.addChild(plate, label);
    }
  }
}

function deskOrigin(cell: { x: number; y: number }, cellSize: number): { x: number; y: number } {
  const size = artSize(DESK_ART, PIXEL);
  // Katsayı 0.72 → 1.0: 0.72'de masa üstü hücrenin hemen üstüne düşüyordu ve
  // avatar (hücrede, ~32px boyunda) ahşabın ÖNÜNE çıkıyordu — ekranda sıra
  // "monitör, kişi, masa" oluyordu. Tepeden görünüşte doğru sıra "masa+monitör,
  // sonra oturan kişi"; çizimi tam boy yukarı kaydırmak bunu veriyor.
  return { x: cell.x * cellSize - size.w / 2, y: cell.y * cellSize - size.h };
}

interface TileSet {
  desk: Texture;
  plant: Texture;
  rack: Texture;
  coffee: Texture;
  wall: Texture;
  corridor: Texture;
  wood: Texture;
  bookshelf: Texture;
  watercooler: Texture;
  cabinet: Texture;
  whiteboard: Texture;
  rug: Texture;
  sofa: Texture;
  /** oda vurgu rengi → zemin karosu (oda başına bir kez pişirilir) */
  floors: Map<string, Texture>;
}

function paintProps(
  g: Graphics,
  layer: Container,
  plan: Floorplan,
  cell: number,
  tiles: TileSet,
): void {
  const place = (texture: Texture, x: number, y: number) => {
    const sprite = new Sprite(texture);
    sprite.position.set(x, y);
    layer.addChild(sprite);
  };
  for (const prop of plan.props) {
    const x = prop.x * cell;
    const y = prop.y * cell;
    if (prop.kind === "rack") {
      place(tiles.rack, x, y);
    } else if (prop.kind === "plant") {
      place(tiles.plant, x, y);
    } else if (prop.kind === "coffee") {
      place(tiles.coffee, x, y);
    } else if (prop.kind === "bookshelf") {
      place(tiles.bookshelf, x, y);
    } else if (prop.kind === "watercooler") {
      place(tiles.watercooler, x, y);
    } else if (prop.kind === "cabinet") {
      place(tiles.cabinet, x, y);
    } else if (prop.kind === "whiteboard") {
      place(tiles.whiteboard, x, y);
    } else if (prop.kind === "rug") {
      place(tiles.rug, x, y);
    } else if (prop.kind === "sofa") {
      place(tiles.sofa, x, y);
    } else if (prop.kind === "meeting_table") {
      const w = 5 * cell;
      const h = 2 * cell;
      g.roundRect(x - w / 2, y - h / 2, w, h, 6)
        .fill(0x4a3a2a)
        .stroke({ color: 0x5c4834, width: 2 });
      for (const dx of [-1.6, 0, 1.6]) {
        g.rect(x + dx * cell - 0.3 * cell, y - h / 2 - 0.75 * cell, 0.6 * cell, 0.55 * cell).fill(
          0x2b3440,
        );
        g.rect(x + dx * cell - 0.3 * cell, y + h / 2 + 0.2 * cell, 0.6 * cell, 0.55 * cell).fill(
          0x2b3440,
        );
      }
    } else {
      // reception
      g.rect(x, y, 5 * cell, 1.1 * cell).fill(0x3a3550);
      g.rect(x, y, 5 * cell, 0.2 * cell).fill(0x4a4568);
    }
  }
}

function paintFloorplan(layer: Container, plan: Floorplan, cell: number, tiles: TileSet): void {
  layer.removeChildren();
  const g = new Graphics();

  // Zeminler ve duvarlar DÖŞEME (TilingSprite): tek dokunun tekrarı, tek
  // draw call, ve büyütünce piksel yapısı korunuyor. Eskiden düz dolgu +
  // dama tahtasıydı; ölçeklenince "piksel sanatı" değil "renkli dikdörtgen"
  // gibi duruyordu.
  const tile = (texture: Texture, x: number, y: number, w: number, h: number) => {
    const sprite = new TilingSprite({ texture, width: w, height: h });
    sprite.position.set(x, y);
    layer.addChild(sprite);
    return sprite;
  };

  // corridor/lobby ground fills the whole envelope; rooms paint over it
  tile(
    tiles.corridor,
    plan.bounds.x * cell,
    plan.bounds.y * cell,
    plan.bounds.w * cell,
    plan.bounds.h * cell,
  );

  // room floors: departman vurgusundan pişirilmiş karo
  for (const room of plan.rooms) {
    const floor = tiles.floors.get(room.accent);
    const { x, y, w, h } = room.rect;
    if (floor) tile(floor, x * cell, y * cell, w * cell, h * cell);
  }

  // meeting floor — ahşap tahta (AGENTDESK'in kahverengi orta odası)
  if (plan.meeting) {
    const { x, y, w, h } = plan.meeting.rect;
    tile(tiles.wood, x * cell, y * cell, w * cell, h * cell);
  }

  layer.addChild(g);

  // walls (door gaps pre-cut) — döşenmiş duvar yüzü
  for (const wall of plan.walls) {
    tile(tiles.wall, wall.x * cell, wall.y * cell, wall.w * cell, wall.h * cell);
  }

  // desks: pişirilmiş piksel masa (monitör tonu dinamik — monitor layer)
  for (const room of plan.rooms) {
    for (const desk of room.desks) {
      const sprite = new Sprite(tiles.desk);
      const origin = deskOrigin(desk.cell, cell);
      sprite.position.set(origin.x, origin.y);
      layer.addChild(sprite);
    }
  }

  // entrance: dark threshold + welcome mat
  g.rect(plan.entrance.x * cell, plan.entrance.y * cell, plan.entrance.w * cell, WALL * cell).fill(
    0x0c1016,
  );
  g.rect(
    plan.entrance.x * cell,
    (plan.entrance.y - 0.5) * cell,
    plan.entrance.w * cell,
    0.4 * cell,
  ).fill(0x2f3a2a);

  paintProps(g, layer, plan, cell, tiles);

  // Salon tabelaları: ODANIN ÜST DUVARINA asılır.
  //
  // Eskiden zeminin üstüne, ilk masa sırasının hizasına yazılıyordu ve
  // masalar tabelanın üstüne binip yazıyı okunmaz hâle getiriyordu
  // (ekran görüntüsünde "ENGINEERING" yazısının yarısı masaların altındaydı).
  for (const room of plan.rooms) {
    const plate = new Graphics();
    const text = room.label.toUpperCase();
    const width = Math.min(room.rect.w * cell - 8, text.length * 7.4 + 12);
    plate
      .roundRect((room.rect.x + 0.4) * cell, (room.rect.y + 0.15) * cell, width, 18, 3)
      .fill({ color: 0x0c1016, alpha: 0.85 })
      .stroke({ color: hexInt(room.accent), width: 1, alpha: 0.55 });
    layer.addChild(plate);

    const label = new Text({
      text,
      style: { fill: room.accent, fontSize: 11, fontFamily: "monospace", fontWeight: "bold" },
    });
    label.position.set((room.rect.x + 0.4) * cell + 6, (room.rect.y + 0.15) * cell + 3);
    layer.addChild(label);
  }
  if (plan.meeting) {
    const label = new Text({
      text: plan.meeting.label.toUpperCase(),
      style: { fill: 0x8fa3c8, fontSize: 12, fontFamily: "monospace" },
    });
    label.alpha = 0.7;
    label.position.set((plan.meeting.rect.x + 0.8) * cell, (plan.meeting.rect.y + 0.6) * cell);
    layer.addChild(label);
  }
  const lobby = new Text({
    text: "LOBİ",
    style: { fill: 0x39424f, fontSize: 11, fontFamily: "monospace", fontWeight: "bold" },
  });
  lobby.alpha = 0.55;
  lobby.position.set((plan.entrance.x - 6.6) * cell, (plan.entrance.y - 3.2) * cell);
  layer.addChild(lobby);
}

export function OfficeCanvas({
  onSelectAgent,
  avatarUrls,
  focusAgentIds,
  executiveAgentId,
}: {
  onSelectAgent?: (agentId: string) => void;
  /** agentId → agents.avatar_url (persistent identity → same character, U15) */
  avatarUrls?: ReadonlyMap<string, string | null>;
  /** P1-A team filter: when set, avatars OUTSIDE the set render dimmed */
  focusAgentIds?: ReadonlySet<string> | null;
  /** Şirketin tepe yöneticisi — sahnede altın halkayla işaretlenir. */
  executiveAgentId?: string | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engine = useOfficeStore((s) => s.engine);
  const snapshotCount = useOfficeStore((s) => s.snapshotCount);
  const [fallback, setFallback] = useState(false);
  const snapshotCountRef = useRef(snapshotCount);
  snapshotCountRef.current = snapshotCount;
  const avatarUrlsRef = useRef(avatarUrls);
  avatarUrlsRef.current = avatarUrls;
  const focusAgentIdsRef = useRef(focusAgentIds);
  focusAgentIdsRef.current = focusAgentIds;
  /**
   * CEO işareti: sahne bir kez kurulur, prop SONRADAN gelir (sorgu asenkron).
   *
   * Ref'i güncellemek yetmiyor: avatar geçişi yalnız `engine.version`
   * değiştiğinde koşuyor, CEO cevabı ise son motor güncellemesinden sonra
   * düşüyor — halka hiç çizilmiyordu (ilk sürümde tam olarak bu oldu, kod
   * doğruydu ama hiç çağrılmıyordu). Bu yüzden prop değişimi ayrı bir "kirli"
   * bayrağı kaldırır ve ticker bir sonraki karede avatar geçişini zorlar.
   */
  const executiveIdRef = useRef(executiveAgentId);
  const executiveDirtyRef = useRef(false);
  if (executiveIdRef.current !== executiveAgentId) {
    executiveIdRef.current = executiveAgentId;
    executiveDirtyRef.current = true;
  }
  /**
   * T26: tıklama geri çağrısı REF'te tutulur, bağımlılıkta DEĞİL.
   * Çağıranlar satır içi ok fonksiyonu veriyor (OfficePanel), yani her
   * yeniden render'da kimliği değişiyordu; bağımlılıkta olduğu için proje
   * değişiminin/sihirbazın her açılışının ardından TÜM Pixi uygulaması
   * yıkılıp yeniden kuruluyordu. Sahne artık yalnız motor/yedek değişince
   * kurulur; tıklama her zaman en güncel geri çağrıyı çağırır.
   */
  const onSelectAgentRef = useRef(onSelectAgent);
  onSelectAgentRef.current = onSelectAgent;
  const selectedAgentId = useFocus((s) => s.selectedAgentId);
  const selectedRef = useRef(selectedAgentId);
  selectedRef.current = selectedAgentId;

  useEffect(() => {
    installDebugHook(engine, () => snapshotCountRef.current);
  }, [engine]);

  useEffect(() => {
    if (fallback || !hostRef.current) return;
    const host = hostRef.current;
    const app = new Application();
    let destroyed = false;
    let hostObserver: ResizeObserver | null = null;
    let renderedLayoutVersion = -1;
    let renderedEngineVersion = -1;
    let plan: Floorplan | null = null;
    interface AvatarNode {
      root: Container;
      sprite: AnimatedSprite | null;
      body: Graphics | null;
      badge: Graphics;
      label: Text;
      lastX: number;
      lastY: number;
      dir: WalkDir;
      anim: string;
    }
    const avatarNodes = new Map<string, AvatarNode>();

    (async () => {
      try {
        await app.init({ background: BG, resizeTo: host, antialias: true });
      } catch {
        if (!destroyed) setFallback(true); // §15 degraded mode: canvas → list
        return;
      }
      if (destroyed) {
        app.destroy(true);
        return;
      }
      host.appendChild(app.canvas);

      // U15: baked character atlas (single page — one draw batch). Failure
      // falls back to the pre-U15 circles; motion semantics are identical.
      let sheet: Spritesheet | null = null;
      const avatarLib = new Map<string, AvatarEntry>();
      try {
        const [loadedSheet, avatarList] = await Promise.all([
          Assets.load<Spritesheet>(`${SPRITE_BASE}/characters.json`),
          loadAvatars(),
        ]);
        sheet = loadedSheet;
        for (const entry of avatarList) avatarLib.set(entry.avatarId, entry);
      } catch {
        sheet = null;
      }
      // T26: yükleme UÇUŞTAYKEN efekt temizlenmiş olabilir (proje değişimi,
      // sihirbaz, panel yeniden render'ı). O durumda app.destroy() çalışmış ve
      // app.stage NULL'dur — aşağıdaki addChild "Cannot read properties of
      // null" ile patlıyordu. Yükleme sonrası bayrağı yeniden okuyoruz.
      if (destroyed) {
        app.destroy(true);
        return;
      }
      const camera = new Container();
      const zoneLayer = new Container();
      // masa isim plakaları (AGENTDESK dili) — zemin üstü, avatar altı
      const plateLayer = new Container();
      const monitorLayer = new Graphics();
      const avatarLayer = new Container();
      avatarLayer.sortableChildren = true; // y-sort so lower avatars draw in front
      const effectLayer = new Container();
      camera.addChild(zoneLayer, plateLayer, monitorLayer, avatarLayer, effectLayer);
      app.stage.addChild(camera);

      const CELL = 32;

      // Piksel döşemeleri ÖMÜRDE BİR KEZ pişirilir; her plan değişiminde
      // yeniden üretilseydi büyük org'da her yeniden yerleşimde görünür bir
      // takılma olurdu.
      const tiles: TileSet = {
        desk: bakeArt(app, DESK_ART, PIXEL),
        plant: bakeArt(app, PLANT_ART, PIXEL),
        rack: bakeArt(app, RACK_ART, PIXEL),
        coffee: bakeArt(app, COFFEE_ART, PIXEL),
        wall: bakeArt(app, wallFaceArt(), PIXEL),
        corridor: bakeArt(app, corridorTileArt(), PIXEL),
        wood: bakeArt(app, woodPlankArt(), PIXEL),
        bookshelf: bakeArt(app, BOOKSHELF_ART, PIXEL),
        watercooler: bakeArt(app, WATERCOOLER_ART, PIXEL),
        cabinet: bakeArt(app, CABINET_ART, PIXEL),
        whiteboard: bakeArt(app, WHITEBOARD_ART, PIXEL),
        rug: bakeArt(app, RUG_ART, PIXEL),
        sofa: bakeArt(app, SOFA_ART, PIXEL),
        floors: new Map<string, Texture>(),
      };

      // 2026-08-18 (Founder kararı): pan/zoom TAMAMEN kalktı — ofis her
      // zaman panele CONTAIN-fit sığar ve panel boyutu değişince kendini
      // yeniden ölçekler. Kamerayı süren tek şey bu fonksiyondur.
      function fitCamera(): void {
        if (!plan) return;
        const sw = app.screen.width;
        const sh = app.screen.height;
        const pw = plan.bounds.w * CELL;
        const ph = plan.bounds.h * CELL;
        if (pw <= 0 || ph <= 0 || sw <= 0 || sh <= 0) return;
        const scale = Math.min(Math.min(sw / pw, sh / ph), 2.5);
        camera.scale.set(scale);
        camera.position.set(
          (sw - pw * scale) / 2 - plan.bounds.x * CELL * scale,
          (sh - ph * scale) / 2 - plan.bounds.y * CELL * scale,
        );
      }
      app.renderer.on("resize", fitCamera);

      // Panel duyarlılığı (2026-08-18, Founder geri bildirimi: "ekran
      // büyüdüğünde ofis stabil kalıyor"): Pixi'nin resizeTo'su yalnız
      // window resize dinler; dockview paneli PENCERE değişmeden büyür.
      // ResizeObserver panelin gerçek boyutunu app.resize'a taşır — fitCamera
      // renderer'ın resize olayından zaten tetiklenir.
      hostObserver = new ResizeObserver(() => {
        if (!destroyed) app.resize();
      });
      hostObserver.observe(host);


      let lastLabelsVisible: boolean | null = null;
      let lastPlateSig = "";
      app.ticker.add((ticker) => {
        engine.tick(ticker.deltaMS / 1000);
        // P2: zoom-thresholded name labels — react to wheel zoom immediately.
        // Eşik 0.85 → 1.25 (2026-08-18): adlar artık masa plakalarında kalıcı;
        // avatar üstü etiket yalnız yakın kadraja iner (çifte yazı önlenir).
        const labelsVisible = camera.scale.x >= 1.25;
        if (labelsVisible !== lastLabelsVisible) {
          lastLabelsVisible = labelsVisible;
          for (const [id, node] of avatarNodes) {
            node.label.visible = labelsVisible || id === selectedRef.current;
          }
        }
        if (engine.layout && engine.layoutVersion !== renderedLayoutVersion) {
          renderedLayoutVersion = engine.layoutVersion;
          plan = computeFloorplan(engine.layout);
          // zemin karoları oda vurgularından pişirilir — plan değişince
          // yeni vurgular gelebilir, önbelleğe eklenir (aynı renk bir kez)
          for (const room of plan.rooms) {
            if (!tiles.floors.has(room.accent)) {
              tiles.floors.set(
                room.accent,
                bakeArt(app, floorTileArt(hexInt(roomBase(room.accent)), 11), PIXEL),
              );
            }
          }
          paintFloorplan(zoneLayer, plan, CELL, tiles);
          fitCamera();
        }
        // masa plakaları: yerleşim ya da kadro değişince yeniden kurulur
        const plateSig = `${renderedLayoutVersion}:${engine.avatars.size}`;
        if (plan && plateSig !== lastPlateSig) {
          lastPlateSig = plateSig;
          const names = new Map<string, string>();
          for (const [id, a] of engine.avatars) names.set(id, a.name);
          paintNamePlates(plateLayer, plan, CELL, names);
        }
        // CEO işareti geldi/değişti → avatar geçişini bir kez zorla, yoksa
        // motor durgunken (bütün ajanlar IDLE) halka hiç çizilmez
        if (executiveDirtyRef.current) {
          executiveDirtyRef.current = false;
          renderedEngineVersion = -1;
        }
        if (engine.version === renderedEngineVersion) return;
        renderedEngineVersion = engine.version;

        // desk monitors tinted by the seated agent's live status
        monitorLayer.clear();
        if (plan) {
          for (const room of plan.rooms) {
            for (const desk of room.desks) {
              if (!desk.agentId) continue;
              const avatar = engine.avatars.get(desk.agentId);
              const color = avatar ? (BADGE_COLOR[avatar.badge] ?? 0x233040) : 0x233040;
              // Ekran dikdörtgeni masa ÇİZİMİNDEN türetilir, elle girilen
              // sayılardan değil: DESK_ART'ta ekran 10..21. sütun ve 3..6.
              // satırda. Sabit ofsetler çizim değişince sessizce kayıyordu.
              const origin = deskOrigin(desk.cell, CELL);
              monitorLayer
                .rect(origin.x + 10 * PIXEL, origin.y + 3 * PIXEL, 12 * PIXEL, 4 * PIXEL)
                .fill({ color, alpha: avatar ? 0.85 : 0.3 });
            }
          }
        }

        // avatars: create/update/remove Pixi nodes from engine state.
        // PixelLab-style sprites (U15): 4-direction walk while a projector
        // walk plays, idle frame at rest — facing derives from the SAME
        // interpolated positions the engine computes (no new motion source).
        for (const [agentId, avatar] of engine.avatars) {
          let node = avatarNodes.get(agentId);
          if (!node) {
            const root = new Container();
            let sprite: AnimatedSprite | null = null;
            let body: Graphics | null = null;
            if (sheet) {
              sprite = new AnimatedSprite([Texture.EMPTY]);
              sprite.anchor.set(0.5, 0.85);
              sprite.animationSpeed = 0.16;
              root.addChild(sprite);
            } else {
              body = new Graphics();
              root.addChild(body);
            }
            const badge = new Graphics();
            const label = new Text({
              text: avatar.name,
              // koyu kontur: aydınlık zeminde (sanat turu) beyaz yazı konturssuz okunmuyor
              style: {
                fill: 0xffffff,
                fontSize: 12,
                fontFamily: "sans-serif",
                stroke: { color: 0x131820, width: 3 },
              },
            });
            label.anchor.set(0.5, 0);
            label.position.set(0, 8);
            root.addChild(badge, label);
            root.eventMode = "static";
            root.cursor = "pointer";
            root.on("pointertap", () => onSelectAgentRef.current?.(agentId));
            avatarLayer.addChild(root);
            node = {
              root,
              sprite,
              body,
              badge,
              label,
              lastX: avatar.pos.x,
              lastY: avatar.pos.y,
              dir: "down",
              anim: "",
            };
            avatarNodes.set(agentId, node);
          }

          const dx = avatar.pos.x - node.lastX;
          const dy = avatar.pos.y - node.lastY;
          const moving = Math.abs(dx) + Math.abs(dy) > 0.002;
          if (moving) {
            node.dir =
              Math.abs(dx) >= Math.abs(dy)
                ? dx > 0
                  ? "right"
                  : "left"
                : dy > 0
                  ? "down"
                  : "up";
          }
          node.lastX = avatar.pos.x;
          node.lastY = avatar.pos.y;

          const badgeColor = BADGE_COLOR[avatar.badge] ?? 0x5c6773;
          if (node.sprite && sheet) {
            const avatarId = resolveAvatarId(agentId, avatarUrlsRef.current?.get(agentId) ?? null);
            const animKey = `${avatarId}:${moving ? "walk" : "idle"}:${node.dir}`;
            if (node.anim !== animKey) {
              node.anim = animKey;
              const entry = avatarLib.get(avatarId);
              if (entry) {
                if (moving) {
                  node.sprite.textures = entry.walk[node.dir].map(
                    (name) => sheet!.textures[name] ?? Texture.EMPTY,
                  );
                  node.sprite.play();
                } else {
                  node.sprite.textures = [sheet.textures[entry.idle[node.dir]] ?? Texture.EMPTY];
                  node.sprite.gotoAndStop(0);
                }
                // frame boyutundan bağımsız yerleşim: hedef ayak izi ~32×40
                // (16×20 prosedürel → 2×; 64×64 PixelLab → 0.55× gibi)
                const frame = node.sprite.textures[0];
                if (frame && frame !== Texture.EMPTY && frame.height > 0) {
                  const s = Math.min(32 / frame.width, 40 / frame.height);
                  node.sprite.scale.set(s);
                }
              }
            }
            // presence badge above the head (36 §7)
            node.badge
              .clear()
              .circle(0, -40, 3.5)
              .fill(badgeColor)
              .stroke({ color: 0x0b0e13, width: 1 });
            // CEO işareti: ayaklarının altında altın bir halka.
            //
            // Founder ofiste CEO'yu bulamıyordu (2026-08-17) — kim olduğu
            // ancak avatara tıklayıp kartı okuyunca anlaşılıyordu. Halka
            // sunucudan gelen `topExecutive` cevabına dayanır, isimden ya da
            // unvan metninden TAHMİN EDİLMEZ.
            //
            // Halka İLK sürümde tek ince çizgiydi ve yakın karede bile
            // komşularından zor ayırt ediliyordu — "belirgin olsun" isteğini
            // karşılamıyordu. Şimdi kalın halka + baş üstünde altın taç
            // işareti: ikisi birlikte hem uzaktan hem yakından okunuyor.
            if (agentId === executiveIdRef.current) {
              // y=6, y=13 değil: 13'te halka isim etiketinin üstüne biniyor ve
              // adı okunmaz hâle getiriyordu (ekran görüntüsünde yakalandı).
              node.badge
                .ellipse(0, 6, 14, 5.5)
                .fill({ color: 0xffcb47, alpha: 0.16 })
                .stroke({ color: 0xffcb47, width: 3, alpha: 1 })
                .ellipse(0, 6, 19, 8)
                .stroke({ color: 0xffcb47, width: 1.5, alpha: 0.5 })
                // taç: baş üstünde üç uçlu küçük bir işaret
                .poly([-6, -46, -3, -52, 0, -46, 3, -52, 6, -46])
                .fill({ color: 0xffcb47 })
                .stroke({ color: 0x0b0e13, width: 1 });
            }
          } else if (node.body) {
            node.body
              .clear()
              .ellipse(0, 12, 8, 3)
              .fill({ color: 0x000000, alpha: 0.3 })
              .circle(0, 0, 10)
              .fill({ color: badgeColor })
              .stroke({ color: 0x0b0e13, width: 2 });
            node.label.position.set(0, 14);
          }
          // Masa aralığı 3 hücre (96px) ama tam ad çoğu zaman daha geniş ve
          // komşu masalardaki adlar üst üste biniyordu ("Emre ŞahinBaran
          // Çelik"). Ofis planında kim nerede oturuyor sorusuna ilk ad zaten
          // cevap veriyor; tam ad tıklanınca açılan ajan kartında duruyor.
          node.label.text = shortName(avatar.name);
          node.label.visible = camera.scale.x >= 1.25 || agentId === selectedRef.current;
          node.root.position.set(avatar.pos.x * CELL, avatar.pos.y * CELL);
          node.root.zIndex = avatar.pos.y;
          const focusSet = focusAgentIdsRef.current;
          node.root.alpha = focusSet && !focusSet.has(agentId) ? 0.22 : 1;
        }
        for (const [agentId, node] of avatarNodes) {
          if (!engine.avatars.has(agentId)) {
            node.root.destroy();
            avatarNodes.delete(agentId);
          }
        }

        // interaction bubbles
        effectLayer.removeChildren();
        for (const interaction of engine.interactions.values()) {
          const bubble = new Graphics();
          const color = interaction.kind === "escalation" ? 0xff4d4d : 0x3fd0a0;
          bubble
            .circle(interaction.atCell.x * CELL, interaction.atCell.y * CELL - 18, 6)
            .fill({ color });
          effectLayer.addChild(bubble);
        }
      });
    })();

    return () => {
      destroyed = true;
      hostObserver?.disconnect();
      try {
        app.destroy(true, { children: true });
      } catch {
        /* not initialized */
      }
      host.replaceChildren();
    };
  }, [engine, fallback]);

  if (fallback) {
    // degraded mode (23 §15): same store, list rendering
    return <FallbackList onSelectAgent={onSelectAgent} />;
  }
  // height is the caller's: the route view pins 540px, panels give h-full.
  // Pan/zoom yok (2026-08-18): ofis panele her zaman contain-fit sığar.
  return <div ref={hostRef} data-testid="office-canvas" className="h-full w-full rounded-lg" />;
}

function FallbackList({
  onSelectAgent,
}: {
  onSelectAgent?: ((agentId: string) => void) | undefined;
}) {
  const engine = useOfficeStore((s) => s.engine);
  const snapshotCount = useOfficeStore((s) => s.snapshotCount);
  void snapshotCount; // re-render on snapshots
  return (
    <ul data-testid="office-fallback" className="space-y-1 text-sm">
      {[...engine.avatars.values()].map((a) => (
        <li key={a.agentId}>
          <button onClick={() => onSelectAgent?.(a.agentId)} className="underline">
            {a.name}
          </button>{" "}
          — {a.badge} @ ({Math.round(a.pos.x)},{Math.round(a.pos.y)})
        </li>
      ))}
    </ul>
  );
}
