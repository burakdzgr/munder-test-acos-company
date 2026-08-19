// ClusterGlows — kapsam sahibi başına parlak hâle.
//
// Referans bilgi grafiğindeki o beyaz "yığın" lekeleri aslında bir şey söyler:
// orada çok düğüm var. Burada da öyle — hâle DEKOR DEĞİL, VERİDİR: her
// `scopeRef` (proje / ajan) için o kümenin ağırlık merkezine, düğüm sayısıyla
// büyüyen bir hâle konur. Bir projenin hafızası şiştikçe lekesi büyür.
//
// Tek `sprite` başına bir draw call olduğu için hâle sayısı sınırlanır: en
// kalabalık MAX_GLOWS küme. Yüzlerce projede yüzlerce sprite çizmek, taşıdığı
// bilgiden pahalıya gelirdi.
import { useMemo } from "react";
import * as THREE from "three";
import { SCOPE_COLOR, scopeOf, type GalaxyNode } from "./layout.js";

const MAX_GLOWS = 8;
/** Bir kümenin hâle alması için gereken en az düğüm sayısı. */
const MIN_CLUSTER = 2;

export function ClusterGlows({ nodes }: { nodes: GalaxyNode[] }) {
  const texture = useMemo(() => buildGlowTexture(), []);

  const glows = useMemo(() => {
    const groups = new Map<string, GalaxyNode[]>();
    for (const node of nodes) {
      const key = node.scopeRef ?? `scope:${scopeOf(node.scope)}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(node);
      else groups.set(key, [node]);
    }
    return [...groups.entries()]
      .filter(([, group]) => group.length >= MIN_CLUSTER)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_GLOWS)
      .map(([key, group]) => {
        const center: [number, number, number] = [0, 0, 0];
        for (const node of group) {
          center[0] += node.position[0] / group.length;
          center[1] += node.position[1] / group.length;
          center[2] += node.position[2] / group.length;
        }
        // Boyut düğüm sayısıyla ama KAREKÖKLE büyür: doğrusal olsaydı
        // kalabalık bir proje bütün sahneyi yutardı.
        const scale = 2.6 + 1.9 * Math.sqrt(group.length);
        return { key, center, scale, scope: scopeOf(group[0]!.scope) };
      });
  }, [nodes]);

  return (
    <>
      {glows.map((glow) => (
        <sprite key={glow.key} position={glow.center} scale={[glow.scale, glow.scale, 1]}>
          <spriteMaterial
            map={texture}
            color={SCOPE_COLOR[glow.scope]}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            transparent
            opacity={0.5}
            toneMapped={false}
          />
        </sprite>
      ))}
    </>
  );
}

/** Radyal gradyan → yumuşak hâle. 2D canvas'ta üretmek en ucuz yol. */
function buildGlowTexture(): THREE.Texture {
  const size = 128;
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
    gradient.addColorStop(0, "rgba(255,255,255,0.9)");
    gradient.addColorStop(0.2, "rgba(255,255,255,0.34)");
    gradient.addColorStop(0.55, "rgba(255,255,255,0.09)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient;
    context.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
