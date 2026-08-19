// Approval Center (19 §11, 24 §6, T35): pending inbox sorted urgency-first
// with time-to-expiry bars, the 11 typed brief fields in fixed order (no raw
// markdown passthrough — 19 §10), options comparison table, endorsement
// chain timeline, one-click verdicts (note required for REJECT / REQUEST
// EXECUTIVE REVIEW) and a History tab over decided requests.
import { useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AcosApiError } from "@acos/contracts/client";
import type { Approval, ApprovalDetail } from "@acos/contracts";
import { Button, Card, MoneyText, StatusPill, Textarea, cn, type PillTone } from "@acos/ui";
import { api, keys } from "../../lib/api.js";

const URGENCY_TONE: Record<Approval["urgency"], PillTone> = {
  critical: "danger",
  high: "warn",
  normal: "neutral",
  low: "neutral",
};
const STATUS_TONE: Record<Approval["status"], PillTone> = {
  pending: "warn",
  approved: "ok",
  rejected: "danger",
  needs_review: "accent",
  expired: "neutral",
};

function ExpiryBar({ approval }: { approval: Approval }) {
  const created = new Date(approval.createdAt).getTime();
  const expires = new Date(approval.expiresAt).getTime();
  const now = Date.now();
  const ratio = Math.min(Math.max((now - created) / Math.max(expires - created, 1), 0), 1);
  const hoursLeft = Math.max(Math.round((expires - now) / 3_600_000), 0);
  return (
    <div className="flex items-center gap-2" title={`bitiş: ${new Date(expires).toLocaleString()}`}>
      <div className="h-1.5 w-24 overflow-hidden rounded bg-acos-bg2">
        <div
          className={cn("h-full", ratio > 0.85 ? "bg-red-500" : ratio > 0.5 ? "bg-amber-500" : "bg-emerald-500")}
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
      <span className="text-xs text-acos-fg2">{hoursLeft} sa kaldı</span>
    </div>
  );
}

const BRIEF_SECTIONS: Array<{ key: "request" | "reason" | "recommendation" | "risk" | "impact" | "urgency"; label: string }> = [
  { key: "request", label: "Talep" },
  { key: "reason", label: "Gerekçe" },
  { key: "recommendation", label: "Öneri" },
  { key: "risk", label: "Risk" },
  { key: "impact", label: "Etki" },
  { key: "urgency", label: "Aciliyet" },
];

function BriefPanel({ detail }: { detail: ApprovalDetail }) {
  const brief = detail.brief;
  return (
    <div className="space-y-3 text-sm">
      {BRIEF_SECTIONS.slice(0, 2).map(({ key, label }) => (
        <section key={key}>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-acos-fg1">{label}</h4>
          <p className="whitespace-pre-wrap text-acos-fg0">{brief[key]}</p>
        </section>
      ))}
      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-acos-fg1">
          Otonom denendi
        </h4>
        <ul className="list-disc pl-5 text-acos-fg0">
          {brief.attempted.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      </section>
      <section>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-acos-fg1">Seçenekler</h4>
        <table className="mt-1 w-full text-left text-xs">
          <thead>
            <tr className="text-acos-fg1">
              <th className="py-1 pr-2 font-medium">Seçenek</th>
              <th className="py-1 pr-2 font-medium">Artılar</th>
              <th className="py-1 pr-2 font-medium">Eksiler</th>
              <th className="py-1 font-medium">Maliyet</th>
            </tr>
          </thead>
          <tbody>
            {brief.options.map((option, i) => (
              <tr key={i} className="border-t border-acos-line align-top">
                <td className="py-1 pr-2 text-acos-fg0">{option.option}</td>
                <td className="py-1 pr-2 text-acos-fg1">{option.pros || "—"}</td>
                <td className="py-1 pr-2 text-acos-fg1">{option.cons || "—"}</td>
                <td className="py-1 text-acos-fg0">
                  <MoneyText cents={option.cost_cents} currency={brief.cost.currency} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {BRIEF_SECTIONS.slice(2).map(({ key, label }) => (
        <section key={key}>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-acos-fg1">{label}</h4>
          <p className="whitespace-pre-wrap text-acos-fg0">{brief[key]}</p>
        </section>
      ))}
      <section className="flex flex-wrap gap-4 text-xs text-acos-fg1">
        <span>
          Maliyet: <MoneyText cents={brief.cost.amount_cents} currency={brief.cost.currency} />
          {brief.cost.period ? ` / ${brief.cost.period}` : ""}
        </span>
        {brief.cost.budget_line && <span>Bütçe kalemi: {brief.cost.budget_line}</span>}
        <span>Son tarih: {brief.deadline ? new Date(brief.deadline).toLocaleString() : "—"}</span>
      </section>
    </div>
  );
}

function ChainTimeline({ detail }: { detail: ApprovalDetail }) {
  return (
    <ol className="space-y-2 border-l border-acos-line pl-4 text-sm">
      {detail.chain.map((entry, i) => (
        <li key={i} className="relative">
          <span className="absolute -left-[1.15rem] top-1.5 h-2 w-2 rounded-full bg-acos-fg2" />
          <span className="font-medium text-acos-fg0">{entry.verdict}</span>
          <span className="ml-2 text-xs text-acos-fg2">{new Date(entry.at).toLocaleString()}</span>
          {entry.note && <p className="text-acos-fg1">{entry.note}</p>}
        </li>
      ))}
    </ol>
  );
}

function ApprovalCard({
  approval,
  companyId,
}: {
  approval: Approval;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: [companyId, "approvals", "detail", approval.id],
    queryFn: () => api.approvals.get(companyId, approval.id),
    enabled: open,
  });

  const verdict = useMutation({
    mutationFn: (v: "approved" | "rejected" | "needs_review") =>
      api.approvals.verdict(companyId, approval.id, {
        verdict: v,
        ...(note.trim() && { note: note.trim() }),
      }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: [companyId, "approvals"] });
    },
    onError: (err) => {
      setError(err instanceof AcosApiError ? `${err.problem.code}: ${err.problem.detail}` : String(err));
    },
  });

  const pending = approval.status === "pending";
  const needsNote = note.trim().length === 0;

  return (
    <Card className="p-4" data-testid={`approval-${approval.id}`}>
      <button className="flex w-full items-start justify-between gap-3 text-left" onClick={() => setOpen(!open)}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={STATUS_TONE[approval.status]}>{approval.status}</StatusPill>
            <StatusPill tone="neutral">{approval.kind}</StatusPill>
            <StatusPill tone={URGENCY_TONE[approval.urgency]}>{approval.urgency}</StatusPill>
            <span className="truncate font-medium text-acos-fg0">{approval.title}</span>
          </div>
          <p className="mt-1 text-xs text-acos-fg1">
            #{approval.number} · talep eden: {approval.requesterName ?? "bilinmeyen ajan"} ·{" "}
            {new Date(approval.createdAt).toLocaleString()}
            {approval.costCents !== null && approval.costCents > 0 && (
              <>
                {" · "}
                <MoneyText cents={approval.costCents} currency={approval.brief.cost.currency} />
              </>
            )}
          </p>
        </div>
        {pending && <ExpiryBar approval={approval} />}
      </button>

      {open && (
        <div className="mt-4 space-y-4 border-t border-acos-line pt-4">
          {detail.data ? (
            <>
              <BriefPanel detail={detail.data} />
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-acos-fg1">
                  Onay zinciri
                </h4>
                <ChainTimeline detail={detail.data} />
              </div>
              {detail.data.task && (
                <p className="text-xs text-acos-fg1">
                  Bağlı görev: TASK-{detail.data.task.number} · {detail.data.task.title} (
                  {detail.data.task.status})
                </p>
              )}
              {detail.data.decisionNote && (
                <p className="text-sm text-acos-fg1">
                  <span className="font-medium">Karar notu:</span> {detail.data.decisionNote}
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-acos-fg2">Brief yükleniyor…</p>
          )}

          {pending && (
            <div className="space-y-2">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Karar notu (RED / YÖNETİCİ İNCELEMESİ için zorunlu)"
                rows={2}
                name="decisionNote"
              />
              {error && <p className="text-xs text-red-600">{error}</p>}
              <div className="flex gap-2">
                <Button onClick={() => verdict.mutate("approved")} disabled={verdict.isPending} data-testid="approve">
                  ONAYLA
                </Button>
                <Button
                  variant="danger"
                  onClick={() => verdict.mutate("rejected")}
                  disabled={verdict.isPending || needsNote}
                  data-testid="reject"
                >
                  REDDET
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => verdict.mutate("needs_review")}
                  disabled={verdict.isPending || needsNote}
                  data-testid="needs-review"
                >
                  YÖNETİCİ İNCELEMESİ
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export function ApprovalsView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [tab, setTab] = useState<"inbox" | "history">("inbox");

  const list = useQuery({
    queryKey: keys.approvals(companyId, tab),
    queryFn: () =>
      tab === "inbox"
        ? api.approvals.list(companyId, { status: "pending" })
        : api.approvals.list(companyId),
  });

  const items = (list.data ?? []).filter((a) => (tab === "inbox" ? a.status === "pending" : true));

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-lg font-semibold text-acos-fg0">Onay Merkezi</h1>
        {(["inbox", "history"] as const).map((t) => (
          <Button key={t} variant={tab === t ? "primary" : "ghost"} onClick={() => setTab(t)} data-testid={`tab-${t}`}>
            {t === "inbox" ? "Gelen" : "Geçmiş"}
          </Button>
        ))}
      </div>
      {items.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} companyId={companyId} />
      ))}
      {items.length === 0 && (
        <Card className="p-8 text-center text-sm text-acos-fg2">
          {tab === "inbox"
            ? "Bekleyen onay yok — ajan eskalasyonları buraya yapılandırılmış brief olarak düşer."
            : "Henüz karara bağlanmış onay yok."}
        </Card>
      )}
    </div>
  );
}
