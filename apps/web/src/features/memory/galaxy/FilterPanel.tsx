// FilterPanel — 12 §8.1 filtreleri, sahnenin üstünde overlay.
//
// Filtre CANLI uygulanır (yeniden sorgu yok): veri zaten elde, süzme
// istemcide. Kapsam filtresi galaksinin bir kabuğunu tek başına göstermeye
// yarar — "yalnız şirket çekirdeği" gibi.
import type { GalaxyFilters } from "./useGalaxyData.js";
import { SCOPE_COLOR } from "./layout.js";

const TYPES = ["episodic", "semantic", "procedural", "decision", "failure", "relationship"];

export function FilterPanel({
  filters,
  onChange,
  nodeCount,
  totalCount,
}: {
  filters: GalaxyFilters;
  onChange: (next: GalaxyFilters) => void;
  nodeCount: number;
  totalCount: number;
}) {
  const set = (patch: Partial<GalaxyFilters>) => onChange({ ...filters, ...patch });

  return (
    <div
      data-testid="galaxy-filters"
      className="pointer-events-auto absolute left-3 top-3 z-10 flex flex-col gap-2 rounded-lg border border-acos-bg3 bg-acos-bg1/90 p-3 text-xs backdrop-blur"
      style={{ width: 208 }}
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold text-acos-fg0">Filtreler</span>
        <span className="text-acos-fg2" data-testid="galaxy-count">
          {nodeCount}/{totalCount}
        </span>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-acos-fg2">Kapsam</span>
        <select
          data-testid="galaxy-filter-scope"
          className="rounded bg-acos-bg2 px-2 py-1 text-acos-fg0"
          value={filters.scope}
          onChange={(e) => set({ scope: e.target.value })}
        >
          <option value="">hepsi</option>
          <option value="company">şirket</option>
          <option value="project">proje</option>
          <option value="agent">ajan</option>
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-acos-fg2">Tür</span>
        <select
          data-testid="galaxy-filter-type"
          className="rounded bg-acos-bg2 px-2 py-1 text-acos-fg0"
          value={filters.type}
          onChange={(e) => set({ type: e.target.value })}
        >
          <option value="">hepsi</option>
          {TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-acos-fg2">Önem ≥ {filters.minImportance.toFixed(2)}</span>
        <input
          data-testid="galaxy-filter-importance"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={filters.minImportance}
          onChange={(e) => set({ minImportance: Number(e.target.value) })}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-acos-fg2">Güven ≥ {filters.minConfidence.toFixed(2)}</span>
        <input
          data-testid="galaxy-filter-confidence"
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={filters.minConfidence}
          onChange={(e) => set({ minConfidence: Number(e.target.value) })}
        />
      </label>

      <div className="mt-1 flex flex-col gap-1 border-t border-acos-bg3 pt-2">
        {(["company", "project", "agent"] as const).map((scope) => (
          <span key={scope} className="flex items-center gap-2 text-acos-fg2">
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: SCOPE_COLOR[scope],
                display: "inline-block",
              }}
            />
            {/* Şekil sarmal kollardan küresel kabuklara geçince eski etiketler
                ("kollar", "dış yörünge") yalan söylemeye başladı. Renk zaten
                kapsamı gösteriyor; efsane de artık kapsamın kendi adını
                yazıyor. */}
            {scope === "company" ? "şirket" : scope === "project" ? "proje" : "ajan"}
          </span>
        ))}
      </div>
    </div>
  );
}
