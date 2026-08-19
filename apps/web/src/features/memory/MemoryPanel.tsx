// Hafıza panel (36 §5 — U07): the Command Center's left memory panel.
// Top = animated relational graph on a faint "brain-field" backdrop —
// nodes are memories (color by type, size ∝ importance, opacity ∝
// confidence), edges are memory_relations (supports green / contradicts
// red-dashed / derived_from purple / supersedes grey). Hover → provenance.
// Below: live memory list — new memories fade in on memory.created (WS
// invalidation). Views: Graf / Liste / Zaman. Backed by the Observatory
// endpoints (T48); read-only.
import { useEffect, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@acos/ui";
import type { MemoryDto, MemoryGraphResponse } from "@acos/contracts";
import { api } from "../../lib/api.js";
import { GalaxyScene, webglStatus } from "./galaxy/GalaxyScene.js";

export const MEMORY_TYPE_COLOR: Record<string, string> = {
  failure: "#ff6b8a",
  procedural: "#a879ff",
  semantic: "#ffcb47",
  episodic: "#4c9aff",
  social: "#3fd0a0",
  decision: "#ff8a5c",
};
const SCOPE_COLOR: Record<string, string> = {
  company: "#c9d1d9",
  project: "#4c9aff",
  agent: "#3fd0a0",
};
const EDGE_STYLE: Record<string, { color: string; dash: number[]; width: number }> = {
  contradicts: { color: "#ff4d4d", dash: [4, 3], width: 1.6 },
  derived_from: { color: "#a879ff", dash: [], width: 2 },
  supports: { color: "#3fd0a0", dash: [], width: 1.2 },
  supersedes: { color: "#5c6773", dash: [], width: 1.4 },
  related_to: { color: "#3a424c", dash: [], width: 1 },
};

export function memoryTypeColor(type: string): string {
  return MEMORY_TYPE_COLOR[type] ?? "#8fa3c8";
}

/** deterministic 0..1 hash per node id — stable positions without randomness. */
function hash01(s: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10_000) / 10_000;
}

type Hover = { x: number; y: number; node: MemoryGraphResponse["nodes"][number] } | null;

function BrainGraph({ graph }: { graph: MemoryGraphResponse }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const hoverRef = useRef<Hover>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const nodes = graph.nodes.slice(0, 120).map((node, i) => {
      const angle = hash01(node.id, 1) * Math.PI * 2;
      const radius = 0.25 + hash01(node.id, 2) * 0.65;
      return {
        data: node,
        // normalized center-relative coords; scaled to canvas each frame
        nx: Math.cos(angle) * radius * 0.5,
        ny: Math.sin(angle) * radius * 0.5,
        vx: (hash01(node.id, 3) - 0.5) * 0.0005,
        vy: (hash01(node.id, 4) - 0.5) * 0.0005,
        r: 3 + node.importance * 5,
        phase: hash01(node.id, 5) * Math.PI * 2,
        i,
      };
    });
    const byId = new Map(nodes.map((n) => [n.data.id, n]));
    const edges = graph.edges
      .filter((e) => byId.has(e.from) && byId.has(e.to))
      .map((e) => ({ a: byId.get(e.from)!, b: byId.get(e.to)!, kind: e.kind }));

    let raf = 0;
    let t = 0;
    const observer = new ResizeObserver(() => {
      canvas.width = canvas.clientWidth * devicePixelRatio;
      canvas.height = canvas.clientHeight * devicePixelRatio;
    });
    observer.observe(canvas);

    const onMove = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const w = rect.width;
      const h = rect.height;
      let best: (typeof nodes)[number] | null = null;
      let bestD = 12;
      for (const n of nodes) {
        const x = w / 2 + n.nx * w;
        const y = h / 2 + n.ny * h;
        const d = Math.hypot(mx - x, my - y) - n.r;
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      const next = best ? { x: mx, y: my, node: best.data } : null;
      if (next?.node.id !== hoverRef.current?.node.id || (next === null) !== (hoverRef.current === null)) {
        hoverRef.current = next;
        setHover(next);
      }
    };
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", () => {
      hoverRef.current = null;
      setHover(null);
    });

    const draw = () => {
      t += 1 / 60;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#08090d";
      ctx.fillRect(0, 0, w, h);

      // brain-field backdrop: faint hue-shifted dot lattice inside an ellipse
      const glow = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.5);
      glow.addColorStop(0, "rgba(120,160,255,.10)");
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, w, h);
      for (let y = 8; y < h - 6; y += 12) {
        const offset = (Math.floor(y / 12) % 2) * 6;
        for (let x = 8 + offset; x < w - 6; x += 12) {
          const dx = (x - w / 2) / (w / 2);
          const dy = (y - h / 2) / (h / 2);
          const d = Math.hypot(dx, dy);
          if (d > 1.02) continue;
          const alpha = Math.max(0, 0.28 - d * 0.24);
          ctx.fillStyle = `hsla(${200 + dx * 120},60%,60%,${alpha})`;
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, 7);
          ctx.fill();
        }
      }

      // gentle drift, tethered to the ellipse
      for (const n of nodes) {
        n.nx += n.vx + Math.sin(t * 0.6 + n.phase) * 0.00012;
        n.ny += n.vy + Math.cos(t * 0.5 + n.phase) * 0.00012;
        const d = Math.hypot(n.nx * 2, n.ny * 2);
        if (d > 0.85) {
          n.vx -= n.nx * 0.0004;
          n.vy -= n.ny * 0.0004;
        }
      }

      for (const e of edges) {
        const style = EDGE_STYLE[e.kind] ?? EDGE_STYLE.related_to!;
        ctx.strokeStyle = `${style.color}99`;
        ctx.lineWidth = style.width;
        ctx.setLineDash(style.dash);
        ctx.beginPath();
        ctx.moveTo(w / 2 + e.a.nx * w, h / 2 + e.a.ny * h);
        ctx.lineTo(w / 2 + e.b.nx * w, h / 2 + e.b.ny * h);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (const n of nodes) {
        const x = w / 2 + n.nx * w;
        const y = h / 2 + n.ny * h;
        const color = memoryTypeColor(n.data.type);
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, n.r + 4, 0, 7);
        ctx.fill();
        ctx.globalAlpha = 0.35 + 0.65 * n.data.confidence;
        ctx.beginPath();
        ctx.arc(x, y, n.r, 0, 7);
        ctx.fill();
        ctx.globalAlpha = 1;
        if (n.data.status === "candidate") {
          ctx.strokeStyle = "#ffcb47";
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.arc(x, y, n.r + 2, 0, 7);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("mousemove", onMove);
    };
  }, [graph]);

  return (
    <div className="relative shrink-0 border-b border-acos-line" data-testid="memory-brain-graph">
      <canvas ref={canvasRef} className="block h-[185px] w-full" />
      {hover && (
        <div
          className="pointer-events-none absolute z-10 max-w-56 rounded-md border border-acos-line bg-acos-bg2 px-2 py-1.5 text-[10px] shadow-lg"
          style={{ left: Math.min(hover.x + 10, 180), top: hover.y + 8 }}
          data-testid="memory-node-tooltip"
        >
          <div className="font-semibold text-acos-fg0">{hover.node.title}</div>
          <div className="mt-0.5 flex gap-2 text-acos-fg2">
            <span style={{ color: memoryTypeColor(hover.node.type) }}>{hover.node.type}</span>
            <span>{hover.node.scope}</span>
            <span className="font-mono tabular-nums">
              conf {hover.node.confidence.toFixed(2)} · imp {hover.node.importance.toFixed(2)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function MemoryRow({ memory, fresh }: { memory: MemoryDto; fresh: boolean }) {
  const typeColor = memoryTypeColor(memory.type);
  const scopeColor = SCOPE_COLOR[memory.scope] ?? "#8fa3c8";
  return (
    <div
      className={cn("border-b border-acos-line/50 px-2.5 py-1.5", fresh && "mem-fade-in")}
      data-testid="panel-memory-row"
    >
      <div className="truncate text-[11px] font-semibold text-acos-fg0">{memory.title}</div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <span
          className="rounded-full px-1.5 text-[8.5px]"
          style={{ background: `${typeColor}22`, color: typeColor }}
        >
          {memory.type}
        </span>
        <span
          className="rounded-full px-1.5 text-[8.5px]"
          style={{ background: `${scopeColor}22`, color: scopeColor }}
        >
          {memory.scope}
        </span>
        <span className="ml-auto font-mono text-[9px] tabular-nums text-acos-fg2">
          conf {memory.confidence.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

type MemoryTab = "graf" | "liste" | "zaman";

export function MemoryPanel() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [tab, setTab] = useState<MemoryTab>("graf");
  const knownIds = useRef<Set<string> | null>(null);
  const webgl = webglStatus(); // ömürde bir kez yoklanır, sonuç önbellekli

  const graph = useQuery({
    queryKey: [companyId, "memories", "graph"],
    queryFn: () => api.memories.graph(companyId),
  });
  const list = useQuery({
    queryKey: [companyId, "memories", "panel-list"],
    queryFn: () => api.memories.list(companyId, { status: "active" }),
  });

  const items = list.data?.items ?? [];
  // fade-in only for memories that arrived AFTER the first page render
  const fresh = new Set<string>();
  if (knownIds.current === null) {
    if (list.data) knownIds.current = new Set(items.map((m) => m.id));
  } else {
    for (const m of items) {
      if (!knownIds.current.has(m.id)) {
        fresh.add(m.id);
        knownIds.current.add(m.id);
      }
    }
  }

  const byTime = [...items].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-acos-bg1" data-testid="memory-panel">
      <div className="flex h-6 shrink-0 items-center gap-1 border-b border-acos-line px-2 text-[10px]">
        {(["graf", "liste", "zaman"] as const).map((key) => (
          <button
            key={key}
            data-testid={`memtab-${key}`}
            onClick={() => setTab(key)}
            className={cn(
              "rounded px-2 py-0.5 capitalize",
              tab === key ? "bg-acos-bg3 text-acos-fg0" : "text-acos-fg2 hover:text-acos-fg1",
            )}
          >
            {key}
          </button>
        ))}
        <span className="ml-auto text-[9px] text-acos-fg2">
          {items.length} anı
          {(list.data?.contradictions ?? 0) > 0 && (
            <span style={{ color: "#ff6b8a" }}> · {list.data!.contradictions} çelişki</span>
          )}
        </span>
      </div>
      {/*
        Graf sekmesi = SADECE 3D küre (ADR-021). Liste altta değil, kendi
        sekmesinde: grafın üstünde bir şerit olarak durduğunda ne graf ne
        liste okunuyordu ve Founder grafı büyük görmek istiyor. "Graf"
        sekmesinin işi grafı göstermek; anı listesi "Liste"/"Zaman"da.

        WebGL yoksa eski 2D brain-field'a düşülür ve SEBEBİ ekranda yazar —
        sessiz geri düşüş, hangi yolda olduğumuzu tahmin etmek zorunda
        bıraktığı için kaldırıldı.
      */}
      {tab === "graf" ? (
        webgl.ok ? (
          <GalaxyScene companyId={companyId} onSelect={() => {}} variant="panel" />
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            {graph.data && <BrainGraph graph={graph.data} />}
            <div className="px-2.5 py-1 text-[9px] text-acos-fg2">
              3D görünüm devre dışı — {webgl.reason}
            </div>
          </div>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {list.isLoading && <div className="p-3 text-[10px] text-acos-fg2">Yükleniyor…</div>}
          {!list.isLoading && items.length === 0 && (
            <div className="p-3 text-[10px] text-acos-fg2">
              Henüz anı yok — ajanlar öğrendikçe burada belirir.
            </div>
          )}
          {(tab === "zaman" ? byTime : items).map((memory, i, arr) => (
            <div key={memory.id}>
              {tab === "zaman" &&
                (i === 0 ||
                  new Date(arr[i - 1]!.createdAt).toDateString() !==
                    new Date(memory.createdAt).toDateString()) && (
                  <div className="bg-acos-bg2/60 px-2.5 py-0.5 text-[8.5px] uppercase tracking-wide text-acos-fg2">
                    {new Date(memory.createdAt).toLocaleDateString()}
                  </div>
                )}
              <MemoryRow memory={memory} fresh={fresh.has(memory.id)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
