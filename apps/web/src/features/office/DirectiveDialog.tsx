// Founder direktifi — hedefi CEO'ya TEK adımda ver.
//
// Neden var: eski yol beş işlemdi (görev oluştur → BACKLOG → PLANNED → 32
// ajanlık düz listeden CEO'yu bul → ata) ve hiçbir ekran "şirketin tepesi bu
// kişi" demiyordu. Founder "yeni işi nereden veriyorum" sorusuna cevap
// bulamıyordu. Burada tek form var; sunucu aynı YASAL geçişleri sırayla
// yürütür (07 §2 durum makinesi ve §5 izin matrisi atlanmaz).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AcosApiError } from "@acos/contracts/client";
import type { Task } from "@acos/contracts";
import { Button, Dialog, Field, Input, Select, Textarea } from "@acos/ui";
import { api } from "../../lib/api.js";

export function DirectiveDialog({
  companyId,
  executive,
  open,
  onClose,
}: {
  companyId: string;
  executive: { name: string; positionTitle: string };
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [priority, setPriority] = useState("P1");
  // 2026-08-18: hedef bir projeye bağlanır — alt görevler kalıtır ve kodlama
  // ajanları "no project" duvarına çarpmaz. Boş bırakılabilir.
  const [projectId, setProjectId] = useState("");
  const projectsQuery = useQuery({
    queryKey: [companyId, "projects", "list"],
    queryFn: () => api.projects.list(companyId),
    enabled: open,
  });
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Task | null>(null);

  const submit = useMutation({
    mutationFn: () =>
      api.tasks.directive(companyId, {
        title,
        objective,
        priority,
        ...(projectId && { projectId }),
      }),
    onSuccess: (task) => {
      setError(null);
      setCreated(task);
      setTitle("");
      setObjective("");
      void queryClient.invalidateQueries({ queryKey: [companyId, "tasks"] });
    },
    onError: (err) =>
      setError(
        err instanceof AcosApiError ? `${err.problem.code}: ${err.problem.detail}` : String(err),
      ),
  });

  if (!open) return null;
  return (
    <Dialog open onClose={onClose} title={`${executive.name}'e görev ver`}>
      <div className="space-y-3">
        <p className="text-xs text-acos-fg2">
          Hedef doğrudan {executive.positionTitle} olarak {executive.name}'e atanır ve çalışma
          döngüsü hemen başlar. Kırılımı (initiative → epic → task) ekibiyle birlikte o yapar.
        </p>

        {created ? (
          <div
            className="rounded-md border border-acos-line bg-acos-bg2 p-3 text-xs text-acos-fg1"
            data-testid="directive-created"
          >
            <p className="font-medium text-acos-fg0">
              {created.displayNumber} oluşturuldu ve {executive.name}'e atandı.
            </p>
            <p className="mt-1 text-acos-fg2">Durum: {created.status}</p>
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" onClick={() => setCreated(null)}>
                Bir tane daha ver
              </Button>
              <Button variant="ghost" onClick={onClose} data-testid="directive-close">
                Kapat
              </Button>
            </div>
          </div>
        ) : (
          <>
            <Field label="Başlık">
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                name="directiveTitle"
                placeholder="Örn. ACOS tanıtım sayfası"
              />
            </Field>
            <Field label="Hedef">
              <Textarea
                value={objective}
                onChange={(e) => setObjective(e.target.value)}
                name="directiveObjective"
                rows={5}
                placeholder="Ne istediğinizi ve neyin başarı sayıldığını yazın."
              />
            </Field>
            <Field label="Proje (kod üretilecekse seçin)">
              <Select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                name="directiveProject"
                data-testid="directive-project"
              >
                <option value="">— proje yok (kod gerektirmeyen hedef) —</option>
                {(projectsQuery.data?.items ?? []).map((proj) => (
                  <option key={proj.id} value={proj.id}>
                    {proj.name}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-[10px] text-acos-fg2">
                Proje seçilirse tüm alt görevler bu projenin reposunda çalışır; GitHub
                bağlıysa merge'ler otomatik yayınlanır. Yeni proje: Projeler sekmesi.
              </p>
            </Field>
            <div className="w-28">
              <Field label="Öncelik">
                <Select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  name="directivePriority"
                >
                  {["P0", "P1", "P2", "P3"].map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </Select>
              </Field>
            </div>

            {error && (
              <p
                className="rounded bg-danger/10 px-2 py-1 text-xs text-danger"
                data-testid="directive-error"
              >
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Vazgeç
              </Button>
              <Button
                disabled={!title.trim() || !objective.trim() || submit.isPending}
                onClick={() => submit.mutate()}
                data-testid="directive-submit"
              >
                {submit.isPending ? "Gönderiliyor…" : "Görevi ver"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
