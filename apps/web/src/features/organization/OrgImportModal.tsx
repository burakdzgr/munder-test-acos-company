// Organizasyon içe aktarma (Founder direktifi 2026-08-14): JSON (tam şema —
// birimler + pozisyonlar + ajanlar) veya CSV yapıştır/yükle → önizleme →
// sıralı kurulum. HİÇBİR yeni backend yüzeyi yok: her satır MEVCUT denetimli
// endpoint'lerden geçer (createUnit / createPosition / hire), yani tüm org
// kuralları (tek yönetici, döngüsüzlük, model bağı seed'i) sunucu tarafında
// aynen işler ve her adım event-audit'lidir. Kısmi hata satır satır raporlanır
// — import atomik değildir (bilinçli: mevcut API sözleşmesi).
// Ayrıştırıcılar saf modülde: ./orgImport.ts (unit-testli).
import { useMemo, useState } from "react";
import type { Agent, OrgUnit, Position } from "@acos/contracts";
import { Button, Dialog, Textarea } from "@acos/ui";
import { AcosApiError } from "@acos/contracts/client";
import { api, keys, queryClient } from "../../lib/api.js";
import { IMPORT_TEMPLATE, POSITION_TEMPLATE, parseImport, parsePositions, parseUnits } from "./orgImport.js";

type StepState = { label: string; state: "ok" | "error" | "pending"; detail?: string };

function problemDetail(err: unknown): string {
  return err instanceof AcosApiError ? (err.problem.detail ?? err.problem.code) : String(err);
}

function ImportLog({ steps }: { steps: StepState[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="max-h-56 space-y-0.5 overflow-y-auto rounded border border-acos-line p-2 text-xs" data-testid="org-import-log">
      {steps.map((s, i) => (
        <p key={i} className={s.state === "error" ? "text-danger" : "text-acos-fg1"}>
          {s.state === "error" ? "✗" : "✓"} {s.label}
          {s.detail ? ` — ${s.detail}` : ""}
        </p>
      ))}
    </div>
  );
}

export function OrgImportModal({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const [text, setText] = useState("");
  const [steps, setSteps] = useState<StepState[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);

  const { plan, problems } = useMemo(() => parseImport(text), [text]);
  const parsed = plan.units.length + plan.positions.length + plan.agents.length > 0;

  async function runImport(): Promise<void> {
    setRunning(true);
    const log: StepState[] = [];
    const push = (s: StepState) => {
      log.push(s);
      setSteps([...log]);
    };
    const fail = (label: string, err: unknown) => push({ label, state: "error", detail: problemDetail(err) });

    // Mevcut kayıtlar ÇALIŞTIRMA ANINDA taze çekilir — modal sorgusu henüz
    // yüklenmemişken koşulan importlar var-olanları "duplicate" diye sunucuya
    // çarpıyordu (Founder raporu 2026-08-14).
    const [freshUnits, freshPositions, freshAgents] = await Promise.all([
      api.org.listUnits(companyId),
      api.org.listPositions(companyId),
      api.agents.list(companyId),
    ]);
    const unitBySlug = new Map<string, OrgUnit>(
      freshUnits.map((u) => [u.slug.toLowerCase(), u]),
    );
    for (const u of freshUnits) unitBySlug.set(u.name.toLowerCase(), u);
    const positionByTitle = new Map<string, Position>(
      freshPositions.map((p) => [p.title.toLowerCase(), p]),
    );
    const agentByName = new Map<string, Agent>(
      freshAgents
        .filter((a) => a.status !== "offboarded")
        .map((a) => [a.name.toLowerCase(), a]),
    );

    // 1) birimler — ebeveynler önce (dosya içi referans + mevcutlar)
    const pendingUnits = [...plan.units];
    let guard = pendingUnits.length + 1;
    while (pendingUnits.length > 0 && guard-- > 0) {
      for (let i = 0; i < pendingUnits.length; i++) {
        const spec = pendingUnits[i]!;
        if (unitBySlug.has(spec.slug.toLowerCase()) || unitBySlug.has(spec.name.toLowerCase())) {
          push({ label: `birim ${spec.name}`, state: "ok", detail: "zaten var — atlandı" });
          pendingUnits.splice(i, 1);
          i--;
          continue;
        }
        const parent = spec.parent ? unitBySlug.get(spec.parent.toLowerCase()) : null;
        if (spec.parent && !parent) continue; // ebeveyni sonraki turda kurulacak
        try {
          const created = await api.org.createUnit(companyId, {
            name: spec.name,
            slug: spec.slug,
            kind: spec.kind,
            parentId: parent?.id ?? null,
          });
          unitBySlug.set(created.slug.toLowerCase(), created);
          unitBySlug.set(created.name.toLowerCase(), created);
          push({ label: `birim ${spec.name}`, state: "ok" });
        } catch (err) {
          // slug çakışması (farklı ad, aynı slug) → var olanı çöz ve atla;
          // alt birimler ebeveyn olarak onu kullanabilsin
          const conflict = err instanceof AcosApiError && err.problem.status === 409;
          const existing = conflict
            ? (await api.org.listUnits(companyId)).find(
                (u) => u.slug.toLowerCase() === spec.slug.toLowerCase(),
              )
            : undefined;
          if (existing) {
            unitBySlug.set(existing.slug.toLowerCase(), existing);
            unitBySlug.set(spec.name.toLowerCase(), existing);
            push({ label: `birim ${spec.name}`, state: "ok", detail: "zaten var (slug) — atlandı" });
          } else {
            fail(`birim ${spec.name}`, err);
          }
        }
        pendingUnits.splice(i, 1);
        i--;
      }
    }
    for (const spec of pendingUnits) {
      push({ label: `birim ${spec.name}`, state: "error", detail: `ebeveyn '${spec.parent}' bulunamadı` });
    }

    // 2) pozisyonlar
    for (const spec of plan.positions) {
      if (positionByTitle.has(spec.title.toLowerCase())) {
        push({ label: `pozisyon ${spec.title}`, state: "ok", detail: "zaten var — atlandı" });
        continue;
      }
      try {
        const created = await api.org.createPosition(companyId, {
          title: spec.title,
          seniorityTrack: ["junior", "mid", "senior", "staff", "lead", "expert"],
          defaultRole: spec.defaultRole,
        });
        positionByTitle.set(created.title.toLowerCase(), created);
        push({ label: `pozisyon ${spec.title}`, state: "ok" });
      } catch (err) {
        fail(`pozisyon ${spec.title}`, err);
      }
    }

    // 3) ajanlar — yöneticiler önce (dosya içi zincir; mevcut ajan da olabilir)
    const pendingAgents = [...plan.agents];
    guard = pendingAgents.length + 1;
    while (pendingAgents.length > 0 && guard-- > 0) {
      for (let i = 0; i < pendingAgents.length; i++) {
        const spec = pendingAgents[i]!;
        const manager = spec.manager ? agentByName.get(spec.manager.toLowerCase()) : null;
        if (spec.manager && !manager) {
          const managerInFile = pendingAgents.some(
            (a) => a.name.toLowerCase() === spec.manager!.toLowerCase(),
          );
          if (managerInFile) continue; // yöneticisi sonraki turda işe alınacak
        }
        pendingAgents.splice(i, 1);
        i--;
        if (agentByName.has(spec.name.toLowerCase())) {
          push({ label: `ajan ${spec.name}`, state: "ok", detail: "zaten var — atlandı" });
          continue;
        }
        const unit = unitBySlug.get(spec.unit.toLowerCase());
        const position = positionByTitle.get(spec.position.toLowerCase());
        if (!unit || !position) {
          push({
            label: `ajan ${spec.name}`,
            state: "error",
            detail: !unit ? `birim '${spec.unit}' yok` : `pozisyon '${spec.position}' yok`,
          });
          continue;
        }
        if (spec.manager && !manager) {
          push({ label: `ajan ${spec.name}`, state: "error", detail: `yönetici '${spec.manager}' bulunamadı` });
          continue;
        }
        try {
          const hired = await api.agents.hire(companyId, {
            name: spec.name,
            positionId: position.id,
            orgUnitId: unit.id,
            seniority: spec.seniority,
            autonomyLevel: spec.autonomyLevel,
            persona: spec.persona,
            managerAgentId: manager?.id ?? null,
            leadsUnit: spec.leadsUnit,
            activate: spec.activate,
            ...(spec.expertise.length > 0 && { expertise: spec.expertise }),
          });
          agentByName.set(hired.name.toLowerCase(), hired);
          push({ label: `ajan ${spec.name}`, state: "ok", detail: `${spec.position} · ${unit.name}` });
        } catch (err) {
          fail(`ajan ${spec.name}`, err);
        }
      }
    }

    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.agents(companyId) }),
      queryClient.invalidateQueries({ queryKey: keys.orgUnits(companyId) }),
      queryClient.invalidateQueries({ queryKey: keys.orgPositions(companyId) }),
      queryClient.invalidateQueries({ queryKey: keys.orgEdges(companyId) }),
    ]);
    setRunning(false);
    setFinished(true);
  }

  const okCount = steps.filter((s) => s.state === "ok").length;
  const errCount = steps.filter((s) => s.state === "error").length;

  return (
    <Dialog open title="Organizasyonu içe aktar (JSON / CSV)" onClose={onClose}>
      <div className="space-y-3" data-testid="org-import-modal">
        {!finished && (
          <>
            <p className="text-xs text-acos-fg1">
              JSON tam şemayı destekler (birimler + pozisyonlar + ajanlar, yönetici zinciriyle);
              CSV yalnız ajan satırlarını (başlıklar:{" "}
              <code>name,position,unit,manager,seniority,autonomyLevel,persona,expertise</code>).
              Şablonu kopyalayıp web Claude&apos;a &quot;bana şu işi yapacak bir organizasyon kur&quot;
              diyerek doldurtabilirsiniz — çıktıyı buraya yapıştırın.
            </p>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                onClick={() => void navigator.clipboard.writeText(IMPORT_TEMPLATE)}
                data-testid="org-import-copy-template"
              >
                Şablonu kopyala
              </Button>
              <label className="inline-flex cursor-pointer items-center rounded-md bg-acos-bg2 px-3 py-1.5 text-sm text-acos-fg0 hover:bg-acos-line">
                Dosya yükle…
                <input
                  type="file"
                  accept=".json,.csv,application/json,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    void file.text().then(setText);
                  }}
                />
              </label>
            </div>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={12}
              placeholder='{"units": […], "positions": […], "agents": […]}  —  ya da CSV yapıştırın'
              className="font-mono text-xs"
              data-testid="org-import-text"
            />
            {text.trim() !== "" && (
              <div className="rounded border border-acos-line bg-acos-bg1 px-3 py-2 text-xs" data-testid="org-import-preview">
                <p className="text-acos-fg0">
                  Önizleme: <strong>{plan.units.length}</strong> birim ·{" "}
                  <strong>{plan.positions.length}</strong> pozisyon ·{" "}
                  <strong>{plan.agents.length}</strong> ajan
                </p>
                {problems.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-danger">
                    {problems.slice(0, 8).map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}

        <ImportLog steps={steps} />

        <div className="flex items-center justify-end gap-2">
          {finished && (
            <span className="mr-auto text-xs text-acos-fg1" data-testid="org-import-summary">
              Bitti: {okCount} başarılı, {errCount} hatalı
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            {finished ? "Kapat" : "Vazgeç"}
          </Button>
          {!finished && (
            <Button
              disabled={!parsed || problems.length > 0 || running}
              onClick={() => void runImport()}
              data-testid="org-import-run"
            >
              {running ? "Kuruluyor…" : "İçe aktar"}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Yalnız birim toplu içe aktarma — Birimler kartındaki hızlı yol. Ebeveynler
 *  önce kurulur (dosya içi referans + mevcut birimler); var olanlar atlanır. */
export function UnitImportModal({ companyId, onClose }: { companyId: string; onClose: () => void }) {
  const [text, setText] = useState("");
  const [steps, setSteps] = useState<StepState[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);

  const { units: specs, problems } = useMemo(() => parseUnits(text), [text]);

  async function run(): Promise<void> {
    setRunning(true);
    const log: StepState[] = [];
    const push = (s: StepState) => {
      log.push(s);
      setSteps([...log]);
    };
    // mevcut birimler çalıştırma anında taze çekilir (bkz. OrgImportModal notu)
    const byRef = new Map<string, string>();
    for (const u of await api.org.listUnits(companyId)) {
      byRef.set(u.slug.toLowerCase(), u.id);
      byRef.set(u.name.toLowerCase(), u.id);
    }
    const pending = [...specs];
    let guard = pending.length + 1;
    while (pending.length > 0 && guard-- > 0) {
      for (let i = 0; i < pending.length; i++) {
        const spec = pending[i]!;
        if (byRef.has(spec.slug.toLowerCase()) || byRef.has(spec.name.toLowerCase())) {
          push({ label: spec.name, state: "ok", detail: "zaten var — atlandı" });
          pending.splice(i, 1);
          i--;
          continue;
        }
        const parent = spec.parent ? byRef.get(spec.parent.toLowerCase()) : null;
        if (spec.parent && !parent) continue; // ebeveyn sonraki turda
        try {
          const created = await api.org.createUnit(companyId, {
            name: spec.name,
            slug: spec.slug,
            kind: spec.kind,
            parentId: parent ?? null,
          });
          byRef.set(created.slug.toLowerCase(), created.id);
          byRef.set(created.name.toLowerCase(), created.id);
          push({ label: `${spec.name} (${spec.kind})`, state: "ok" });
        } catch (err) {
          const conflict = err instanceof AcosApiError && err.problem.status === 409;
          const existing = conflict
            ? (await api.org.listUnits(companyId)).find(
                (u) => u.slug.toLowerCase() === spec.slug.toLowerCase(),
              )
            : undefined;
          if (existing) {
            byRef.set(existing.slug.toLowerCase(), existing.id);
            byRef.set(spec.name.toLowerCase(), existing.id);
            push({ label: spec.name, state: "ok", detail: "zaten var (slug) — atlandı" });
          } else {
            push({ label: spec.name, state: "error", detail: problemDetail(err) });
          }
        }
        pending.splice(i, 1);
        i--;
      }
    }
    for (const spec of pending) {
      push({ label: spec.name, state: "error", detail: `üst birim '${spec.parent}' bulunamadı` });
    }
    await queryClient.invalidateQueries({ queryKey: keys.orgUnits(companyId) });
    setRunning(false);
    setFinished(true);
  }

  const okCount = steps.filter((s) => s.state === "ok").length;
  const errCount = steps.filter((s) => s.state === "error").length;

  return (
    <Dialog open title="Birimleri toplu içe aktar" onClose={onClose}>
      <div className="space-y-3" data-testid="unit-import-modal">
        {!finished && (
          <>
            <p className="text-xs text-acos-fg1">
              Satır başına <code>Ad, tür, ÜstBirim</code> — tür{" "}
              <code>departman · takım · ofis · bölüm</code> (boşsa departman), üst birim ad/slug
              (boşsa en üst seviye). JSON dizisi de kabul edilir. Var olan birimler atlanır.
            </p>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={6}
              placeholder={"Engineering, departman\nBackend, takım, Engineering\nİstanbul Ofisi, ofis"}
              className="font-mono text-xs"
              data-testid="unit-import-text"
            />
            {text.trim() !== "" && (
              <p className="text-xs text-acos-fg1" data-testid="unit-import-preview">
                Önizleme: <strong>{specs.length}</strong> birim
                {problems.length > 0 && <span className="text-danger"> · {problems[0]}</span>}
              </p>
            )}
          </>
        )}

        <ImportLog steps={steps} />

        <div className="flex items-center justify-end gap-2">
          {finished && (
            <span className="mr-auto text-xs text-acos-fg1" data-testid="unit-import-summary">
              Bitti: {okCount} başarılı, {errCount} hatalı
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            {finished ? "Kapat" : "Vazgeç"}
          </Button>
          {!finished && (
            <Button
              disabled={specs.length === 0 || problems.length > 0 || running}
              onClick={() => void run()}
              data-testid="unit-import-run"
            >
              {running ? "Kuruluyor…" : "İçe aktar"}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Yalnız rol/pozisyon toplu içe aktarma — Pozisyonlar kartındaki hızlı yol. */
export function PositionImportModal({
  companyId,
  onClose,
}: {
  companyId: string;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [steps, setSteps] = useState<StepState[]>([]);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);

  const { positions: specs, problems } = useMemo(() => parsePositions(text), [text]);

  async function run(): Promise<void> {
    setRunning(true);
    const log: StepState[] = [];
    const push = (s: StepState) => {
      log.push(s);
      setSteps([...log]);
    };
    // mevcut pozisyonlar çalıştırma anında taze çekilir
    const existing = new Set(
      (await api.org.listPositions(companyId)).map((p) => p.title.toLowerCase()),
    );
    for (const spec of specs) {
      if (existing.has(spec.title.toLowerCase())) {
        push({ label: spec.title, state: "ok", detail: "zaten var — atlandı" });
        continue;
      }
      try {
        await api.org.createPosition(companyId, {
          title: spec.title,
          seniorityTrack: ["junior", "mid", "senior", "staff", "lead", "expert"],
          defaultRole: spec.defaultRole,
        });
        existing.add(spec.title.toLowerCase());
        push({ label: spec.title, state: "ok", detail: spec.defaultRole });
      } catch (err) {
        push({ label: spec.title, state: "error", detail: problemDetail(err) });
      }
    }
    await queryClient.invalidateQueries({ queryKey: keys.orgPositions(companyId) });
    setRunning(false);
    setFinished(true);
  }

  const okCount = steps.filter((s) => s.state === "ok").length;
  const errCount = steps.filter((s) => s.state === "error").length;

  return (
    <Dialog open title="Rolleri toplu içe aktar" onClose={onClose}>
      <div className="space-y-3" data-testid="position-import-modal">
        {!finished && (
          <>
            <p className="text-xs text-acos-fg1">
              JSON dizisi <code>[{"{"}&quot;title&quot;, &quot;defaultRole&quot;{"}"}…]</code> ya da satır
              başına <code>Unvan, rol</code> (rol boşsa <code>member</code>). Roller:{" "}
              <code>executive · manager · lead · member · reviewer</code>. Var olan unvanlar atlanır.
            </p>
            <Button
              variant="secondary"
              onClick={() => void navigator.clipboard.writeText(POSITION_TEMPLATE)}
              data-testid="position-import-copy-template"
            >
              Şablonu kopyala
            </Button>
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder={'Backend Engineer, member\nQA/Reviewer, reviewer\nDevOps Lead, lead'}
              className="font-mono text-xs"
              data-testid="position-import-text"
            />
            {text.trim() !== "" && (
              <div className="rounded border border-acos-line bg-acos-bg1 px-3 py-2 text-xs" data-testid="position-import-preview">
                <p className="text-acos-fg0">
                  Önizleme: <strong>{specs.length}</strong> rol
                </p>
                {problems.length > 0 && (
                  <ul className="mt-1 list-disc pl-4 text-danger">
                    {problems.slice(0, 8).map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}

        <ImportLog steps={steps} />

        <div className="flex items-center justify-end gap-2">
          {finished && (
            <span className="mr-auto text-xs text-acos-fg1" data-testid="position-import-summary">
              Bitti: {okCount} başarılı, {errCount} hatalı
            </span>
          )}
          <Button variant="ghost" onClick={onClose}>
            {finished ? "Kapat" : "Vazgeç"}
          </Button>
          {!finished && (
            <Button
              disabled={specs.length === 0 || problems.length > 0 || running}
              onClick={() => void run()}
              data-testid="position-import-run"
            >
              {running ? "Ekleniyor…" : "İçe aktar"}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
