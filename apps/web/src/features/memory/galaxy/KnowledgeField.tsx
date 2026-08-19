// KnowledgeField — sahneyi "havada duran toplar" olmaktan çıkarıp BİLGİ KÜRESİ
// yapan dekoratif katman. (Önceki sürüm yassı bir sarmal diskti; yatay bir
// gezegen gibi görünüyordu ve bilgi ağı öyle bir şey değil — her yöne bağlanır.)
//
// Üç parça:
//   1. küresel nokta bulutu — hacimde düzgün dağılım, yüzeye doğru yoğunlaşır
//   2. filamentler — bulut noktaları arasında küreyi kesen sönük teller
//   3. yuvarlak yıldız damgası — dokusuz nokta KARE çizilir, "piksel çöpü" olur
//
// DÜRÜSTLÜK NOTU (önemli): bu katmanın tamamı DEKORDUR.
//   - noktalar hiçbir anıyı temsil etmez, tıklanmaz, filtrelerden etkilenmez
//   - filamentler hiçbir `memory_relations` kaydını temsil ETMEZ; yalnız
//     dekoratif noktalar arasına çizilir, anı düğümlerine asla değmez
// Gerçek ilişkiler EdgeLines'ta, ilişki türünün rengiyle ve çok daha parlak
// çizilir (12 §8.2). Ayrım bilerek korunuyor: sönük teller "doku", parlak
// renkli çizgiler "veri".
//
// Maliyet: iki `Points` + bir `LineSegments` = üç draw call, tek seferlik
// hesap, kare başına sıfır iş. Sabit tohum — her yenilemede aynı alan.
import { useMemo } from "react";
import * as THREE from "three";
import { FIELD_RADIUS } from "./layout.js";

/** Küreyi dolduran toz. */
const CLOUD_COUNT = 30000;
/** Yüzeye yakın, daha parlak "kabuk" noktaları — kürenin sınırını çizer. */
const SHELL_COUNT = 12000;
/** Filament uçlarının seçileceği düğüm sayısı. */
const HUB_COUNT = 420;
/** Her hub'ın bağlanacağı en yakın komşu sayısı. */
const NEIGHBOURS = 5;
/** Küreyi baştan başa kesen uzun tellerin oranı. */
const LONG_LINK_RATIO = 0.12;

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/** Küre üzerinde düzgün dağılmış bir yön. */
function direction(random: () => number): THREE.Vector3 {
  const cosPhi = random() * 2 - 1;
  const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
  const theta = random() * Math.PI * 2;
  return new THREE.Vector3(sinPhi * Math.cos(theta), cosPhi, sinPhi * Math.sin(theta));
}

export function KnowledgeField() {
  const star = useMemo(() => buildStarTexture(), []);
  const cloud = useMemo(() => buildCloud(), []);
  const shell = useMemo(() => buildShell(), []);
  const filaments = useMemo(() => buildFilaments(), []);

  return (
    <group>
      {/* additive + depthWrite kapalı: üst üste binen noktalar birikerek
          parlar (gerçek nebula davranışı) ve anıların önünü kesmez */}
      <points geometry={cloud} raycast={() => null} frustumCulled={false} renderOrder={-2}>
        <pointsMaterial
          map={star}
          size={0.26}
          sizeAttenuation
          vertexColors
          transparent
          opacity={0.8}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>
      <points geometry={shell} raycast={() => null} frustumCulled={false} renderOrder={-2}>
        <pointsMaterial
          map={star}
          size={0.32}
          sizeAttenuation
          vertexColors
          transparent
          opacity={0.9}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </points>
      <lineSegments geometry={filaments} raycast={() => null} frustumCulled={false} renderOrder={-3}>
        <lineBasicMaterial
          vertexColors
          transparent
          opacity={0.12} // sönük: veri çizgileriyle karışmamalı
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
        />
      </lineSegments>
    </group>
  );
}

function buildCloud(): THREE.BufferGeometry {
  const random = makeRandom(0x5eed10a);
  const positions = new Float32Array(CLOUD_COUNT * 3);
  const colors = new Float32Array(CLOUD_COUNT * 3);

  const INNER = new THREE.Color("#e2ecff");
  const MID = new THREE.Color("#8f6fe0");
  const OUTER = new THREE.Color("#2f8f8c");
  const color = new THREE.Color();

  for (let i = 0; i < CLOUD_COUNT; i += 1) {
    const dir = direction(random);
    // r ∝ u^(1/3) → HACİMDE düzgün dağılım. Düz u kullanmak merkezi
    // tıkabasa doldurur, küre "top" değil "yumak" görünürdü.
    const radius = FIELD_RADIUS * Math.cbrt(random());
    positions[i * 3] = dir.x * radius;
    positions[i * 3 + 1] = dir.y * radius;
    positions[i * 3 + 2] = dir.z * radius;

    const k = radius / FIELD_RADIUS;
    if (k < 0.4) color.copy(INNER).lerp(MID, k / 0.4);
    else color.copy(MID).lerp(OUTER, (k - 0.4) / 0.6);
    // çoğu nokta sönük, azı parlak — düz parlaklık kum kağıdı gibi görünür
    const brightness = 0.24 + 0.85 * random() * random();
    colors[i * 3] = color.r * brightness;
    colors[i * 3 + 1] = color.g * brightness;
    colors[i * 3 + 2] = color.b * brightness;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

function buildShell(): THREE.BufferGeometry {
  const random = makeRandom(0xb0193e);
  const positions = new Float32Array(SHELL_COUNT * 3);
  const colors = new Float32Array(SHELL_COUNT * 3);

  const WARM = new THREE.Color("#ffb066"); // turuncu kıvılcımlar — kontrast
  const COOL = new THREE.Color("#bcd4ff");
  const color = new THREE.Color();

  for (let i = 0; i < SHELL_COUNT; i += 1) {
    const dir = direction(random);
    // dar bir kabuk: kürenin sınırı okunsun
    const radius = FIELD_RADIUS * (0.86 + random() * 0.16);
    positions[i * 3] = dir.x * radius;
    positions[i * 3 + 1] = dir.y * radius;
    positions[i * 3 + 2] = dir.z * radius;

    // azınlık sıcak: referans görseldeki turuncu serpinti
    color.copy(random() < 0.22 ? WARM : COOL);
    const brightness = 0.22 + 0.78 * random() * random();
    colors[i * 3] = color.r * brightness;
    colors[i * 3 + 1] = color.g * brightness;
    colors[i * 3 + 2] = color.b * brightness;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Küreyi saran ağ.
 *
 * İlk deneme uçları rastgele çiftlerden seçiyordu ve sonuç ağ değil DİKENLİ
 * BİR YILDIZ oluyordu: her tel küreyi baştan başa kesiyor, hiçbiri yüzeyi
 * takip etmiyordu. Burada her hub EN YAKIN komşularına bağlanıyor — teller
 * kısa, ağ küreye oturuyor. Uzun kesen tellerin payı bilerek küçük
 * (LONG_LINK_RATIO): derinlik hissini onlar veriyor, ama çoğunluk olurlarsa
 * diken görüntüsü geri geliyor.
 */
function buildFilaments(): THREE.BufferGeometry {
  const random = makeRandom(0x1cef11a);
  const hubs: THREE.Vector3[] = [];
  for (let i = 0; i < HUB_COUNT; i += 1) {
    hubs.push(direction(random).multiplyScalar(FIELD_RADIUS * (0.4 + random() * 0.58)));
  }

  const links: Array<[THREE.Vector3, THREE.Vector3]> = [];
  // O(n²) komşu araması — n=420 için tek seferlik ~176k mesafe, ölçülemez
  // kadar ucuz; uzamsal indeks kurmak bu ölçekte fazladan karmaşıklık olurdu.
  for (const hub of hubs) {
    const nearest = hubs
      .filter((other) => other !== hub)
      .map((other) => ({ other, distance: hub.distanceToSquared(other) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, NEIGHBOURS);
    for (const { other } of nearest) links.push([hub, other]);
    if (random() < LONG_LINK_RATIO) {
      links.push([hub, hubs[Math.floor(random() * hubs.length)]!]);
    }
  }

  const positions = new Float32Array(links.length * 6);
  const colors = new Float32Array(links.length * 6);
  const TEAL = new THREE.Color("#3fd0a0");
  const VIOLET = new THREE.Color("#8f6fe0");
  const color = new THREE.Color();

  links.forEach(([a, b], i) => {
    color.copy(random() < 0.72 ? TEAL : VIOLET).multiplyScalar(0.3 + 0.7 * random());
    positions[i * 6] = a.x;
    positions[i * 6 + 1] = a.y;
    positions[i * 6 + 2] = a.z;
    positions[i * 6 + 3] = b.x;
    positions[i * 6 + 4] = b.y;
    positions[i * 6 + 5] = b.z;
    for (let v = 0; v < 2; v += 1) {
      colors[i * 6 + v * 3] = color.r;
      colors[i * 6 + v * 3 + 1] = color.g;
      colors[i * 6 + v * 3 + 2] = color.b;
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Yuvarlak yıldız damgası. `pointsMaterial` dokusuz çizince her nokta KARE
 * olur; ekran görüntüsünde toz "yıldız" değil "piksel çöpü" gibi duruyordu.
 */
export function buildStarTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(
      size / 2,
      size / 2,
      0,
      size / 2,
      size / 2,
      size / 2,
    );
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.35, "rgba(255,255,255,0.55)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
