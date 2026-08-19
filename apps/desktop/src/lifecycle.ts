// Backend lifecycle helper (36 §11 — U13b, off the critical path): health
// probe + docker compose start/stop from the main process. The stack stays
// containerized — Electron orchestrates it, never replaces it. With
// ACOS_BASE_URL pointing at an already-running stack the boot step is
// skipped entirely.
import { spawn } from "node:child_process";
import { composeArgs } from "./config.js";

export async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(4000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function waitForHealth(
  baseUrl: string,
  timeoutMs: number,
  onTick?: (elapsedMs: number) => void,
): Promise<boolean> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const probe = async () => {
      if (await checkHealth(baseUrl)) return resolve(true);
      const elapsed = Date.now() - startedAt;
      onTick?.(elapsed);
      if (elapsed >= timeoutMs) return resolve(false);
      setTimeout(() => void probe(), 2000);
    };
    void probe();
  });
}

export interface ComposeResult {
  ok: boolean;
  output: string;
}

/** Run a docker compose action; resolves with captured output (never throws). */
export function runCompose(
  composeFile: string,
  action: "up" | "stop" | "logs",
): Promise<ComposeResult> {
  return new Promise((resolve) => {
    const child = spawn("docker", composeArgs(composeFile, action), {
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (err) => resolve({ ok: false, output: String(err) }));
    child.on("close", (code) => resolve({ ok: code === 0, output }));
  });
}

export async function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
