// MVP tool inventory (17 §3.1 shapes under the 35 §9 T39 names). Every tool
// an agent can invoke in MVP is defined here — the gateway is fail-closed on
// anything not in this registry.
import { z } from "zod";
import type { ToolDefinition } from "./contract.js";

const workspacePath = z.string().min(1).max(1024);
const zeroCost = () => ({ amountCents: 0, confidence: "exact" as const });

/** fs.read — R0 file/dir read inside the task workspace (17 §2.1). */
export const fsRead: ToolDefinition = {
  name: "fs.read",
  version: 1,
  description: "Read a file (or directory listing) inside the task workspace. Read-only.",
  input: z.object({
    path: workspacePath,
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    maxBytes: z.number().int().positive().max(2_000_000).default(262_144),
    range: z
      .object({ startLine: z.number().int().min(1), endLine: z.number().int().min(1) })
      .optional(),
  }),
  output: z.object({
    kind: z.enum(["file", "dir"]),
    content: z.string(),
    truncated: z.boolean(),
    byteSize: z.number().int(),
    provenance: z.literal("workspace"),
  }),
  risk: "R0",
  scopes: ["fs"],
  sandboxLevel: "analysis",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 10_000,
};

/** fs.search — R0 ripgrep over the workspace. */
export const fsSearch: ToolDefinition = {
  name: "fs.search",
  version: 1,
  // O1: the description used to promise ripgrep while dispatch ran plain
  // grep — a different regex dialect, so patterns like `\d+` silently matched
  // nothing. It now says what actually runs.
  description:
    "Search file contents in the task workspace with a POSIX extended regex (grep -E). Read-only.",
  input: z.object({
    pattern: z.string().min(1).max(1024),
    /** Path filter, e.g. `*.ts` or `src/**` (honoured since O1). */
    glob: z.string().max(256).optional(),
    maxResults: z.number().int().positive().max(500).default(100),
    caseSensitive: z.boolean().default(false),
  }),
  output: z.object({
    matches: z.array(
      z.object({ path: z.string(), line: z.number().int(), text: z.string() }),
    ),
    truncated: z.boolean(),
    provenance: z.literal("workspace"),
  }),
  risk: "R0",
  scopes: ["fs"],
  sandboxLevel: "analysis",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 30_000,
};

/** fs.write — R1 create/overwrite a file in the worktree (upserts the T38
 *  soft lock at dispatch; overlapping-path warnings come back structured). */
export const fsWrite: ToolDefinition = {
  name: "fs.write",
  version: 1,
  description:
    "Create or overwrite a file inside the task worktree. Returns soft-lock warnings when other tasks touch the same paths.",
  input: z.object({
    path: workspacePath,
    content: z.string().max(2_000_000),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    /**
     * 2026-08-15: existing files are REFUSED unless this is explicitly true.
     * A model re-emitting a long file hits its output-token ceiling and
     * silently truncates the rest (observed: −1750 lines). Editing existing
     * code goes through fs.edit; this flag stays for deliberate rewrites.
     */
    overwrite: z.boolean().default(false),
  }),
  output: z.object({
    byteSize: z.number().int(),
    created: z.boolean(),
    lockConflicts: z.array(
      z.object({ taskId: z.string(), pathPrefix: z.string() }),
    ),
    provenance: z.literal("workspace"),
  }),
  risk: "R1",
  scopes: ["fs"],
  sandboxLevel: "coding",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 15_000,
};

/**
 * fs.edit — R1 SURGICAL edit: replace an exact snippet inside an existing
 * file. Added 2026-08-15 after a live finding: with only whole-file fs.write,
 * an agent editing a 700-line file re-emits a truncated version and silently
 * destroys the rest (observed: +382/-1743 lines). Editing existing code MUST
 * go through this tool; fs.write stays for NEW files.
 * Fail-closed semantics (mirrors a proven code-agent contract): no match =>
 * error; multiple matches without replaceAll => error (ambiguous).
 */
export const fsEdit: ToolDefinition = {
  name: "fs.edit",
  version: 1,
  description:
    "Replace an exact text snippet inside an existing file (surgical edit). Use this instead of fs.write when changing files that already exist.",
  input: z.object({
    path: workspacePath,
    oldText: z.string().min(1).max(200_000),
    newText: z.string().max(200_000),
    replaceAll: z.boolean().default(false),
  }),
  output: z.object({
    replacements: z.number().int(),
    byteSize: z.number().int(),
    lockConflicts: z.array(z.object({ taskId: z.string(), pathPrefix: z.string() })),
    provenance: z.literal("workspace"),
  }),
  risk: "R1",
  scopes: ["fs"],
  sandboxLevel: "coding",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 15_000,
};

/** terminal.run — R1 shell command in the workspace container (17 §2.2). */
export const terminalRun: ToolDefinition = {
  name: "terminal.run",
  version: 1,
  description:
    "Run a shell command in the task workspace container. Output streams to the task terminal.",
  input: z.object({
    command: z.string().min(1).max(8192),
    cwd: z.string().max(1024).default("."),
    timeoutSec: z.number().int().min(1).max(1800).default(300),
    // gateway strips keys matching /TOKEN|KEY|SECRET|PASS/i before this parses (S2)
    env: z.record(z.string(), z.string()).default({}),
    stdin: z.string().max(65_536).optional(),
  }),
  output: z.object({
    exitCode: z.number().int(),
    /**
     * Komut kendi bitmedi, zaman aşımıyla öldürüldü.
     *
     * Şemada YOKTU ve bu yüzden dispatch'in doldurduğu alan buraya
     * gelmeden eleniyordu: ajan yalnız `exit=137` görüyor, "öldürüldü" ile
     * "test kırıldı" arasını ayıramıyordu. Zod bilinmeyen anahtarı sessizce
     * atar — alan eklenmeden çıktıya koymak hiçbir şey yapmaz.
     */
    timedOut: z.boolean(),
    /**
     * Ajana yazılan açıklama. `resultSummary` bu işi göremez: o alan yalnız
     * tool_invocations satırına ve olaya yazılıyor, çağırana DÖNMÜYOR — yani
     * ajan onu hiç görmüyor. Ajanın okuduğu tek şey bu çıktı nesnesi.
     */
    note: z.string().optional(),
    stdoutTail: z.string(),
    stderrTail: z.string(),
    durationMs: z.number(),
    terminalSessionId: z.uuid(),
    provenance: z.literal("workspace"),
  }),
  risk: "R1",
  scopes: ["fs", "git"],
  sandboxLevel: "coding",
  sideEffectFree: false,
  estimateCost: (i: { timeoutSec: number }) => ({
    amountCents: Math.ceil(i.timeoutSec / 60),
    confidence: "estimate",
  }),
  timeoutMs: 1_830_000,
  rateLimit: { perAgentPerMin: 20, perCompanyPerMin: 200 },
};

/** git.diff — R0 read-only plumbing over the worktree/bare repo. */
export const gitDiff: ToolDefinition = {
  name: "git.diff",
  version: 1,
  description: "Show the diff of the task branch (against main or a given ref). Read-only.",
  input: z.object({
    against: z.string().max(256).default("main"),
    paths: z.array(workspacePath).max(64).default([]),
    stat: z.boolean().default(false),
  }),
  output: z.object({
    diff: z.string(),
    filesChanged: z.number().int(),
    truncated: z.boolean(),
    provenance: z.literal("workspace"),
  }),
  risk: "R0",
  scopes: ["git"],
  sandboxLevel: "analysis",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 30_000,
};

/** git.commit — R1 commit to the task branch only (Task: trailer enforced
 *  at dispatch; a commit can never reference a different task, 15 §3.4). */
export const gitCommit: ToolDefinition = {
  name: "git.commit",
  version: 1,
  description:
    "Commit staged worktree changes to the task branch. The Task: trailer is injected/validated automatically.",
  input: z.object({
    message: z.string().min(1).max(4096),
    paths: z.array(workspacePath).max(256).default([]),
    allowEmpty: z.boolean().default(false),
  }),
  output: z.object({
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    filesCommitted: z.number().int(),
    branch: z.string(),
    provenance: z.literal("workspace"),
  }),
  risk: "R1",
  scopes: ["git"],
  sandboxLevel: "coding",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 30_000,
};

/** git.branch — R1 push the task branch to the server bare repo only. */
export const gitBranch: ToolDefinition = {
  name: "git.branch",
  version: 1,
  description:
    "Push the task branch to the project's bare repository (origin). Only task/* branches can be pushed.",
  input: z.object({
    /** Defaults to the task workspace's own branch at dispatch. */
    branch: z.string().min(1).max(256).optional(),
    force: z.boolean().default(false), // allowed ONLY on task/* (rebase flow, 15 §3.7)
  }),
  output: z.object({
    pushed: z.boolean(),
    remoteHead: z.string(),
    provenance: z.literal("workspace"),
  }),
  risk: "R1",
  scopes: ["git"],
  sandboxLevel: "coding",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 60_000,
};

/** git.merge — R2 lead-agent squash/ff merge into main in the bare repo,
 *  server-side and PR-entity gated (15 §3.6). */
export const gitMerge: ToolDefinition = {
  name: "git.merge",
  version: 1,
  description:
    "Merge an approved task branch into main in the bare repository. Requires approved reviews + green CI gates.",
  input: z.object({
    taskId: z.uuid(),
    /** Defaults to the task workspace's own branch at dispatch. */
    branch: z.string().min(1).max(256).optional(),
    strategy: z.enum(["squash", "ff-only", "merge-commit"]).default("squash"),
    /** Optimistic concurrency when provided; dispatch resolves the head. */
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  }),
  output: z.object({
    merged: z.boolean(),
    mergeCommitSha: z.string(),
    conflict: z
      .object({ files: z.array(z.string()) })
      .nullable(),
    provenance: z.literal("workspace"),
  }),
  risk: "R2",
  scopes: ["git"],
  sandboxLevel: "none",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 120_000,
  rateLimit: { perAgentPerMin: 3, perCompanyPerMin: 15 },
};

/**
 * Y2 (2026-08-15 code review): the old check was a single `^(select|with|
 * show|explain)` prefix test, which Postgres happily walks around —
 * `WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x` is a
 * data-modifying CTE that starts with WITH, and `EXPLAIN ANALYZE DELETE …`
 * actually RUNS the delete. The tool is R0 / sideEffectFree, i.e. it passes
 * the autonomy matrix with the least supervision, so a bypass here is a
 * silent write with no approval trail.
 *
 * This stays only the SECOND line of defence — dispatch runs the statement in
 * a `READ ONLY` transaction with a `statement_timeout`, which is what actually
 * makes a write impossible. Rejecting early just gives the agent a readable
 * error instead of a Postgres one.
 */
function isReadOnlyStatement(raw: string): boolean {
  // strip -- line comments and /* block comments */ so they cannot hide verbs
  const q = raw
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .trim();
  if (!/^\s*(select|with|show|explain|table|values)\b/i.test(q)) return false;
  // EXPLAIN ANALYZE executes the plan for real — only a plain EXPLAIN is safe
  if (/^\s*explain\b/i.test(q) && /\banalyze\b/i.test(q)) return false;
  // any writing verb anywhere (CTE bodies included) disqualifies the statement
  if (/\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|vacuum|call|do|refresh)\b/i.test(q)) {
    return false;
  }
  // multiple statements: only a single trailing semicolon is tolerated
  if (/;\s*\S/.test(q)) return false;
  return true;
}

/** db.inspect — R0 READ-ONLY SQL against project databases; non-SELECT is
 *  rejected and a statement_timeout is enforced at dispatch. */
export const dbInspect: ToolDefinition = {
  name: "db.inspect",
  version: 1,
  description:
    "Run a READ-ONLY SQL query (SELECT only) against a project database, or introspect its schema.",
  input: z.object({
    query: z
      .string()
      .min(1)
      .max(16_384)
      .refine(isReadOnlyStatement, {
        message:
          "db.inspect accepts a single read-only statement (no writing verb anywhere, no EXPLAIN ANALYZE)",
      }),
    environment: z.string().max(64).default("local"),
    maxRows: z.number().int().positive().max(1000).default(100),
  }),
  output: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.unknown())),
    rowCount: z.number().int(),
    truncated: z.boolean(),
    provenance: z.literal("workspace"),
  }),
  risk: "R0",
  scopes: ["db"],
  sandboxLevel: "none",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 30_000,
};

/** web.fetch — R0 through the egress allowlist proxy; response is wrapped
 *  with provenance markers (S5) before it can enter a Working Set. */
export const webFetch: ToolDefinition = {
  name: "web.fetch",
  version: 1,
  description:
    "Fetch a URL through the egress allowlist proxy. Response content is provenance-wrapped external content.",
  input: z.object({
    url: z.url().max(2048),
    method: z.enum(["GET", "HEAD"]).default("GET"),
    maxBytes: z.number().int().positive().max(5_000_000).default(1_048_576),
  }),
  output: z.object({
    status: z.number().int(),
    contentType: z.string(),
    body: z.string(),
    truncated: z.boolean(),
    provenance: z.literal("web"),
  }),
  risk: "R0",
  scopes: ["network"],
  sandboxLevel: "none",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 30_000,
};

/** web.search — R0 configured search API adapter. */
export const webSearch: ToolDefinition = {
  name: "web.search",
  version: 1,
  description: "Search the web via the configured search API. Results are external content.",
  input: z.object({
    query: z.string().min(1).max(512),
    maxResults: z.number().int().positive().max(20).default(8),
  }),
  output: z.object({
    results: z.array(
      z.object({ title: z.string(), url: z.string(), snippet: z.string() }),
    ),
    provenance: z.literal("web"),
  }),
  risk: "R0",
  scopes: ["network"],
  sandboxLevel: "none",
  sideEffectFree: true,
  estimateCost: () => ({ amountCents: 1, confidence: "estimate" }),
  timeoutMs: 20_000,
  credentialRefs: ["search.api_key"],
};

/** task.query — R0 read the company's own task board (platform data). */
export const taskQuery: ToolDefinition = {
  name: "task.query",
  version: 1,
  description:
    "Query tasks in this company (status, owner, project filters). Read-only platform data.",
  input: z.object({
    status: z.array(z.string().max(32)).max(16).default([]),
    ownerAgentId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    search: z.string().max(256).optional(),
    limit: z.number().int().positive().max(100).default(25),
  }),
  output: z.object({
    tasks: z.array(
      z.object({
        id: z.string(),
        number: z.number().int(),
        title: z.string(),
        status: z.string(),
        ownerAgentId: z.string().nullable(),
      }),
    ),
    total: z.number().int(),
    provenance: z.literal("platform"),
  }),
  risk: "R0",
  scopes: ["db"],
  sandboxLevel: "none",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 10_000,
};

/** memory.search — R0 scoped memory retrieval (12 §retrieval; wired T45). */
/** TASK 17 — preview.ports: workspace'te dinleyen portları keşfeder,
 *  workspace.port.opened olayını üretir, Founder'ın Open Preview URL'lerini
 *  döndürür. */
export const previewPorts: ToolDefinition = {
  name: "preview.ports",
  version: 1,
  risk: "R0",
  description:
    "Discover listening TCP ports in this task's workspace (after starting a dev server). Emits workspace.port.opened and returns preview URLs the Founder can open.",
  input: z.object({}),
  output: z.object({
    ports: z.array(z.object({ port: z.number(), previewUrl: z.string() })),
    provenance: z.literal("workspace"),
  }),
  scopes: ["network"],
  sandboxLevel: "none",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 15_000,
};

/** TASK 17 — http.request: agent/QA'nın hazırlanan uygulamayı HTTP ile
 *  doğrulaması. YALNIZ kendi workspace'inin keşfedilmiş local portlarına. */
export const httpRequest: ToolDefinition = {
  name: "http.request",
  version: 1,
  risk: "R1",
  description:
    "Send an HTTP request to a DISCOVERED local port of this task's own workspace (integration/QA checks on the app under development). Cannot reach anything else.",
  input: z.object({
    port: z.number().int().min(1).max(65535),
    path: z.string().max(2000).default("/"),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    headers: z.record(z.string(), z.string()).default({}),
    body: z.string().max(100_000).optional(),
    expectedStatus: z.number().int().optional(),
  }),
  output: z.object({
    status: z.number(),
    matchedExpected: z.boolean().nullable(),
    contentType: z.string().nullable(),
    body: z.string(),
    truncated: z.boolean(),
    provenance: z.literal("workspace"),
  }),
  scopes: ["network"],
  sandboxLevel: "none",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 30_000,
};

/** TASK 13/14 — code.search: CodeIndex sorgusu (canonical + task overlay).
 *  READY indeksli projede İLK arama aracı budur; tam repo fs.search ilk
 *  seçenek olamaz (INVARIANT 4/14). */
export const codeSearch: ToolDefinition = {
  name: "code.search",
  version: 1,
  risk: "R0",
  description:
    "Search the project CodeIndex (symbols, files, relations) across the canonical index AND this task's overlay. Returns symbol locations (path:lines) — read only those ranges afterwards. ALWAYS prefer this over full-repo fs.search when the index is ready.",
  input: z.object({
    terms: z.array(z.string().min(2).max(80)).min(1).max(12),
    limit: z.number().int().min(1).max(30).default(10),
  }),
  output: z.object({
    indexState: z.string(),
    stale: z.boolean(),
    symbols: z.array(
      z.object({
        path: z.string(),
        name: z.string(),
        kind: z.string(),
        startLine: z.number(),
        endLine: z.number(),
        layer: z.string(),
        exported: z.boolean(),
      }),
    ),
    relations: z.array(
      z.object({ kind: z.string(), fromPath: z.string(), symbolName: z.string().nullable() }),
    ),
    provenance: z.literal("platform"),
  }),
  scopes: ["fs"],
  sandboxLevel: "none",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 20_000,
};

/** TASK 10 — CEO org mutasyon yetenekleri. team.create ve agent.hire R3:
 *  otonomi tavanını aştığı için Tool Gateway varsayılan olarak Founder
 *  onayına eskale eder (06 §1) — doc'un istediği kapı tam budur. */
export const orgTeamCreate: ToolDefinition = {
  name: "org.team.create",
  version: 1,
  risk: "R3",
  description:
    "Create a new team (org unit) with a default position for the given capability. Requires Founder approval by default.",
  input: z.object({
    capability: z.string().min(2).max(60),
  }),
  output: z.object({ createdUnits: z.array(z.string()), provenance: z.literal("platform") }),
  scopes: ["publish"],
  sandboxLevel: "none",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 30_000,
};

export const agentHire: ToolDefinition = {
  name: "agent.hire",
  version: 1,
  risk: "R3",
  description:
    "Hire N agents for a capability via the Agent Factory (team + position + hierarchy + tool grants + project assignment). Requires Founder approval by default.",
  input: z.object({
    capability: z.string().min(2).max(60),
    count: z.number().int().min(1).max(10).default(1),
  }),
  output: z.object({
    hiredAgentIds: z.array(z.string()),
    createdUnits: z.array(z.string()),
    provenance: z.literal("platform"),
  }),
  scopes: ["publish"],
  sandboxLevel: "none",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 60_000,
};

export const agentAssignProject: ToolDefinition = {
  name: "agent.assign_project",
  version: 1,
  risk: "R2",
  description: "Assign an existing agent to this task's project (project_members).",
  input: z.object({ agentId: z.uuid(), role: z.string().max(40).default("engineer") }),
  output: z.object({ assigned: z.boolean(), provenance: z.literal("platform") }),
  scopes: ["publish"],
  sandboxLevel: "none",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 15_000,
};

export const modelBind: ToolDefinition = {
  name: "model.bind",
  version: 1,
  risk: "R2",
  description:
    "Bind an agent to a model profile for a purpose (default/coding/planning/review). Provider/model must exist in the platform registry.",
  input: z.object({
    agentId: z.uuid(),
    purpose: z.enum(["primary", "default", "coding", "planning", "review", "fast"]),
    provider: z.string().min(2).max(40),
    model: z.string().min(2).max(120),
  }),
  output: z.object({ bound: z.boolean(), provenance: z.literal("platform") }),
  scopes: ["publish"],
  sandboxLevel: "none",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 15_000,
};

/** github.repo.ensure — CEO niyeti (TASK 6): projenin GitHub yansısını
 *  garanti eder. Credential SUNUCUDA çözülür; ajan token GÖRMEZ (S2). */
export const githubRepoEnsure: ToolDefinition = {
  name: "github.repo.ensure",
  version: 1,
  risk: "R2",
  description:
    "Ensure the project's GitHub remote exists (create private repo if needed) and push the internal repository to it. Credentials are resolved server-side; no token is ever exposed.",
  input: z.object({}),
  output: z.object({
    published: z.boolean(),
    remoteUrl: z.string().nullable(),
    provenance: z.literal("platform"),
  }),
  scopes: ["publish"],
  sandboxLevel: "none",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 60_000,
};

export const memorySearch: ToolDefinition = {
  name: "memory.search",
  version: 1,
  description:
    "Search organizational memory (own scope + project + company). Read-only.",
  input: z.object({
    query: z.string().min(1).max(1024),
    scopes: z.array(z.enum(["agent", "project", "company"])).max(3).default([]),
    limit: z.number().int().positive().max(50).default(10),
  }),
  output: z.object({
    memories: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        summary: z.string(),
        scope: z.string(),
        score: z.number(),
      }),
    ),
    provenance: z.literal("platform"),
  }),
  risk: "R0",
  scopes: ["db"],
  sandboxLevel: "none",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 10_000,
};

/**
 * The MVP tool registry (35 §9 T39 list). 13 in the original list; `fs.edit`
 * joined on 2026-08-15 after a whole-file rewrite silently truncated a long
 * file, so the count is 14 — the registry test locks the exact set.
 */
export const MVP_TOOLS: readonly ToolDefinition[] = [
  fsRead,
  fsWrite,
  fsEdit,
  fsSearch,
  gitCommit,
  gitBranch,
  gitDiff,
  gitMerge,
  terminalRun,
  dbInspect,
  webFetch,
  webSearch,
  taskQuery,
  memorySearch,
  codeSearch,
  previewPorts,
  httpRequest,
  githubRepoEnsure,
  orgTeamCreate,
  agentHire,
  agentAssignProject,
  modelBind,
];
