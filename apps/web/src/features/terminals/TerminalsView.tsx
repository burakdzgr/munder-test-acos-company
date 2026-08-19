// Terminals view — /c/$companyId/terminals (24 §6.9, T41): REAL sandbox
// terminal observability, never simulated. Session list (workspace, task,
// agent, isolation, status) → attach pane: read-only xterm.js fed by the WS
// `terminal:<sessionId>` topic — ring replay first, then live PTY frames;
// `gap` control frames render a truncation marker. Founder/admin only (the
// route guard mirrors the topic authz).
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Button, Card, StatusPill, cn } from "@acos/ui";
import type { TerminalSessionDto } from "@acos/contracts";
import { api } from "../../lib/api.js";
import { clearTopicCursor, getRealtimeClient } from "../../realtime/client.js";

function base64ToUtf8(data: string): string {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

interface TerminalFrame {
  seq: number;
  ts: number;
  stream: string;
  data: string;
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function AttachedTerminal({ session }: { session: TerminalSessionDto }) {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  followRef.current = follow;
  // REVISION TASK 2 — agent_control ↔ human_control
  const [control, setControl] = useState<"agent" | "human">("agent");
  const controlRef = useRef<"agent" | "human">("agent");
  controlRef.current = control;

  const takeControl = async () => {
    await api.terminals.control(companyId, session.id, "human");
    const term = termRef.current;
    await api.terminals.openShell(companyId, session.id, {
      cols: term?.cols ?? session.cols,
      rows: term?.rows ?? session.rows,
    });
    if (term) term.options.disableStdin = false;
    setControl("human");
    term?.writeln(`\r\n\x1b[36m— kontrol sende (human_control) — yazabilirsin —\x1b[0m`);
    term?.focus();
  };

  // REVISION TASK 3 — Open Preview: workspace'te dinleyen portları keşfet,
  // çalışan web uygulamasını yeni sekmede aç
  const openPreview = async () => {
    const term = termRef.current;
    try {
      const result = await api.terminals.workspacePorts(companyId, session.workspaceId);
      if (result.ports.length === 0) {
        term?.writeln(`\r\n\x1b[33m— preview: dinleyen port bulunamadı —\x1b[0m`);
        return;
      }
      const [first, ...rest] = result.ports;
      term?.writeln(
        `\r\n\x1b[36m— preview: :${first!.port} açılıyor${
          rest.length > 0 ? ` (diğer portlar: ${rest.map((p) => p.port).join(", ")})` : ""
        } —\x1b[0m`,
      );
      window.open(first!.previewUrl, "_blank", "noopener");
    } catch {
      term?.writeln(`\r\n\x1b[31m— preview: port keşfi başarısız —\x1b[0m`);
    }
  };

  const returnControl = async () => {
    await api.terminals.control(companyId, session.id, "agent");
    const term = termRef.current;
    if (term) term.options.disableStdin = true;
    setControl("agent");
    term?.writeln(`\r\n\x1b[2m— kontrol ajanda (agent_control) —\x1b[0m`);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      convertEol: true,
      disableStdin: true, // agent_control varsayılanı — takeover ile açılır
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize: 12,
      theme: { background: "#0b0e14" },
      cols: session.cols,
      rows: session.rows,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    const onResize = () => {
      fit.fit();
      if (controlRef.current === "human") {
        void api.terminals
          .resize(companyId, session.id, { cols: term.cols, rows: term.rows })
          .catch(() => {});
      }
    };
    window.addEventListener("resize", onResize);
    // human_control iken tuş vuruşları PTY stdin'e akar
    const dataSub = term.onData((data) => {
      if (controlRef.current !== "human") return;
      void api.terminals.write(companyId, session.id, utf8ToBase64(data)).catch(() => {});
    });
    term.writeln(`\x1b[2m— ${session.title} oturumuna bağlanıldı —\x1b[0m`);

    const client = getRealtimeClient();
    // fresh pane = no scrollback: take the FULL ring, not a cursor resume
    clearTopicCursor(`terminal:${session.id}`);
    const unsubscribe = client.subscribe(`terminal:${session.id}`, (frames, meta) => {
      if (meta.kind === "gap") {
        term.writeln(`\r\n\x1b[33m--- çıktı kırpıldı ---\x1b[0m`);
        return;
      }
      for (const raw of frames) {
        const frame = raw as TerminalFrame;
        if (typeof frame?.data !== "string") continue;
        term.write(base64ToUtf8(frame.data));
      }
      if (followRef.current) term.scrollToBottom();
    });

    return () => {
      unsubscribe();
      dataSub.dispose();
      window.removeEventListener("resize", onResize);
      termRef.current = null;
      term.dispose();
    };
  }, [companyId, session.id, session.cols, session.rows, session.title]);

  return (
    <Card className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <div className="flex items-center gap-2">
        <code className="text-xs text-acos-fg1">{session.title}</code>
        <StatusPill tone={session.status === "active" ? "ok" : "neutral"}>
          {session.status}
        </StatusPill>
        {session.branch && <code className="text-xs text-acos-fg2">{session.branch}</code>}
        <div className="ml-auto flex items-center gap-2">
          {session.status === "active" && (
            <Button variant="ghost" onClick={() => void openPreview()} data-testid="open-preview">
              🌐 Preview
            </Button>
          )}
          {session.status === "active" &&
            (control === "agent" ? (
              <Button variant="ghost" onClick={() => void takeControl()} data-testid="take-control">
                🎮 Kontrolü al
              </Button>
            ) : (
              <Button
                variant="ghost"
                onClick={() => void returnControl()}
                data-testid="return-control"
              >
                ↩ Kontrolü ver
              </Button>
            ))}
          <Button
            variant="ghost"
            onClick={() => setFollow((v) => !v)}
            data-testid="follow-toggle"
          >
            {follow ? "⏸ takip" : "▶ takip"}
          </Button>
          <a
            href={api.terminals.logUrl(companyId, session.id)}
            download
            className="text-xs text-accent-600 hover:underline"
          >
            log indir
          </a>
        </div>
      </div>
      <div
        ref={hostRef}
        data-testid="xterm-host"
        className="min-h-[420px] flex-1 overflow-hidden rounded bg-[#0b0e14] p-1"
      />
    </Card>
  );
}

export function TerminalsView() {
  const { companyId } = useParams({ from: "/c/$companyId" });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: [companyId, "terminals"],
    queryFn: () => api.terminals.list(companyId, { limit: 100 }),
    refetchInterval: 10_000,
  });

  const items = sessions.data?.items ?? [];
  const selected = useMemo(
    () => items.find((s) => s.id === selectedId) ?? null,
    [items, selectedId],
  );

  return (
    <div className="flex h-full min-h-0 gap-3 p-3">
      <Card className="flex w-80 shrink-0 flex-col gap-1 overflow-y-auto p-2">
        <h2 className="px-1 py-1 text-xs font-semibold uppercase tracking-wide text-acos-fg2">
          Terminal oturumları
        </h2>
        {sessions.isLoading && <div className="p-2 text-sm text-acos-fg2">Yükleniyor…</div>}
        {!sessions.isLoading && items.length === 0 && (
          <div className="p-2 text-sm text-acos-fg2" data-testid="terminals-empty">
            Aktif oturum yok.
          </div>
        )}
        {items.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelectedId(s.id)}
            data-testid="terminal-session-row"
            className={cn(
              "rounded px-2 py-1.5 text-left text-sm hover:bg-acos-bg3",
              selectedId === s.id && "bg-acos-bg2",
            )}
          >
            <div className="flex items-center gap-2">
              <StatusPill tone={s.status === "active" ? "ok" : "neutral"}>{s.status}</StatusPill>
              <span className="truncate font-medium">{s.title}</span>
            </div>
            <div className="mt-0.5 flex gap-2 text-xs text-acos-fg2">
              {s.taskNumber !== null && <span>TASK-{s.taskNumber}</span>}
              {s.agentName && <span>{s.agentName}</span>}
              {s.isolationLevel && <span>{s.isolationLevel}</span>}
              <time className="ml-auto tabular-nums">
                {new Date(s.createdAt).toLocaleTimeString()}
              </time>
            </div>
          </button>
        ))}
      </Card>
      {selected ? (
        <AttachedTerminal key={selected.id} session={selected} />
      ) : (
        <Card className="flex flex-1 items-center justify-center text-sm text-acos-fg2">
          Bağlanmak için oturum seçin.
        </Card>
      )}
    </div>
  );
}
