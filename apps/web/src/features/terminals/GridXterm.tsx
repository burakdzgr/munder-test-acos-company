// Salt-okunur xterm hücre gövdesi (T41). TerminalGrid'in PTY hücresi ve
// AgentSessionCell'in "Kabuk" sekmesi (LIVE-CONSOLE TASK 1) paylaşır —
// gerçek sandbox PTY akışı: ring replay + terminal:<sessionId> canlı frame.
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalSessionDto } from "@acos/contracts";
import { clearTopicCursor, getRealtimeClient } from "../../realtime/client.js";

export function base64ToUtf8(data: string): string {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export interface TerminalFrame {
  seq: number;
  ts: number;
  stream: string;
  data: string;
}

/** Compact read-only xterm cell body — refits on container resize. */
export function GridXterm({ session, fontSize }: { session: TerminalSessionDto; fontSize: number }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      convertEol: true,
      disableStdin: true, // read-only observability (24 §6.9)
      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
      fontSize,
      theme: { background: "#06080b" },
      cols: session.cols,
      rows: session.rows,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    // dockview panes resize without a window resize event
    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(host);

    const client = getRealtimeClient();
    // fresh cell = no scrollback: take the FULL ring, not a cursor resume
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
      term.scrollToBottom();
    });

    return () => {
      unsubscribe();
      observer.disconnect();
      term.dispose();
    };
  }, [session.id, session.cols, session.rows, fontSize]);

  return <div ref={hostRef} data-testid="grid-xterm-host" className="h-full min-h-0 flex-1" />;
}
