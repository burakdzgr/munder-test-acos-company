// GalaxyScene — hafıza grafiğinin 3D galaksi görünümü (ADR-021, 12 §8.2).
//
// Sahne kökü: koyu uzay, hafif ambient + tek nokta ışık, OrbitControls,
// Bloom. Galaksinin kendisi (düğüm bulutu + kenarlar) yavaşça döner; dalga
// hareketi NodeCloud içindedir.
//
// WebGL yoksa (eski sürücü, uzak masaüstü, CI'ın headless'ı) sahne hiç
// kurulmaz: 2D grafiğe düşülür. Görselleştirme bir lüks katmandır, panelin
// çalışmasını engellememeli.
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Bloom, EffectComposer } from "@react-three/postprocessing";
import { useRef, useState } from "react";
import type * as THREE from "three";
import { Card } from "@acos/ui";
import { CameraRig, HOME_POSITION, type OrbitLike } from "./CameraRig.js";
import { EdgeLines } from "./EdgeLines.js";
import { ClusterGlows } from "./ClusterGlows.js";
import { KnowledgeField } from "./KnowledgeField.js";
import { FilterPanel } from "./FilterPanel.js";
import { NodeCloud } from "./NodeCloud.js";
import { NodeLabels, NodeTooltip } from "./NodeLabels.js";
import { Starfield } from "./Starfield.js";
import { DEFAULT_FILTERS, useGalaxyData, type GalaxyFilters } from "./useGalaxyData.js";
import type { GalaxyNode } from "./layout.js";

/** Galaksinin kendi ekseni etrafındaki çok yavaş dönüşü (rad/s). */
const SPIN = 0.02;

function SpinningGalaxy({ children }: { children: React.ReactNode }) {
  const groupRef = useRef<THREE.Group>(null);
  useFrame((_state, delta) => {
    if (groupRef.current) groupRef.current.rotation.y += SPIN * delta;
  });
  return <group ref={groupRef}>{children}</group>;
}

export interface WebglStatus {
  ok: boolean;
  /** Neden düşüldüğü — ekranda gösterilir, yoksa 2D'ye sessizce düşerdik. */
  reason: string;
}

/**
 * WebGL yoklaması — ÖMÜRDE BİR KEZ.
 *
 * İki kural var, ikisi de bedeli ödenmiş bilgi:
 *  1. Sonuç önbelleklenir. Bu kontrol JSX içinde çağrılıyor, yani her
 *     render'da yeniden koşardı; her koşu yeni bir WebGL context'i açar ve
 *     tarayıcıların canlı context sayısı sınırlıdır (Chromium ~16).
 *  2. Yoklama context'i AÇIKÇA serbest bırakılır (`WEBGL_lose_context`).
 *     Çöp toplayıcıyı beklemek, sahnenin kendi context'inin sırf yoklama
 *     artıkları yüzünden düşürülmesi riskini bırakırdı.
 */
let cachedStatus: WebglStatus | null = null;

export function webglStatus(): WebglStatus {
  if (cachedStatus) return cachedStatus;
  try {
    const canvas = document.createElement("canvas");
    const context =
      canvas.getContext("webgl2") ??
      canvas.getContext("webgl") ??
      canvas.getContext("experimental-webgl");
    if (!context) {
      cachedStatus = { ok: false, reason: "tarayıcı WebGL bağlamı vermedi" };
    } else {
      cachedStatus = { ok: true, reason: "" };
      const lose = (context as WebGLRenderingContext).getExtension("WEBGL_lose_context");
      lose?.loseContext();
    }
  } catch (error) {
    cachedStatus = { ok: false, reason: error instanceof Error ? error.message : "bilinmeyen hata" };
  }
  return cachedStatus;
}

export function webglAvailable(): boolean {
  return webglStatus().ok;
}

/**
 * `page` — Gözlemevi'nin tam sayfa görünümü: filtre paneli, etiketler, 560px.
 * `panel` — Command Center'ın dar sol paneli: kart yok, filtre yok, etiket
 *           yok (dar şeritte okunmuyor, sadece kalabalık yapıyor), hover
 *           kartı kalır. Aynı sahne, aynı veri; yalnız süsü kısılmış.
 */
export type GalaxyVariant = "page" | "panel";

/** Panelde sahne listenin üstündeki bir şerit değil, panelin TAMAMIDIR. */
const PANEL_HEIGHT = "100%";
const PAGE_HEIGHT = 560;

export function GalaxyScene({
  companyId,
  onSelect,
  variant = "page",
}: {
  companyId: string;
  onSelect: (memoryId: string | null) => void;
  variant?: GalaxyVariant;
}) {
  const [filters, setFilters] = useState<GalaxyFilters>(DEFAULT_FILTERS);
  const [hoveredId, setHovered] = useState<string | null>(null);
  const [selectedId, setSelected] = useState<string | null>(null);
  const controlsRef = useRef<OrbitLike | null>(null);

  const { nodes, edges, totalCount, capped, fresh, isLoading } = useGalaxyData(companyId, filters);

  const hovered = nodes.find((n) => n.id === hoveredId) ?? null;
  const focus: GalaxyNode | null = nodes.find((n) => n.id === selectedId) ?? null;

  const select = (id: string | null) => {
    setSelected(id);
    onSelect(id);
  };

  const compact = variant === "panel";

  const scene = (
    <div
      style={{
        height: compact ? PANEL_HEIGHT : PAGE_HEIGHT,
        background: "#05060a",
        borderRadius: compact ? 0 : 8,
        overflow: "hidden",
      }}
    >
      <Canvas
        camera={{ position: HOME_POSITION, fov: 55, near: 0.1, far: 400 }}
        dpr={[1, 1.75]} // retina'da 2x yerine 1.75: bloom pahalı
        onPointerMissed={() => select(null)} // boşluğa tıkla → galaksiye dön
      >
        <color attach="background" args={["#05060a"]} />
        {/*
          Işık YOK: düğümler ışıksız (basic) malzemeyle kendi renklerini
          yayıyor — yıldız mantığı. Işıklandırılmış malzeme denendi ve
          beyaz emissive kapsam renklerini yıkadı (hepsi gri çıktı).
        */}
        <Starfield />

        <SpinningGalaxy>
          {/* alan ÖNCE: küreyi o çizer, anılar onun içinde parlar */}
          <KnowledgeField />
          <ClusterGlows nodes={nodes} />
          <EdgeLines nodes={nodes} edges={edges} />
          <NodeCloud
            nodes={nodes}
            fresh={fresh}
            selectedId={selectedId}
            hoveredId={hoveredId}
            onHover={setHovered}
            onSelect={select}
          />
          {!compact && (
            <NodeLabels nodes={nodes} hoveredId={hoveredId} selectedId={selectedId} />
          )}
          <NodeTooltip node={hovered} />
        </SpinningGalaxy>

        <OrbitControls
          // drei'nin ref tipi three-stdlib'in OrbitControls'ü; biz yalnız
          // {target, update} yüzeyini kullanıyoruz (bkz. OrbitLike)
          ref={controlsRef as React.Ref<never>}
          enablePan={!compact} // dar panelde kaydırma yanlışlıkla tetikleniyor
          enableDamping
          dampingFactor={0.08}
          minDistance={3}
          maxDistance={90}
        />
        <CameraRig target={focus} controls={controlsRef} />

        {/* Bloom eşiği düşük: yüksek-confidence (parlak) düğümler hâlelensin */}
        <EffectComposer>
          <Bloom intensity={1.15} luminanceThreshold={0.22} luminanceSmoothing={0.9} mipmapBlur />
        </EffectComposer>
      </Canvas>
    </div>
  );

  if (compact) {
    return (
      <div className="relative min-h-0 flex-1" data-testid="memory-brain-graph">
        {scene}
      </div>
    );
  }

  return (
    <Card className="relative p-0" data-testid="memory-graph">
      {capped && (
        <p className="absolute right-3 top-3 z-10 rounded bg-acos-bg1/90 px-2 py-1 text-xs" style={{ color: "#ffcb47" }}>
          Graf 500 düğümle sınırlı — filtreleri daraltın.
        </p>
      )}
      <FilterPanel
        filters={filters}
        onChange={setFilters}
        nodeCount={nodes.length}
        totalCount={totalCount}
      />
      {isLoading && (
        <p className="absolute inset-0 z-10 flex items-center justify-center text-xs text-acos-fg2">
          Galaksi yükleniyor…
        </p>
      )}
      {scene}
    </Card>
  );
}
