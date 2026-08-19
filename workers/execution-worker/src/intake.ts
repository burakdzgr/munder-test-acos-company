// Intake sandbox activities (T42; 14 §3.1 stages 1–2). Doc-assigned to the
// execution worker: `ingestRepoActivity (execution-worker → sandbox-manager)`
// — these are PRE-AGENT system operations (no agent identity, no task, no
// grants exist yet), so they ride sandbox-manager's internal API directly;
// agent tool calls keep going through the Tool Gateway (S3) unchanged.
//
// Analyzer principles (14 §3.1): deterministic toolchains, NOT an LLM; each
// runs inside ONE `analysis`-level container (read-only worktree, no
// network — P2) [recorded deviation: one container reused across analyzers,
// not one per analyzer]; individual failure marks the section "analysis
// unavailable" and never blocks the report (P6).
import { heartbeat } from "@temporalio/activity";
import { uuidv5 } from "@acos/domain";
import type { IngestRepoResponse, IngestSource } from "@acos/contracts";

export interface IntakeSandboxClient {
  ingest(input: { projectId: string; source: IngestSource }): Promise<IngestRepoResponse>;
  createWorkspace(input: {
    workspaceId: string;
    isolation: "analysis";
    image: string;
    mounts: { source: string; target: string; readonly: boolean; type: "volume" }[];
  }): Promise<{ workspaceId: string }>;
  exec(
    workspaceId: string,
    input: { command: string[]; timeoutMs: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; durationMs: number }>;
  destroyWorkspace(workspaceId: string): Promise<void>;
}

export function createIntakeSandboxClient(options: {
  sandboxManagerUrl: string;
  internalApiToken: string;
  fetchImpl?: typeof fetch;
}): IntakeSandboxClient {
  const doFetch = options.fetchImpl ?? fetch;
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${options.sandboxManagerUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.internalApiToken}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`sandbox-manager ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
  return {
    ingest: (input) => request("POST", "/internal/v1/repos/ingest", input),
    createWorkspace: (input) => request("POST", "/internal/v1/workspaces", input),
    exec: (workspaceId, input) =>
      request("POST", `/internal/v1/workspaces/${workspaceId}/exec`, { env: {}, ...input }),
    destroyWorkspace: (workspaceId) =>
      request("DELETE", `/internal/v1/workspaces/${workspaceId}`),
  };
}

/** Deterministic per-project intake workspace id (idempotent create). */
export function intakeWorkspaceId(projectId: string): string {
  return uuidv5("intake-workspace", projectId);
}

/**
 * The MVP analyzer set (subset of 14 §3.1's 13; the rest land with the
 * departments that consume them). Each is a self-contained node script run
 * as `node -e <js>` in /work — argv-array exec, no shell quoting surface.
 * Output contract: JSON on stdout.
 */
export const INTAKE_ANALYZERS: readonly { key: string; title: string; script: string }[] = [
  {
    key: "repo_profile",
    title: "Repository profile",
    script: `
      const { execSync } = require("node:child_process");
      const git = (a) => execSync("git -C /work " + a, { encoding: "utf8" }).trim();
      const commits = Number(git("rev-list --count HEAD"));
      const authors = git("shortlog -sn HEAD").split("\\n").filter(Boolean).length;
      const first = git("log --reverse --format=%cI").split("\\n")[0];
      const last = git("log -1 --format=%cI");
      console.log(JSON.stringify({ commits, authors, firstCommitAt: first, lastCommitAt: last,
        branch: git("rev-parse --abbrev-ref HEAD"), head: git("rev-parse HEAD") }));
    `,
  },
  {
    key: "languages",
    title: "Technology stack",
    script: `
      const fs = require("node:fs"), path = require("node:path");
      const counts = {};
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === ".git" || e.name === "node_modules") continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else { const ext = path.extname(e.name) || "(none)"; counts[ext] = (counts[ext] ?? 0) + 1; }
        }
      };
      walk("/work");
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15);
      console.log(JSON.stringify({ fileCountsByExtension: Object.fromEntries(top) }));
    `,
  },
  {
    key: "structure",
    title: "Architecture assessment",
    script: `
      const fs = require("node:fs"), path = require("node:path");
      const entries = [];
      for (const e of fs.readdirSync("/work", { withFileTypes: true })) {
        if (e.name === ".git") continue;
        if (e.isDirectory()) {
          let n = 0;
          const walk = (d) => { for (const x of fs.readdirSync(d, { withFileTypes: true })) {
            if (x.name === "node_modules") continue;
            if (x.isDirectory()) walk(path.join(d, x.name)); else n++; } };
          try { walk(path.join("/work", e.name)); } catch {}
          entries.push({ dir: e.name + "/", files: n });
        } else entries.push({ file: e.name });
      }
      console.log(JSON.stringify({ topLevel: entries.slice(0, 50) }));
    `,
  },
  {
    key: "dependencies",
    title: "Dependency health",
    script: `
      const fs = require("node:fs");
      const raw = fs.readFileSync("/work/package.json", "utf8");
      const pkg = JSON.parse(raw); // malformed manifest ⇒ analyzer degrades
      const deps = Object.keys(pkg.dependencies ?? {});
      const dev = Object.keys(pkg.devDependencies ?? {});
      console.log(JSON.stringify({ name: pkg.name ?? null, dependencies: deps,
        devDependencies: dev, directCount: deps.length + dev.length,
        hasLockfile: fs.existsSync("/work/package-lock.json") || fs.existsSync("/work/pnpm-lock.yaml") }));
    `,
  },
  {
    key: "tests",
    title: "Test & CI status",
    script: `
      const fs = require("node:fs"), path = require("node:path");
      let testFiles = 0;
      const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\\.(test|spec)\\.[jt]sx?$/.test(e.name)) testFiles++; } };
      walk("/work");
      let testScript = null;
      try { testScript = JSON.parse(fs.readFileSync("/work/package.json", "utf8")).scripts?.test ?? null; } catch {}
      const ci = ["/.github/workflows", "/.gitlab-ci.yml", "/Jenkinsfile"].filter((p) => fs.existsSync("/work" + p));
      console.log(JSON.stringify({ testFiles, testScript, ciConfigs: ci }));
    `,
  },
  {
    key: "docs",
    title: "Documentation state",
    script: `
      const fs = require("node:fs"), path = require("node:path");
      const mdFiles = [];
      const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\\.md$/i.test(e.name)) mdFiles.push(p.slice(6)); } };
      walk("/work");
      let readmeExcerpt = null;
      try { readmeExcerpt = fs.readFileSync("/work/README.md", "utf8").slice(0, 1500); } catch {}
      console.log(JSON.stringify({ markdownFiles: mdFiles.slice(0, 40), readmeExcerpt }));
    `,
  },
  {
    key: "config_env",
    title: "Configuration & environments",
    script: `
      const fs = require("node:fs");
      const names = new Set();
      for (const f of [".env", ".env.example", ".env.sample"]) {
        try {
          for (const line of fs.readFileSync("/work/" + f, "utf8").split("\\n")) {
            const m = /^([A-Z][A-Z0-9_]+)=/.exec(line.trim());
            if (m) names.add(m[1]); // NAMES only — values never extracted (S2)
          }
        } catch {}
      }
      const configFiles = fs.readdirSync("/work").filter((n) =>
        /^(docker-compose.*\\.ya?ml|Dockerfile.*|.*\\.config\\.[jt]s|tsconfig.*\\.json)$/.test(n));
      console.log(JSON.stringify({ envVarNames: [...names].slice(0, 100), configFiles }));
    `,
  },
  {
    key: "security_smells",
    title: "Security findings",
    script: `
      const fs = require("node:fs"), path = require("node:path");
      const patterns = [
        ["aws_access_key", /AKIA[0-9A-Z]{16}/],
        ["private_key_block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
        ["hardcoded_password", /password\\s*[:=]\\s*['"][^'"]{4,}['"]/i],
        ["generic_api_key", /api[_-]?key\\s*[:=]\\s*['"][^'"]{8,}['"]/i],
      ];
      const hits = [];
      const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        let text; try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
        if (text.length > 1_000_000) continue;
        for (const [kind, re] of patterns) {
          const lines = text.split("\\n");
          for (let i = 0; i < lines.length; i++) {
            // hits are REDACTED: file + line + kind only, never the match
            if (re.test(lines[i])) hits.push({ kind, file: p.slice(6), line: i + 1 });
          }
        }
      } };
      walk("/work");
      console.log(JSON.stringify({ findings: hits.slice(0, 50), truncated: hits.length > 50 }));
    `,
  },
  {
    key: "code_graph",
    title: "Code structure & dependencies",
    script: `
      const fs = require("node:fs"), path = require("node:path");
      // TypeScript/JavaScript kod grafiği: her dosya için import/export bilgisi
      // Agent'lar bu metadata ile "X modülünü kimler kullanıyor" sorularına
      // dosya okumadan cevap verebilir (memory retrieval).
      const modules = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === ".git" || e.name === "node_modules") continue;
          const absPath = path.join(dir, e.name);
          if (e.isDirectory()) { walk(absPath); continue; }
          // Sadece TypeScript/JavaScript dosyaları
          if (!/\\.[jt]sx?$/.test(e.name)) continue;
          
          let text;
          try { text = fs.readFileSync(absPath, "utf8"); } catch { continue; }
          if (text.length > 500_000) continue; // Çok büyük dosyaları atla
          
          const relPath = absPath.slice(6); // /work/ prefix'i kaldır
          const imports = [];
          const exports = [];
          
          // Basit regex ile import/export tespiti (AST parser olmadan MVP)
          // import { x } from "y" veya import x from "y"
          const importMatches = text.matchAll(/^\\s*import\\s+(?:{[^}]+}|[^'"]+)\\s+from\\s+['"]([^'"]+)['"]/gm);
          for (const m of importMatches) {
            const spec = m[1];
            // Sadece relative ve package import'ları (./ ../ veya paket adı)
            if (spec && !spec.startsWith("node:")) imports.push(spec);
          }
          
          // export { x }, export function, export const, export default
          if (/^\\s*export\\s+(default|const|function|class|interface|type|enum)\\s/m.test(text)) {
            exports.push("named_exports");
          }
          if (/^\\s*export\\s+default\\s/m.test(text)) {
            exports.push("default_export");
          }
          if (/^\\s*export\\s+{/m.test(text)) {
            exports.push("named_exports");
          }
          
          // En az bir import veya export varsa kaydet
          if (imports.length > 0 || exports.length > 0) {
            modules.push({
              file: relPath,
              imports: [...new Set(imports)].slice(0, 50), // Unique, max 50
              exports: [...new Set(exports)],
              loc: text.split("\\n").length, // Line count
            });
          }
        }
      };
      walk("/work");
      
      // İstatistikler
      const stats = {
        totalModules: modules.length,
        avgImportsPerModule: modules.reduce((s, m) => s + m.imports.length, 0) / (modules.length || 1),
        filesWithExports: modules.filter(m => m.exports.length > 0).length,
      };
      
      console.log(JSON.stringify({
        modules: modules.slice(0, 200), // İlk 200 modül (büyük repo'larda sınırla)
        stats,
        truncated: modules.length > 200,
      }));
    `,
  },
];

export interface AnalyzerResult {
  analyzer: string;
  title: string;
  ok: boolean;
  /** Parsed JSON findings on success; raw stderr/parse error otherwise. */
  findings: unknown;
  error: string | null;
  durationMs: number;
}

export interface IntakeActivityDeps {
  sandbox: IntakeSandboxClient;
  /** Analysis container image; needs git + node (acos/workspace-node). */
  analysisImage?: string;
}

const ANALYZER_TIMEOUT_MS = 5 * 60 * 1000; // 14 §3.1 per-analyzer budget

export function createIntakeExecutionActivities(deps: IntakeActivityDeps) {
  const image = deps.analysisImage ?? "acos/workspace-node";

  return {
    /** Stage 1 (14 §3.1): source → the platform's own bare repo. */
    async ingestRepoActivity(input: {
      projectId: string;
      source: IngestSource;
    }): Promise<IngestRepoResponse> {
      try {
        heartbeat("ingest");
      } catch {
        /* outside activity context (unit tests) */
      }
      return deps.sandbox.ingest(input);
    },

    /**
     * Stage 2: one analyzer inside the shared analysis-level container
     * (RO worktree, no network — P2). Analyzer failure is a RESULT.
     */
    async runIntakeAnalyzerActivity(input: {
      projectId: string;
      worktreeVolume: string;
      analyzerKey: string;
    }): Promise<AnalyzerResult> {
      const analyzer = INTAKE_ANALYZERS.find((a) => a.key === input.analyzerKey);
      if (!analyzer) {
        return {
          analyzer: input.analyzerKey,
          title: input.analyzerKey,
          ok: false,
          findings: null,
          error: "unknown analyzer",
          durationMs: 0,
        };
      }
      const workspaceId = intakeWorkspaceId(input.projectId);
      await deps.sandbox.createWorkspace({
        workspaceId,
        isolation: "analysis",
        image,
        mounts: [
          { source: input.worktreeVolume, target: "/work", readonly: true, type: "volume" },
        ],
      });
      const beat = setInterval(() => {
        try {
          heartbeat(analyzer.key);
        } catch {
          /* unit context */
        }
      }, 10_000);
      try {
        const result = await deps.sandbox.exec(workspaceId, {
          command: ["node", "-e", analyzer.script],
          timeoutMs: ANALYZER_TIMEOUT_MS,
        });
        if (result.exitCode !== 0) {
          return {
            analyzer: analyzer.key,
            title: analyzer.title,
            ok: false,
            findings: null,
            error: result.stderr.slice(0, 1000) || `exit ${result.exitCode}`,
            durationMs: result.durationMs,
          };
        }
        let findings: unknown;
        try {
          findings = JSON.parse(result.stdout);
        } catch {
          return {
            analyzer: analyzer.key,
            title: analyzer.title,
            ok: false,
            findings: null,
            error: `non-JSON analyzer output: ${result.stdout.slice(0, 200)}`,
            durationMs: result.durationMs,
          };
        }
        return {
          analyzer: analyzer.key,
          title: analyzer.title,
          ok: true,
          findings,
          error: null,
          durationMs: result.durationMs,
        };
      } finally {
        clearInterval(beat);
      }
    },

    /** Post-analysis cleanup (best-effort; the reaper would catch strays). */
    async destroyIntakeWorkspaceActivity(input: { projectId: string }): Promise<void> {
      await deps.sandbox.destroyWorkspace(intakeWorkspaceId(input.projectId)).catch(() => {});
    },
  };
}

export type IntakeExecutionActivities = ReturnType<typeof createIntakeExecutionActivities>;
