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
  type Spritesheet,
} from "pixi.js";
import { useOfficeStore } from "../../stores/office.js";
import { useFocus } from "../../stores/focus.js";
import type { OfficeSceneEngine } from "./sceneState.js";
import { officeMap, type OfficeMap } from "./tiled/tiledMap.js";
import type { FloorProjector } from "./tiled/project.js";
import { tileArt, type TileArtSpec } from "./tiled/tileset.js";
import { themeForProject, type OfficeTheme } from "./tiled/theme.js";
import type { SeatedFloor } from "./tiled/seatPool.js";
import {
  typingOffset,
  visualStateFor,
  type Bubble,
  type VisualInput,
  type VisualState,
} from "./tiled/visualState.js";
import { emitArt, type PixelArt } from "./tiles.js";
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

/**
 * FAZ 2B / 2B-3 — baş üstü balonu. İÇERİĞİ UYDURMUYORUZ: yalnız durumun
 * şeklini çiziyoruz (düşünce/konuşma/inceleme/uyarı). Metin, ancak sunucu
 * gerçek bir metin gönderirse yazılabilir — şu an göndermiyor.
 */
function paintBubble(g: Graphics, kind: Bubble, x: number, y: number): void {
  if (kind === "none") return;
  const color =
    kind === "alert" ? 0xff6b6b : kind === "review" ? 0xffcb47 : kind === "thought" ? 0xa879ff : 0x3fd0a0;
  if (kind === "thought") {
    g.circle(x, y, 7).fill({ color: 0x151a22 }).stroke({ color, width: 1.5 });
    g.circle(x - 3, y - 1, 1.4).fill({ color });
    g.circle(x, y - 1, 1.4).fill({ color });
    g.circle(x + 3, y - 1, 1.4).fill({ color });
    g.circle(x - 6, y + 8, 2).fill({ color: 0x151a22 }).stroke({ color, width: 1 });
    return;
  }
  if (kind === "alert") {
    g.poly([x, y - 8, x + 8, y + 6, x - 8, y + 6])
      .fill({ color: 0x151a22 })
      .stroke({ color, width: 1.5 });
    g.rect(x - 0.8, y - 4, 1.6, 6).fill({ color });
    g.rect(x - 0.8, y + 3, 1.6, 1.6).fill({ color });
    return;
  }
  // speech / review: köşeli balon + kuyruk
  g.roundRect(x - 9, y - 7, 18, 13, 3).fill({ color: 0x151a22 }).stroke({ color, width: 1.5 });
  g.poly([x - 3, y + 6, x + 1, y + 6, x - 1, y + 10]).fill({ color: 0x151a22 });
  if (kind === "review") {
    g.circle(x - 1, y - 1, 3).stroke({ color, width: 1.4 });
    g.rect(x + 1.5, y + 1.5, 4, 1.2).fill({ color });
  } else {
    g.rect(x - 5, y - 3, 10, 1.4).fill({ color });
    g.rect(x - 5, y, 7, 1.4).fill({ color });
  }
}

declare global {
  interface Window {
    __acosOffice?: {
      readonly lastAppliedEventId: string | null;
      readonly agentCount: number;
      readonly interactionCount: number;
      readonly snapshotCount: number;
      /** FAZ 2B: KATTA oturan ajan sayısı (proje filtresi bunu düşürür) */
      readonly floorSeats: number;
      /** kat bir projeye filtreli mi */
      readonly floorFiltered: boolean;
      readonly debugRing: unknown[];
    };
  }
}

function installDebugHook(
  engine: OfficeSceneEngine,
  getSnapshotCount: () => number,
  getProjector: () => FloorProjector,
): void {
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
    get floorSeats() {
      return getProjector().floor.seats.size;
    },
    get floorFiltered() {
      return getProjector().filtered;
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
interface TileSet {
  /** döşeme anahtarı → pişirilmiş doku (tiles.ts sanatından) */
  art: Map<string, Texture>;
}

/**
 * FAZ 2B / 2B-2 — SABİT KATI çizer (Tiled haritası).
 *
 * Eskiden zemin sunucu yerleşiminden TÜRETİLİYORDU (computeFloorplan). Artık
 * kat elle çizilmiş bir .tmj: Munder'ın kompozisyonu (CEO odası, toplantı
 * odası, kafeterya, isimli masalar), pikselleri bizim. Harita saf veriden
 * gelen "çizim kalemleri" listesidir; burada yalnız sprite'a dökülür.
 */
function paintTiledFloor(
  layer: Container,
  map: OfficeMap,
  floor: SeatedFloor,
  cell: number,
  tiles: TileSet,
  spec: Record<string, TileArtSpec>,
): void {
  layer.removeChildren();
  const place = (key: string, cx: number, cy: number, terrain: boolean) => {
    const texture = tiles.art.get(key);
    if (!texture) return;
    const sprite = new Sprite(texture);
    if (terrain) sprite.position.set(cx * cell, cy * cell);
    else {
      // mobilya sanatı hücreden büyük: çapa hücresinin üstüne oturt
      sprite.position.set(
        cx * cell + cell / 2 - texture.width / 2,
        cy * cell + cell - texture.height,
      );
    }
    layer.addChild(sprite);
  };

  const grown = floor.usedHeight > map.height;
  const openRow = map.height - 1; // büyüme varken alt duvar açılır (geçiş)

  for (const item of map.draw) {
    // Kat büyüdüyse binanın ALT DUVARI kapı gibi açılır ve yeni bölüm oraya
    // eklenir. Duvarı olduğu gibi bıraktığımızda yeni masalar binanın
    // DIŞINDA, boşlukta duruyor gibi görünüyordu (ekran görüntüsünde
    // yakalandı) — "kat büyüdü" değil "kat bozuldu" okunuyordu.
    if (
      grown &&
      item.layer === "walls" &&
      item.cy === openRow &&
      item.cx > 0 &&
      item.cx < map.width - 1
    ) {
      place("floor-open", item.cx, item.cy, true);
      continue;
    }
    place(item.key, item.cx, item.cy, spec[item.key]?.terrain ?? false);
  }

  if (!grown) return;

  // --- BÜYÜYEN BÖLÜM: zemin + yan duvarlar + alt duvar + yeni masalar ---
  const bottom = floor.usedHeight;
  for (let y = map.height; y < bottom; y += 1) {
    for (let x = 0; x < map.width; x += 1) {
      const edge = x === 0 || x === map.width - 1 || y === bottom - 1;
      place(edge ? "wall" : "floor-open", x, y, true);
    }
  }
  for (const desk of floor.extraDesks) place("desk", desk.deskCell.x, desk.deskCell.y, false);
}

/** Masa isim plakaları — koltuk sahibinin adı masasının önünde. */
function paintSeatPlates(
  layer: Container,
  floor: SeatedFloor,
  cell: number,
  names: ReadonlyMap<string, string>,
): void {
  layer.removeChildren();
  for (const seat of floor.seats.values()) {
    const name = names.get(seat.agentId);
    if (!name) continue;
    const label = new Text({
      text: shortName(name).toUpperCase(),
      style: {
        fill: 0x9aa7b4,
        fontSize: 9,
        fontFamily: "monospace",
        letterSpacing: 0.5,
      },
    });
    label.anchor.set(0.5, 0);
    label.position.set(seat.cell.x * cell + cell / 2, (seat.cell.y - 1) * cell - 4);
    layer.addChild(label);
  }
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
  const projector = useOfficeStore((s) => s.projector);
  const projectorRef = useRef(projector);
  projectorRef.current = projector;
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
  // FAZ 2B/2B-4: kat teması seçili projeye göre (aynı düzen, kendi tonu).
  const selectedProjectId = useFocus((s) => s.selectedProjectId);
  const themeRef = useRef<OfficeTheme>(themeForProject(selectedProjectId));
  themeRef.current = themeForProject(selectedProjectId);
  const selectedAgentId = useFocus((s) => s.selectedAgentId);
  const selectedRef = useRef(selectedAgentId);
  selectedRef.current = selectedAgentId;

  useEffect(() => {
    installDebugHook(engine, () => snapshotCountRef.current, () => projectorRef.current);
  }, [engine]);

  useEffect(() => {
    if (fallback || !hostRef.current) return;
    const host = hostRef.current;
    const app = new Application();
    let destroyed = false;
    let hostObserver: ResizeObserver | null = null;
    let renderedEngineVersion = -1;
    let renderedFloorSig = "";
    const map: OfficeMap = officeMap();
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
      /** FAZ 2B/2B-3: baş üstü balonu ve oturma/yazma durumu */
      bubble: Graphics;
      visual: VisualState | null;
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
      // Tema başına döşeme seti TEMBEL pişirilir: proje değişince yeni ton
      // bir kez üretilir, sonra önbellekten gelir (her karede pişirmek büyük
      // katta görünür takılma demekti).
      const bakedThemes = new Map<string, { tiles: TileSet; spec: Record<string, TileArtSpec> }>();
      function themeTiles(theme: OfficeTheme): { tiles: TileSet; spec: Record<string, TileArtSpec> } {
        const cached = bakedThemes.get(theme.id);
        if (cached) return cached;
        const spec = tileArt(theme);
        const tiles: TileSet = { art: new Map<string, Texture>() };
        for (const [key, entry] of Object.entries(spec)) {
          tiles.art.set(key, bakeArt(app, entry.art, PIXEL));
        }
        const baked = { tiles, spec };
        bakedThemes.set(theme.id, baked);
        return baked;
      }
      let tiles: TileSet = themeTiles(themeRef.current).tiles;

      // 2026-08-18 (Founder kararı): pan/zoom TAMAMEN kalktı — ofis her
      // zaman panele CONTAIN-fit sığar ve panel boyutu değişince kendini
      // yeniden ölçekler. Kamerayı süren tek şey bu fonksiyondur.
      function fitCamera(): void {
        const sw = app.screen.width;
        const sh = app.screen.height;
        // kat BÜYÜYEBİLİR (fazla ajan → yeni masa adaları): yükseklik
        // yansıtıcının kullandığı satır sayısıdır, haritanınki değil.
        const pw = map.width * CELL;
        const ph = Math.max(map.height, projector.floor.usedHeight) * CELL;
        if (pw <= 0 || ph <= 0 || sw <= 0 || sh <= 0) return;
        const scale = Math.min(Math.min(sw / pw, sh / ph), 2.5);
        camera.scale.set(scale);
        camera.position.set((sw - pw * scale) / 2, (sh - ph * scale) / 2);
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
      // Yalnız faz sayacı: yazma ritmi gibi DURUMA BAĞLI görsellerin fazı.
      // Hareket üretmez — hangi avatarın "yazıyor" sayılacağını badge belirler.
      let elapsedSeconds = 0;
      let lastPhase = -1;
      app.ticker.add((ticker) => {
        engine.tick(ticker.deltaMS / 1000);
        elapsedSeconds += ticker.deltaMS / 1000;
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
        // Kat SABİT; yeniden çizilmesi yalnız KADRO değişince gerekir
        // (koltuk dağıtımı değişir, kat büyüyebilir).
        const floor = projector.floor;
        const theme = themeRef.current;
        const floorSig = `${theme.id}:${floor.seats.size}:${floor.usedHeight}:${[
          ...floor.seats.values(),
        ]
          .map((s) => `${s.agentId}@${s.seat}`)
          .join(",")}`;
        if (floorSig !== renderedFloorSig) {
          renderedFloorSig = floorSig;
          const baked = themeTiles(theme);
          tiles = baked.tiles;
          paintTiledFloor(zoneLayer, map, floor, CELL, tiles, baked.spec);
          const names = new Map<string, string>();
          for (const [id, a] of engine.avatars) names.set(id, a.name);
          paintSeatPlates(plateLayer, floor, CELL, names);
          fitCamera();
        }
        // CEO işareti geldi/değişti → avatar geçişini bir kez zorla, yoksa
        // motor durgunken (bütün ajanlar IDLE) halka hiç çizilmez
        if (executiveDirtyRef.current) {
          executiveDirtyRef.current = false;
          renderedEngineVersion = -1;
        }
        // Motor durgunken de bir şeyin canlı kalması gerekebilir: WORKING olan
        // ajanın klavye ritmi ve monitör titremesi. Bu ritim ajanın DURUMUNA
        // bağlı (badge), kendi kendine dolaşan bir animasyon değil — durum
        // IDLE'a dönünce ritim de biter.
        const phase = Math.floor(elapsedSeconds * 7);
        const typingLive = [...avatarNodes.values()].some(
          (n) => n.visual?.activity === "typing",
        );
        if (engine.version === renderedEngineVersion && !(typingLive && phase !== lastPhase)) {
          return;
        }
        lastPhase = phase;
        renderedEngineVersion = engine.version;

        // desk monitors tinted by the seated agent's live status
        monitorLayer.clear();
        for (const seat of projector.floor.seats.values()) {
          const avatar = engine.avatars.get(seat.agentId);
          const color = avatar ? (BADGE_COLOR[avatar.badge] ?? 0x233040) : 0x233040;
          // WORKING → ekran hafifçe titrer (yazma). Kaynağı badge.
          const typing = avatarNodes.get(seat.agentId)?.visual?.activity === "typing";
          const glow = typing ? (phase % 2 === 0 ? 1 : 0.7) : avatar ? 0.85 : 0.3;
          // Masa, koltuğun BİR ÜSTÜNDEKİ hücrede (harita üreteci böyle
          // yerleştiriyor). Ekran dikdörtgeni DESK_ART'taki ekranın yeri:
          // 10..21. sütun, 3..6. satır — sabit ofset yazmıyoruz.
          const deskX = seat.cell.x * CELL;
          const deskY = (seat.cell.y - 1) * CELL;
          const deskTexture = tiles.art.get("desk");
          const offsetX = deskTexture ? CELL / 2 - deskTexture.width / 2 : 0;
          const offsetY = deskTexture ? CELL - deskTexture.height : 0;
          monitorLayer
            .rect(
              deskX + offsetX + 10 * PIXEL,
              deskY + offsetY + 3 * PIXEL,
              12 * PIXEL,
              4 * PIXEL,
            )
            .fill({ color, alpha: glow });
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
            const bubble = new Graphics();
            root.addChild(badge, bubble, label);
            root.eventMode = "static";
            root.cursor = "pointer";
            root.on("pointertap", () => onSelectAgentRef.current?.(agentId));
            avatarLayer.addChild(root);
            node = {
              root,
              sprite,
              body,
              badge,
              bubble,
              label,
              visual: null,
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

          // FAZ 2B/2B-3: görsel durum TALİMAT verisinden türetilir
          // (badge + yürüyor mu + koltuğunda mı + içinde olduğu etkileşim).
          const seat = projector.seatCell(agentId);
          const atSeat =
            !!seat &&
            Math.abs(avatar.pos.x - seat.x) < 0.2 &&
            Math.abs(avatar.pos.y - seat.y) < 0.2;
          let interactionKind: VisualInput["interaction"] = null;
          for (const interaction of engine.interactions.values()) {
            if (interaction.agentIds.includes(agentId)) {
              interactionKind = interaction.kind as VisualInput["interaction"];
              break;
            }
          }
          const visual = visualStateFor({
            badge: avatar.badge,
            moving,
            atSeat,
            dir: node.dir,
            interaction: interactionKind ?? null,
          });
          node.visual = visual;

          const badgeColor = BADGE_COLOR[avatar.badge] ?? 0x5c6773;
          if (node.sprite && sheet) {
            const avatarId = resolveAvatarId(agentId, avatarUrlsRef.current?.get(agentId) ?? null);
            // oturuyorsa masaya DÖNÜK duruş karesi (sırtı bize dönük)
            const facing = visual.posture === "seated" ? visual.facing : node.dir;
            const animKey = `${avatarId}:${moving ? "walk" : "idle"}:${facing}`;
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
                  node.sprite.textures = [sheet.textures[entry.idle[facing]] ?? Texture.EMPTY];
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
          // Oturan avatar sandalyeye çöker (birkaç piksel yukarı) ve WORKING
          // ise klavyede omuz ritmi verir. İkisi de TALİMATTAN gelen duruma
          // bağlı: koltuk yansıtıcıdan, WORKING office.status.changed'den.
          const sit = node.visual?.posture === "seated" ? -3 : 0;
          const type = typingOffset(node.visual?.activity ?? "idle", elapsedSeconds);
          node.root.position.set(avatar.pos.x * CELL, avatar.pos.y * CELL + sit + type);
          node.root.zIndex = avatar.pos.y;

          node.bubble.clear();
          if (node.visual && node.visual.bubble !== "none") {
            paintBubble(node.bubble, node.visual.bubble, 0, -50);
          }

          // FAZ 2B/2B-4: PROJE KATI. Filtre varken katta olmayan ajan
          // GÖRÜNMEZ — soluk değil, hiç yok (kat o projenin katı). Filtre
          // yokken eski davranış: takım filtresi solukluk yapar.
          if (projector.filtered && !projector.onFloor(agentId)) {
            node.root.visible = false;
            continue;
          }
          node.root.visible = true;
          const focusSet = projector.filtered ? null : focusAgentIdsRef.current;
          const focusAlpha = focusSet && !focusSet.has(agentId) ? 0.22 : 1;
          node.root.alpha = node.visual?.dim ? focusAlpha * 0.45 : focusAlpha;
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
