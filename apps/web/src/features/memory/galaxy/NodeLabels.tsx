// NodeLabels / NodeTooltip — drei `Html` ile DOM etiketleri.
//
// Performans kuralı: 500 etiket aynı anda DOM'a basılmaz. Yalnız (a) kameraya
// yakın, (b) hover edilen, (c) seçili düğümler etiketlenir. Uzaktakiler
// gizlidir — hem kare hızı hem okunabilirlik için (2D grafikte de aynı
// gerekçeyle zoom eşiği vardı).
import { Html } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useMemo, useState } from "react";
import * as THREE from "three";
import { SCOPE_COLOR, scopeOf, type GalaxyNode } from "./layout.js";

/** Bu mesafeden yakın düğümler başlıklarını gösterir. */
const LABEL_DISTANCE = 11;
/** Aynı anda en fazla bu kadar etiket — kalabalıkta DOM patlamasın. */
const MAX_LABELS = 14;

export function NodeLabels({
  nodes,
  hoveredId,
  selectedId,
}: {
  nodes: GalaxyNode[];
  hoveredId: string | null;
  selectedId: string | null;
}) {
  const { camera } = useThree();
  const [nearby, setNearby] = useState<GalaxyNode[]>([]);
  const position = useMemo(() => new THREE.Vector3(), []);

  useFrame(() => {
    const close: Array<{ node: GalaxyNode; distance: number }> = [];
    for (const node of nodes) {
      position.set(...node.position);
      const distance = camera.position.distanceTo(position);
      if (distance <= LABEL_DISTANCE) close.push({ node, distance });
    }
    close.sort((a, b) => a.distance - b.distance);
    const next = close.slice(0, MAX_LABELS).map((c) => c.node);
    // referans eşitliği yerine kimlik listesi karşılaştırması: her karede
    // setState çağırmak React'i boşuna döndürürdü
    setNearby((prev) =>
      prev.length === next.length && prev.every((n, i) => n.id === next[i]?.id) ? prev : next,
    );
  });

  const pinned = nodes.filter((n) => n.id === hoveredId || n.id === selectedId);
  const shown = [...new Map([...nearby, ...pinned].map((n) => [n.id, n])).values()];

  return (
    <>
      {shown.map((node) => (
        <Html
          key={node.id}
          position={node.position}
          center
          distanceFactor={12}
          zIndexRange={[10, 0]}
          style={{ pointerEvents: "none" }}
        >
          <div
            data-testid="galaxy-label"
            style={{
              transform: "translateY(18px)",
              whiteSpace: "nowrap",
              fontSize: 11,
              color: "#c6d0dc",
              textShadow: "0 0 4px #08090d, 0 0 8px #08090d",
              opacity: node.id === hoveredId || node.id === selectedId ? 1 : 0.75,
            }}
          >
            {node.title.length > 42 ? `${node.title.slice(0, 42)}…` : node.title}
          </div>
        </Html>
      ))}
    </>
  );
}

/** Hover kartı: başlık + kapsam/tür + önem/güven. */
export function NodeTooltip({ node }: { node: GalaxyNode | null }) {
  if (!node) return null;
  const scope = scopeOf(node.scope);
  return (
    <Html position={node.position} center distanceFactor={10} zIndexRange={[20, 10]}>
      <div
        data-testid="galaxy-tooltip"
        style={{
          transform: "translateY(-42px)",
          minWidth: 190,
          maxWidth: 260,
          padding: "8px 10px",
          borderRadius: 8,
          background: "rgba(8,9,13,0.94)",
          border: `1px solid ${SCOPE_COLOR[scope]}`,
          color: "#e6edf3",
          fontSize: 11,
          lineHeight: 1.45,
          pointerEvents: "none",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{node.title}</div>
        <div style={{ color: "#8b98a5" }}>
          {/* kapsam sahibi (proje/ajan adı) — "kimin anısı" sorusunun cevabı */}
          <span style={{ color: SCOPE_COLOR[scope] }}>
            {node.scopeLabel ? `${scope}: ${node.scopeLabel}` : scope}
          </span>{" "}
          · {node.type} · {node.status}
        </div>
        <div style={{ color: "#8b98a5" }}>
          önem {node.importance.toFixed(2)} · güven {node.confidence.toFixed(2)}
        </div>
      </div>
    </Html>
  );
}
