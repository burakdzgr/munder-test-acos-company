// "Ajan Ekle" modal (36 §8 — U10): the acos-final hire modal wired to the
// EXISTING single-transaction hire flow (T19) with the U10 additive params —
// avatarId (PixelLab library pick), expertise[] (T47 skill seed), projectId
// (project_members) and modelBinding (identity stays decoupled from the
// model). The legacy HireWizard stays on the Agents route (N6).
import { useMemo, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { cn } from "@acos/ui";
import { AcosApiError } from "@acos/contracts/client";
import { api, keys, queryClient } from "../../lib/api.js";
import { useNotifications } from "../../stores/notifications.js";
import { AVATAR_COUNT, portraitUrl } from "../office/characters.js";

// engine → provider name (model_providers.name); model "" = profile default
const ENGINES: Array<{ label: string; vendor: string; provider: string; models: string[] }> = [
  { label: "Claude Code", vendor: "Anthropic", provider: "anthropic", models: ["claude-sonnet-4-5", "claude-opus-4-5"] },
  { label: "Codex", vendor: "OpenAI", provider: "openai", models: ["gpt-5-codex"] },
  { label: "Groq", vendor: "openrouter", provider: "openrouter", models: ["groq/llama-3.3-70b"] },
  { label: "DeepSeek", vendor: "openrouter", provider: "openrouter", models: ["deepseek/deepseek-chat"] },
  { label: "Kimi", vendor: "openrouter", provider: "openrouter", models: ["moonshotai/kimi-k2"] },
  { label: "Ollama", vendor: "local", provider: "ollama", models: ["qwen2.5-coder:14b"] },
];

const EXPERTISE_SUGGESTIONS = ["React", "Node", "PostgreSQL", "Docker", "SEO", "a11y"];

const ROLE_CATEGORY: Array<{ label: string; match: (title: string, role: string) => boolean }> = [
  { label: "LİDERLİK", match: (t, r) => r === "lead" || /lead|manager|cto|ceo|em\b/i.test(t) },
  { label: "MÜHENDİSLİK", match: (t) => /engineer|developer|backend|frontend|qa|devops/i.test(t) },
  { label: "ÜRÜN", match: (t) => /product|analyst|design/i.test(t) },
  { label: "PAZARLAMA", match: (t) => /market|growth|content/i.test(t) },
];

function categoryOf(title: string, defaultRole: string): string {
  return ROLE_CATEGORY.find((c) => c.match(title, defaultRole))?.label ?? "DİĞER";
}

const inputClass =
  "w-full rounded-md border border-acos-line bg-acos-bg2 px-2.5 py-1.5 text-[11.5px] text-acos-fg0 placeholder:text-acos-fg2 focus:border-dept-engineering focus:outline-none";
const labelClass = "mb-1 mt-3 block text-[10px] text-acos-fg1 first:mt-0";

export function HireModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const push = useNotifications((s) => s.push);

  const positions = useQuery({
    queryKey: keys.orgPositions(companyId),
    queryFn: () => api.org.listPositions(companyId),
    enabled: open,
  });
  const units = useQuery({
    queryKey: keys.orgUnits(companyId),
    queryFn: () => api.org.listUnits(companyId),
    enabled: open,
  });
  const edges = useQuery({
    queryKey: keys.orgEdges(companyId),
    queryFn: () => api.org.listEdges(companyId),
    enabled: open,
  });
  const agents = useQuery({
    queryKey: keys.agents(companyId),
    queryFn: () => api.agents.list(companyId),
    enabled: open,
  });
  const projects = useQuery({
    queryKey: [companyId, "projects", "list"],
    queryFn: () => api.projects.list(companyId),
    enabled: open,
  });

  const [name, setName] = useState("");
  const [positionId, setPositionId] = useState("");
  const [orgUnitId, setOrgUnitId] = useState("");
  const [avatarId, setAvatarId] = useState("av01");
  const [engineIndex, setEngineIndex] = useState(0);
  const [model, setModel] = useState(""); // "" = profile default
  const [expertise, setExpertise] = useState<string[]>([]);
  const [expertiseDraft, setExpertiseDraft] = useState("");
  const [projectId, setProjectId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, NonNullable<typeof positions.data>>();
    for (const position of positions.data ?? []) {
      const category = categoryOf(position.title, position.defaultRole);
      map.set(category, [...(map.get(category) ?? []), position]);
    }
    return [...map.entries()];
  }, [positions.data]);

  const teamUnits = (units.data ?? []).filter((u) => u.kind === "team" || u.kind === "department");
  const effectiveUnit = orgUnitId || teamUnits[0]?.id || "";
  // manager: the unit's active lead if one exists
  const unitLead = (edges.data ?? []).find(
    (e) => e.kind === "leads" && e.toUnitId === effectiveUnit && e.endedAt === null,
  )?.fromAgentId;

  const engine = ENGINES[engineIndex]!;

  const hire = useMutation({
    mutationFn: () =>
      api.agents.hire(companyId, {
        name: name.trim(),
        positionId,
        orgUnitId: effectiveUnit,
        seniority: "mid",
        // 2026-08-18 (Founder kararı): L2, her R2 aracında (terminal.run vb.)
        // onay istetiyordu ve onaylar Founder'a taşıyordu. L3 = kendi takım
        // kapsamında R2'ye kadar serbest; R3 (deploy/ödeme sınıfı) yine kapılı.
        autonomyLevel: 3,
        persona: `${(positions.data ?? []).find((p) => p.id === positionId)?.title ?? "Ekip üyesi"} olarak çalışır.${expertise.length > 0 ? ` Uzmanlık: ${expertise.join(", ")}.` : ""}`,
        ...(unitLead ? { managerAgentId: unitLead } : {}),
        activate: true,
        avatarId,
        ...(expertise.length > 0 ? { expertise } : {}),
        ...(projectId ? { projectId } : {}),
        ...(model !== "" ? { modelBinding: { provider: engine.provider, model } } : {}),
      }),
    onSuccess: (agent) => {
      push({ kind: "ok", title: "Ajan yerleştirildi", desc: `${agent.name} ofise katıldı` });
      void queryClient.invalidateQueries({ queryKey: [companyId] });
      setName("");
      setExpertise([]);
      setError(null);
      onClose();
    },
    onError: (err) => {
      setError(
        err instanceof AcosApiError
          ? `${err.problem.code}: ${err.problem.detail ?? err.problem.title}`
          : String(err),
      );
    },
  });

  function addExpertise(tag: string) {
    const clean = tag.trim();
    if (clean === "" || expertise.includes(clean)) return;
    setExpertise((tags) => [...tags, clean].slice(0, 12));
  }

  if (!open) return null;
  const canPlace = name.trim() !== "" && positionId !== "" && effectiveUnit !== "" && !hire.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 font-sans"
      role="dialog"
      aria-modal="true"
      aria-label="Ajan Ekle"
      data-testid="hire-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-[500px] flex-col overflow-hidden rounded-xl border border-acos-line bg-acos-bg1 text-[13px] text-acos-fg0">
        <div className="flex items-center gap-2 border-b border-acos-line px-4 py-3">
          <h2 className="text-[15px] font-semibold">Ajan Ekle</h2>
          <button
            onClick={onClose}
            aria-label="Kapat"
            className="ml-auto text-acos-fg2 hover:text-acos-fg0"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <label className={labelClass}>Ajan adı</label>
          <input
            data-testid="hire-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="örn. bir takım üyesi adı"
            className={cn(inputClass, "font-mono")}
          />

          <label className={labelClass}>Rol (rol kütüphanesi)</label>
          <div className="max-h-28 overflow-y-auto rounded-md border border-acos-line bg-acos-bg2 p-1.5">
            {grouped.map(([category, list]) => (
              <div key={category}>
                <div className="px-1.5 pb-0.5 pt-1 text-[8.5px] uppercase tracking-wide text-acos-fg2">
                  {category}
                </div>
                {list.map((position) => (
                  <button
                    key={position.id}
                    data-testid={`hire-role-${position.defaultRole}`}
                    onClick={() => setPositionId(position.id)}
                    className={cn(
                      "block w-full rounded-md border border-transparent px-2 py-1 text-left",
                      positionId === position.id &&
                        "border-dept-engineering bg-dept-engineering/10",
                    )}
                  >
                    <span className="text-[11.5px] font-semibold">{position.title}</span>
                    <span className="ml-2 text-[9.5px] text-acos-fg2">{position.defaultRole}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>

          <label className={labelClass}>Karakter (avatar kütüphanesi)</label>
          <div className="grid max-h-32 grid-cols-6 gap-1.5 overflow-y-auto rounded-md border border-acos-line bg-acos-bg2 p-1.5">
            {Array.from({ length: AVATAR_COUNT }, (_, i) => {
              const id = `av${String(i + 1).padStart(2, "0")}`;
              return (
                <button
                  key={id}
                  data-testid={`hire-avatar-${id}`}
                  onClick={() => setAvatarId(id)}
                  className={cn(
                    "flex aspect-square items-center justify-center rounded-lg border-2 bg-acos-bg3",
                    avatarId === id ? "border-dept-engineering" : "border-transparent",
                  )}
                >
                  <img
                    src={portraitUrl(id)}
                    alt={id}
                    className="h-[76%] w-[76%] [image-rendering:pixelated]"
                  />
                </button>
              );
            })}
          </div>

          <label className={labelClass}>AI motoru (kimlik modelden bağımsız kalır)</label>
          <div className="grid grid-cols-3 gap-1.5">
            {ENGINES.map((item, i) => (
              <button
                key={item.label}
                onClick={() => {
                  setEngineIndex(i);
                  setModel("");
                }}
                className={cn(
                  "rounded-md border px-2 py-1.5 text-left text-[11px]",
                  engineIndex === i
                    ? "border-dept-engineering bg-dept-engineering/10 text-acos-fg0"
                    : "border-acos-line bg-acos-bg2 text-acos-fg1",
                )}
              >
                {item.label}
                <span className="block text-[8px] text-acos-fg2">{item.vendor}</span>
              </button>
            ))}
          </div>
          <label className={labelClass}>Model ({engine.label})</label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className={inputClass}
            data-testid="hire-model"
          >
            <option value="">Varsayılan (şirket model profili)</option>
            {engine.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className={labelClass}>Uzmanlık</label>
              <input
                data-testid="hire-expertise"
                value={expertiseDraft}
                onChange={(e) => setExpertiseDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addExpertise(expertiseDraft);
                    setExpertiseDraft("");
                  }
                }}
                placeholder="React, a11y… (Enter)"
                className={inputClass}
              />
              <div className="mt-1.5 flex flex-wrap gap-1">
                {EXPERTISE_SUGGESTIONS.filter((s) => !expertise.includes(s)).map((tag) => (
                  <button
                    key={tag}
                    onClick={() => addExpertise(tag)}
                    className="rounded-full border border-acos-line bg-acos-bg3 px-1.5 py-px text-[9px] text-acos-fg1"
                  >
                    {tag}
                  </button>
                ))}
                {expertise.map((tag) => (
                  <button
                    key={tag}
                    onClick={() => setExpertise((tags) => tags.filter((t) => t !== tag))}
                    className="rounded-full border border-dept-engineering bg-dept-engineering/15 px-1.5 py-px text-[9px] text-dept-engineering"
                    title="kaldır"
                  >
                    {tag} ✕
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className={labelClass}>Proje</label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className={inputClass}
                data-testid="hire-project"
              >
                <option value="">— seçme —</option>
                {(projects.data?.items ?? []).slice(0, 30).map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <label className={labelClass}>Birim</label>
              <select
                value={effectiveUnit}
                onChange={(e) => setOrgUnitId(e.target.value)}
                className={inputClass}
                data-testid="hire-unit"
              >
                {teamUnits.map((unit) => (
                  <option key={unit.id} value={unit.id}>
                    {unit.name} ({unit.kind})
                  </option>
                ))}
              </select>
              <div className="mt-1 text-[9px] text-acos-fg2">
                Yönetici: {unitLead
                  ? (agents.data ?? []).find((a) => a.id === unitLead)?.name ?? "birim lideri"
                  : "— (üst seviye)"}
              </div>
            </div>
          </div>

          {error && (
            <div className="mt-2 text-[10px]" style={{ color: "#ff6b8a" }} data-testid="hire-error">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-acos-line px-4 py-3">
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="rounded-md border border-acos-line bg-acos-bg2 px-3 py-1.5 text-[11px] text-acos-fg1"
          >
            İptal
          </button>
          <button
            data-testid="hire-place"
            disabled={!canPlace}
            onClick={() => hire.mutate()}
            className="rounded-md px-3.5 py-1.5 text-[11px] font-semibold text-white disabled:opacity-40"
            style={{ background: "#a879ff" }}
          >
            {hire.isPending ? "Yerleştiriliyor…" : "Yerleştir →"}
          </button>
        </div>
      </div>
    </div>
  );
}
