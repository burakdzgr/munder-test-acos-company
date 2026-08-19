// Veri adaptörü (ADR-021): GERÇEK API → sahne modeli. Mock yok.
//
// Kaynak `api.memories.graph` — 12 §8.2'nin sunucu tarafında zaten kapladığı
// (500 düğüm) yanıt. Bu kanca yalnız üç şey yapar:
//   1. düğümleri deterministik konumlara yerleştirir (layout.ts),
//   2. filtreleri uygular (12 §8.1),
//   3. bir öncekiyle karşılaştırıp YENİ gelen düğümleri işaretler — "yıldız
//      doğuyor" pop animasyonu bundan tetiklenir.
//
// Canlı besleme için ayrı bir soket dinleyicisi YOK: RealtimeDispatcher
// `memory.*` olaylarında `[companyId, "memories"]` anahtarını zaten geçersiz
// kılıyor, sorgu kendiliğinden tazeleniyor. Yeni düğüm tespiti de bu yüzden
// diff ile yapılıyor (24 §5: soketin tek tüketicisi store'lardır).
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api.js";
import { placeNode, scopeOf, type GalaxyNode } from "./layout.js";

export interface GalaxyFilters {
  scope: string; // "" = hepsi
  type: string;
  minImportance: number;
  minConfidence: number;
}

export const DEFAULT_FILTERS: GalaxyFilters = {
  scope: "",
  type: "",
  minImportance: 0,
  minConfidence: 0,
};

export interface GalaxyEdge {
  from: string;
  to: string;
  kind: string;
}

export interface GalaxyData {
  nodes: GalaxyNode[];
  edges: GalaxyEdge[];
  /** Filtre uygulanmadan önceki düğüm sayısı (panelde "görünen/toplam"). */
  totalCount: number;
  /** Sunucu 500 düğümde kapadı mı (12 §8.2). */
  capped: boolean;
  /** Bu turda ilk kez görünen düğüm kimlikleri (pop animasyonu için). */
  fresh: Set<string>;
  isLoading: boolean;
}

export function useGalaxyData(companyId: string, filters: GalaxyFilters): GalaxyData {
  const query = useQuery({
    queryKey: [companyId, "memories", "graph"],
    queryFn: () => api.memories.graph(companyId),
  });

  const seenRef = useRef<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  const placed = useMemo(() => {
    const nodes = (query.data?.nodes ?? []).map(placeNode);
    return { nodes, edges: query.data?.edges ?? [], capped: query.data?.capped ?? false };
  }, [query.data]);

  // İlk yükleme "yeni" sayılmaz: yoksa galaksi açılışta tümüyle patlar.
  useEffect(() => {
    if (!query.data) return;
    const ids = placed.nodes.map((n) => n.id);
    if (seenRef.current.size === 0) {
      seenRef.current = new Set(ids);
      return;
    }
    const added = ids.filter((id) => !seenRef.current.has(id));
    if (added.length > 0) {
      for (const id of added) seenRef.current.add(id);
      setFresh(new Set(added));
      // pop bir kerelik: animasyon süresinden sonra işaret düşer
      const timer = setTimeout(() => setFresh(new Set()), 2500);
      return () => clearTimeout(timer);
    }
    return;
  }, [placed.nodes, query.data]);

  const filtered = useMemo(() => {
    const nodes = placed.nodes.filter((node) => {
      if (filters.scope && scopeOf(node.scope) !== filters.scope) return false;
      if (filters.type && node.type !== filters.type) return false;
      if (node.importance < filters.minImportance) return false;
      if (node.confidence < filters.minConfidence) return false;
      return true;
    });
    // kenarlar yalnız iki ucu da görünen düğümler arasında çizilir
    const visible = new Set(nodes.map((n) => n.id));
    const edges = placed.edges.filter((e) => visible.has(e.from) && visible.has(e.to));
    return { nodes, edges };
  }, [placed, filters]);

  return {
    nodes: filtered.nodes,
    edges: filtered.edges,
    totalCount: placed.nodes.length,
    capped: placed.capped,
    fresh,
    isLoading: query.isLoading,
  };
}
