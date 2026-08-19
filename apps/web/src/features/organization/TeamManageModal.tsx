// Takım yönetimi (Founder direktifi 2026-08-14): üst bardaki "+ Takım"dan
// açılır — mevcut takımları listeler (üye sayısı + arşivle), tekli oluşturma
// ve TOPLU oluşturma (satır başına "Ad" ya da "Ad, ÜstBirim") sunar. Sıfır
// yeni backend: createUnit + archiveUnit (T18) — arşiv ön koşulları sunucuda,
// gerçek hatalar satır satır gösterilir. "Sıfırdan kur"a gerek kalmadan nokta
// atışı müdahale alanı.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Dialog, Field, Input, Select, Textarea } from "@acos/ui";
import { AcosApiError } from "@acos/contracts/client";
import { api, keys, queryClient } from "../../lib/api.js";
import { parseTeams, slugify } from "./orgImport.js";

function problemDetail(err: unknown): string {
  return err instanceof AcosApiError ? (err.problem.detail ?? err.problem.code) : String(err);
}

export function TeamManageModal({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const units = useQuery({ queryKey: keys.orgUnits(companyId), queryFn: () => api.org.listUnits(companyId) });
  const edges = useQuery({ queryKey: keys.orgEdges(companyId), queryFn: () => api.org.listEdges(companyId) });

  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [bulk, setBulk] = useState("");
  const [rowStates, setRowStates] = useState<Array<{ label: string; ok: boolean; detail?: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const teams = (units.data ?? []).filter((u) => u.kind === "team");
  const parents = (units.data ?? []).filter((u) => u.kind !== "team");
  const headcount = (unitId: string) =>
    (edges.data ?? []).filter(
      (e) => e.kind === "member_of" && e.toUnitId === unitId && e.endedAt === null,
    ).length;
  const { teams: bulkTeams, problems: bulkProblems } = useMemo(() => parseTeams(bulk), [bulk]);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.orgUnits(companyId) }),
      queryClient.invalidateQueries({ queryKey: keys.orgEdges(companyId) }),
    ]);

  async function createOne(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.org.createUnit(companyId, {
        name,
        slug: slugify(name),
        kind: "team",
        parentId: parentId === "" ? null : parentId,
      });
      setName("");
      await invalidate();
    } catch (err) {
      setError(problemDetail(err));
    } finally {
      setBusy(false);
    }
  }

  async function createBulk(): Promise<void> {
    setBusy(true);
    setError(null);
    const log: Array<{ label: string; ok: boolean; detail?: string }> = [];
    // mevcut birimler çalıştırma anında taze çekilir (modal sorgusu geç
    // yüklenmişse var-olan kontrolü boşa düşüyordu)
    const bySlugOrName = new Map<string, string>();
    for (const u of await api.org.listUnits(companyId)) {
      bySlugOrName.set(u.slug.toLowerCase(), u.id);
      bySlugOrName.set(u.name.toLowerCase(), u.id);
    }
    for (const spec of bulkTeams) {
      if (bySlugOrName.has(slugify(spec.name)) || bySlugOrName.has(spec.name.toLowerCase())) {
        log.push({ label: spec.name, ok: true, detail: "zaten var — atlandı" });
        continue;
      }
      const parent = spec.parent ? bySlugOrName.get(spec.parent.toLowerCase()) : null;
      if (spec.parent && !parent) {
        log.push({ label: spec.name, ok: false, detail: `üst birim '${spec.parent}' bulunamadı` });
        continue;
      }
      try {
        const created = await api.org.createUnit(companyId, {
          name: spec.name,
          slug: slugify(spec.name),
          kind: "team",
          parentId: parent ?? null,
        });
        bySlugOrName.set(created.slug.toLowerCase(), created.id);
        bySlugOrName.set(created.name.toLowerCase(), created.id);
        log.push({ label: spec.name, ok: true });
      } catch (err) {
        const conflict = err instanceof AcosApiError && err.problem.status === 409;
        if (conflict) log.push({ label: spec.name, ok: true, detail: "zaten var — atlandı" });
        else log.push({ label: spec.name, ok: false, detail: problemDetail(err) });
      }
      setRowStates([...log]);
    }
    setRowStates(log);
    setBulk("");
    await invalidate();
    setBusy(false);
  }

  async function archive(unitId: string, teamName: string): Promise<void> {
    if (!window.confirm(`"${teamName}" takımı arşivlensin mi?`)) return;
    setError(null);
    try {
      await api.org.archiveUnit(companyId, unitId);
      await invalidate();
    } catch (err) {
      setError(problemDetail(err));
    }
  }

  return (
    <Dialog open title="Takımlar" onClose={onClose}>
      <div className="space-y-4" data-testid="team-manage-modal">
        {error && (
          <p className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger" data-testid="team-manage-error">
            {error}
          </p>
        )}

        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase text-acos-fg1">Mevcut takımlar</h4>
          {teams.length === 0 ? (
            <p className="text-xs text-acos-fg2">Henüz takım yok.</p>
          ) : (
            <div className="max-h-40 space-y-1 overflow-y-auto">
              {teams.map((team) => (
                <div
                  key={team.id}
                  className="flex items-center gap-2 rounded border border-acos-line px-2 py-1 text-sm"
                  data-testid={`team-row-${team.slug}`}
                >
                  <span className="truncate">{team.name}</span>
                  <span className="rounded-full bg-acos-bg2 px-1.5 text-[10px] tabular-nums text-acos-fg1">
                    {headcount(team.id)} üye
                  </span>
                  <Button
                    variant="ghost"
                    className="ml-auto px-2 py-0.5 text-xs text-danger"
                    onClick={() => void archive(team.id, team.name)}
                    data-testid={`team-archive-${team.slug}`}
                  >
                    Arşivle
                  </Button>
                </div>
              ))}
            </div>
          )}
          <p className="mt-1 text-[10px] text-acos-fg2">
            İçinde aktif ajan olan takım arşivlenemez — önce ajanları Organizasyon&apos;dan taşıyın.
          </p>
        </div>

        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void createOne();
          }}
        >
          <div className="flex-1">
            <Field label="Yeni takım">
              <Input value={name} onChange={(e) => setName(e.target.value)} required data-testid="team-create-name" />
            </Field>
          </div>
          <div className="w-44">
            <Field label="Üst birim">
              <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
                <option value="">— en üst seviye —</option>
                {parents.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Button type="submit" disabled={busy || name.trim() === ""} data-testid="team-create-submit">
            Oluştur
          </Button>
        </form>

        <div>
          <h4 className="mb-1 text-xs font-semibold uppercase text-acos-fg1">Toplu oluştur</h4>
          <Textarea
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
            rows={4}
            placeholder={"Backend, Engineering\nFrontend, Engineering\nİçerik Ekibi"}
            className="font-mono text-xs"
            data-testid="team-bulk-text"
          />
          {bulk.trim() !== "" && (
            <p className="mt-1 text-xs text-acos-fg1" data-testid="team-bulk-preview">
              {bulkTeams.length} takım hazır
              {bulkProblems.length > 0 && (
                <span className="text-danger"> · {bulkProblems[0]}</span>
              )}
            </p>
          )}
          {rowStates.length > 0 && (
            <div className="mt-1 max-h-24 overflow-y-auto text-xs" data-testid="team-bulk-log">
              {rowStates.map((s, i) => (
                <p key={i} className={s.ok ? "text-acos-fg1" : "text-danger"}>
                  {s.ok ? "✓" : "✗"} {s.label}
                  {s.detail ? ` — ${s.detail}` : ""}
                </p>
              ))}
            </div>
          )}
          <div className="mt-2 flex justify-end">
            <Button
              disabled={busy || bulkTeams.length === 0 || bulkProblems.length > 0}
              onClick={() => void createBulk()}
              data-testid="team-bulk-run"
            >
              {busy ? "Oluşturuluyor…" : "Toplu oluştur"}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
