// sandbox-manager boot (T37). A small service OUTSIDE the control plane —
// it holds zero domain state (02 §3) and needs only its own handful of env
// vars, NOT the full control-plane config (which demands DB/master-key
// secrets the sandbox must never hold). NATS for terminal frames, the Docker
// socket for the container lifecycle (S1), a rolling per-session log on disk,
// and a periodic workspace GC.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Docker from "dockerode";
import { connect, type NatsConnection } from "nats";
import type { SandboxTerminalFrame } from "@acos/contracts";
import { buildApp } from "./app.js";
import { DockerSandbox } from "./docker.js";
import { DockerGitRunner, GitWorkspaces } from "./git.js";
import type { TerminalLogSink, TerminalTransport } from "./terminal.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    console.error(`sandbox-manager: missing required env ${name}`);
    process.exit(1);
  }
  return value;
}

const GC_INTERVAL_MS = 60_000;
const WORKSPACE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h orphan reaper [WRITER-DECISION]

async function main(): Promise<void> {
  const port = Number(process.env.SANDBOX_MANAGER_PORT ?? 3010);
  const internalApiToken = requireEnv("INTERNAL_API_TOKEN");
  const natsUrl = process.env.NATS_URL ?? "nats://localhost:4222";
  const dataDir = process.env.DATA_DIR ?? "./data";
  const terminalsDir = join(dataDir, "terminals");
  mkdirSync(terminalsDir, { recursive: true });

  const nats: NatsConnection | null = await connect({ servers: natsUrl }).catch((err: unknown) => {
    console.error(`sandbox-manager: NATS unavailable (${String(err)}) — terminal frames disabled`);
    return null;
  });

  const transport: TerminalTransport = {
    publish(sessionId: string, frame: SandboxTerminalFrame) {
      // ephemeral core NATS (22 §5.2): loss-tolerant, no JetStream
      nats?.publish(`term.${sessionId}`, JSON.stringify(frame));
    },
  };
  const logSink: TerminalLogSink = {
    append(sessionId: string, line: string) {
      try {
        appendFileSync(join(terminalsDir, `${sessionId}.log`), line + "\n");
      } catch {
        /* disk hiccup — frame already went to NATS; log is best-effort scrollback */
      }
    },
  };

  const docker = new Docker(); // default socket / named pipe (S1: only here)
  const sandbox = new DockerSandbox({
    docker,
    transport,
    logSink,
    nowMs: () => Date.now(),
    log: (msg, meta) => console.log(JSON.stringify({ msg, ...meta })),
  });

  const git = new GitWorkspaces(
    new DockerGitRunner({
      docker,
      log: (msg, meta) => console.log(JSON.stringify({ msg, ...meta })),
    }),
  );

  const { sweepOldLogs } = await import("./terminal-log.js");
  const gc = setInterval(() => {
    void sandbox.gc(WORKSPACE_MAX_AGE_MS).catch((err) => console.error("gc failed", err));
    // 7-day terminal log retention (_DECISIONS §16, T41)
    void sweepOldLogs(terminalsDir).catch((err) => console.error("log sweep failed", err));
  }, GC_INTERVAL_MS);

  const app = buildApp({ sandbox, git, internalApiToken, terminalsDir });

  const close = async () => {
    clearInterval(gc);
    await nats?.close().catch(() => {});
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);

  await app.listen({ port, host: "0.0.0.0" });
  app.log.info({ port, natsUrl, terminalsDir }, "sandbox-manager up");
}

main().catch((err) => {
  console.error("sandbox-manager boot failed:", err);
  process.exit(1);
});
