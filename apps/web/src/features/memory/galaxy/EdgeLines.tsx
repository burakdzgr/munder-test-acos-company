// EdgeLines — `memory_relations` kenarları tek bir LineSegments ile.
//
// Kenar başına ayrı obje yaratmak yüzlerce draw call demek olurdu; tüm
// kenarlar tek geometriye yazılır ve renk köşe (vertex) tamponundan gelir.
// Böylece "contradicts kırmızı, supports yeşil" ayrımı tek çizimde durur.
//
// Kenarlar dalgayı TAKİP ETMEZ: düğümler ±0.15 salınırken çizgileri her karede
// yeniden yazmak 500+ kenarda boşuna CPU'dur ve göz bu farkı seçmez.
import { useMemo } from "react";
import * as THREE from "three";
import { EDGE_COLOR, type GalaxyNode } from "./layout.js";
import type { GalaxyEdge } from "./useGalaxyData.js";

export function EdgeLines({ nodes, edges }: { nodes: GalaxyNode[]; edges: GalaxyEdge[] }) {
  const geometry = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const positions: number[] = [];
    const colors: number[] = [];
    const color = new THREE.Color();

    for (const edge of edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to) continue;
      positions.push(...from.position, ...to.position);
      color.set(EDGE_COLOR[edge.kind] ?? EDGE_COLOR.related_to!);
      // her iki uç da aynı renk — gradyan yok, okunabilirlik önce
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return geo;
  }, [nodes, edges]);

  // geometri değişince eskisini bırak (GPU tamponu sızmasın)
  useMemo(() => () => geometry.dispose(), [geometry]);

  if (edges.length === 0) return null;

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial vertexColors transparent opacity={0.42} />
    </lineSegments>
  );
}
