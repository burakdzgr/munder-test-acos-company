// Claude Code CLI köprüsü (2026-08-19, Founder kararı): host'ta çalışır,
// OpenAI-uyumlu /v1/chat/completions sunar ve her isteği `claude -p`
// (ABONELİK kimliği, API kredisi değil) ile cevaplar. Worker konteynerden
// http://host.docker.internal:3777/v1 üzerinden erişir — stack'e sıfır yeni
// protokol: mevcut OpenAI adaptörü kullanılır.
//
// Güvenlik/kapsam: --max-turns 1 + boş bir çalışma dizini → CLI araç
// kullanamaz (izin isteyecek etkileşim yok), saf metin tamamlama gibi davranır.
// Eşzamanlılık 2 ile sınırlı (abonelik kotasını tek hamlede yakmasın).
//
// Başlatma (host):  node scripts/claude-cli-bridge.mjs
// Ortam:  CLAUDE_BIN (varsayılan: VS Code eklentisindeki claude.exe)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 3777);
const CLAUDE_BIN =
  process.env.CLAUDE_BIN ??
  "C:\\Users\\BURAK\\.vscode\\extensions\\anthropic.claude-code-2.1.234-win32-x64\\resources\\native-binary\\claude.exe";
const WORKDIR = mkdtempSync(join(tmpdir(), "claude-bridge-"));
const MAX_PARALLEL = 2;

let active = 0;
const queue = [];
function acquire() {
  return new Promise((resolve) => {
    if (active < MAX_PARALLEL) { active++; resolve(); }
    else queue.push(resolve);
  });
}
function release() {
  active--;
  const next = queue.shift();
  if (next) { active++; next(); }
}

/** OpenAI messages → tek prompt metni (system başa, sıra korunur). */
function flatten(messages) {
  const parts = [];
  for (const m of messages ?? []) {
    const content = typeof m.content === "string"
      ? m.content
      : (m.content ?? []).map((c) => c.text ?? "").join("\n");
    if (m.role === "system") parts.unshift(`<system>\n${content}\n</system>`);
    else parts.push(`${m.role === "assistant" ? "ASSISTANT" : "USER"}:\n${content}`);
  }
  return parts.join("\n\n");
}

function runClaude(prompt, modelHint) {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--max-turns", "1"];
    // model ipucu: profiles model alanı "claude-cli[-sonnet|-opus|-haiku]"
    const m = /-(sonnet|opus|haiku)$/.exec(modelHint ?? "");
    if (m) args.push("--model", m[1]);
    const child = spawn(CLAUDE_BIN, args, { cwd: WORKDIR, windowsHide: true });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("bridge timeout (180s)")); }, 180_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
      try {
        const parsed = JSON.parse(out);
        if (parsed.is_error) return reject(new Error(String(parsed.result).slice(0, 300)));
        resolve(parsed);
      } catch {
        reject(new Error(`unparseable CLI output: ${out.slice(0, 200)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", service: "claude-cli-bridge", active }));
  }
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    // 503 (404 değil): 4xx router'da bad_request sayılır ve YEDEĞE DÜŞMEZ —
    // köprüye yanlış yoldan gelen istek zinciri kilitlemesin (canlı bulgu:
    // /responses'a düşen istekler sessizce 404 alıp tüm çağrıyı öldürüyordu).
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: `unsupported path ${req.url} — bridge speaks /v1/chat/completions only`, type: "bridge_error" } }));
  }
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
    await acquire();
    const started = Date.now();
    try {
      const result = await runClaude(flatten(payload.messages), payload.model);
      const usage = result.usage ?? {};
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `bridge-${result.session_id ?? Date.now()}`,
        object: "chat.completion",
        model: payload.model ?? "claude-cli",
        choices: [{
          index: 0,
          message: { role: "assistant", content: String(result.result ?? "") },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
          completion_tokens: usage.output_tokens ?? 0,
          total_tokens: 0,
        },
      }));
      console.log(JSON.stringify({ msg: "bridge ok", ms: Date.now() - started, out: usage.output_tokens ?? 0 }));
    } catch (err) {
      // 503 → APICallError(5xx) → provider_unavailable → router yedeğe düşer
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(err.message ?? err).slice(0, 300), type: "bridge_error" } }));
      console.log(JSON.stringify({ msg: "bridge error", ms: Date.now() - started, err: String(err.message ?? err).slice(0, 200) }));
    } finally {
      release();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`claude-cli-bridge :${PORT} (bin: ${CLAUDE_BIN})`));
