// Real ToolDispatchPort (T40; 17 §4 step 7): workspace-level tools execute
// inside the task's hardened workspace container via sandbox-manager's
// internal HTTP API — the T38 WorkspaceService provisions the bare repo +
// worktree volume + container on first use and records everything with
// workspace.* events. The gateway remains the only caller (S3); this module
// is the gateway's dispatch arm, never a bypass.
//
// Tool coverage in T40: fs.read / fs.write (T38 soft lock upserted, warn-
// not-block) / fs.search / terminal.run / git.diff / git.commit (Task:
// trailer injected per 15 §3.4). git.branch/git.merge land with the review
// flow (T43). task.query/memory.search are platform-data tools wired in B1'
// (no workspace at all); db.inspect/web.* stay unimplemented and return typed
// failures that the gateway audits as status=failed.
import {
  companyContext,
  MemoryRetrievalService,
  ReviewsService,
  TasksService,
  TaskStateService,
  WorkspaceService,
  type CompanyContext,
  type GuardedDb,
  type SandboxPort,
} from "@acos/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { Pool } from "pg";
// undici's own fetch, not the global one: the dispatcher option and the
// global's Node-bundled types come from different undici versions, and the
// mismatch is a type error rather than a runtime one.
import { ProxyAgent, fetch as proxiedFetch } from "undici";
import {
  agents,
  companies,
  environments,
  tasks,
  workspaces as workspacesTable,
} from "@acos/db/schema";
import type { MergeBranchResponse } from "@acos/contracts";
import type { IsolationLevel } from "@acos/domain";
import type {
  EnsureRepoResponse,
  ExecResult,
  ProvisionWorktreeResponse,
  Workspace,
} from "@acos/contracts";
import type { ToolDispatchPort } from "./gateway.js";

export interface SandboxDispatchOptions {
  guardedDb: GuardedDb;
  /** TASK 6: github.repo.ensure credential çözümü için (S2 seam). */
  masterKey?: string | undefined;
  sandboxManagerUrl: string;
  internalApiToken: string;
  /** Workspace image when the project carries no override (15 §3.1). */
  defaultImage?: string;
  /**
   * B3' — the ACOS platform database URL. `db.inspect` targets PROJECT
   * databases (17 §3.1); pointing it at the platform DB would hand an agent
   * every company's rows in one query, so the URL is compared and refused.
   */
  platformDatabaseUrl?: string | undefined;
  /** B2' — the egress allowlist proxy every network tool must go through. */
  egressProxyUrl?: string | undefined;
  /** B2' — search API endpoint override; the key rides the credential seam. */
  searchApiUrl?: string | undefined;
  /** 2026-08-18 GitHub yansıması: lead merge başarıyla bitince çağrılır —
   *  fire-and-forget; yayının başarısızlığı merge'i asla geri almaz. */
  onMergeCompleted?: ((companyId: string, projectId: string, mergeCommit?: string, taskId?: string) => void) | undefined;
}

class DispatchError extends Error {}

/** AbacusAI web search API — unified search through the platform (overridable). */
const DEFAULT_SEARCH_ENDPOINT = "https://api.abacus.ai/api/v0/searchWebForLlm";

/** One proxy dispatcher per proxy URL — connections are pooled, not per call. */
const proxyAgents = new Map<string, ProxyAgent>();
function proxyAgent(url: string): ProxyAgent {
  let agent = proxyAgents.get(url);
  if (!agent) {
    agent = new ProxyAgent(url);
    proxyAgents.set(url, agent);
  }
  return agent;
}

/**
 * B2' — every outbound request from a tool goes through the egress allowlist
 * proxy (27 §12, S8), never straight out of the server process. The gateway's
 * `domainAllowlist` grant is the per-agent rule; squid's ACL is the
 * infrastructure-wide one, and a host that satisfies neither is refused
 * without this process ever opening a socket to it.
 */
async function fetchThroughProxy(
  url: string,
  opts: { method: string; maxBytes: number; timeoutMs: number; proxyUrl: string },
): Promise<{ status: number; contentType: string; body: string; truncated: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await proxiedFetch(url, {
      method: opts.method,
      dispatcher: proxyAgent(opts.proxyUrl),
      signal: controller.signal,
      redirect: "follow",
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (opts.method === "HEAD" || res.body === null) {
      return { status: res.status, contentType, body: "", truncated: false };
    }
    // read with a hard byte ceiling: a hostile or merely huge page must not be
    // able to blow up the server's memory or the agent's context
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        size += value.byteLength;
        if (size > opts.maxBytes) {
          chunks.push(value.slice(0, value.byteLength - (size - opts.maxBytes)));
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(value);
      }
    }
    return {
      status: res.status,
      contentType,
      body: Buffer.concat(chunks).toString("utf8"),
      truncated,
    };
  } catch (err) {
    // squid answers a blocked host with 403; a refused CONNECT lands here
    throw new DispatchError(
      `web.fetch failed (through the egress proxy): ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * AbacusAI search adapter — POST body format; key in header.
 * API docs: https://abacus.ai/help/api / Python SDK: client.search_web_for_llm
 */
async function searchTheWeb(
  query: string,
  opts: {
    maxResults: number;
    apiKey: string;
    endpoint: string;
    timeoutMs: number;
    proxyUrl: string;
  },
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await proxiedFetch(opts.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        apiKey: opts.apiKey,
      },
      body: JSON.stringify({
        queries: [query],
        max_results: opts.maxResults,
        search_providers: ["GOOGLE"],
      }),
      dispatcher: proxyAgent(opts.proxyUrl),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DispatchError(`AbacusAI search API returned ${res.status}: ${text.slice(0, 200)}`);
    }
    // Response: array of WebSearchResult objects
    const payload = (await res.json()) as Array<{
      title?: string;
      url?: string;
      snippet?: string;
      description?: string;
    }>;
    return payload.slice(0, opts.maxResults).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.snippet || r.description || "",
    }));
  } catch (err) {
    if (err instanceof DispatchError) throw err;
    throw new DispatchError(`web.search failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * B3' — project-database pools for `db.inspect`, one per URL, opened lazily
 * and kept small: an agent asking three questions in a row should not pay
 * three handshakes, and a project nobody inspects should not hold sockets.
 */
const inspectPools = new Map<string, Pool>();

function inspectPool(url: string): Pool {
  let pool = inspectPools.get(url);
  if (!pool) {
    pool = new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 30_000 });
    pool.on("error", () => {}); // an idle client dropped by the project DB is not our failure
    inspectPools.set(url, pool);
  }
  return pool;
}

/** Same host+port+database ⇒ same database, whatever the credentials are. */
function sameDatabase(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return (
      left.hostname === right.hostname &&
      (left.port || "5432") === (right.port || "5432") &&
      left.pathname === right.pathname
    );
  } catch {
    return a === b; // unparseable: fall back to an exact match rather than allowing
  }
}

/**
 * The real guarantee behind db.inspect's R0 classification: the statement runs
 * inside a `READ ONLY` transaction with a `statement_timeout`, so a write that
 * slipped past the schema check fails at the database ("cannot execute INSERT
 * in a read-only transaction") instead of succeeding quietly, and a runaway
 * scan cannot pin the project's database.
 */
async function runReadOnlyQuery(
  url: string,
  query: string,
  opts: { maxRows: number; timeoutMs: number },
): Promise<{ columns: string[]; rows: unknown[][]; rowCount: number; truncated: boolean }> {
  const client = await inspectPool(url).connect();
  try {
    await client.query("BEGIN READ ONLY");
    // SET LOCAL dies with the transaction — no leakage into a pooled session
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1_000, opts.timeoutMs)}`);
    // one extra row is what tells us the result was cut short
    const res = await client.query({ text: query, rowMode: "array" });
    const all = res.rows as unknown[][];
    const truncated = all.length > opts.maxRows;
    return {
      columns: res.fields.map((f) => f.name),
      rows: all.slice(0, opts.maxRows),
      rowCount: truncated ? opts.maxRows : all.length,
      truncated,
    };
  } catch (err) {
    // the agent gets the database's own words — "cannot execute DELETE in a
    // read-only transaction" is exactly the feedback that stops the retry loop
    throw new DispatchError(`db.inspect failed: ${(err as Error).message}`);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

/** Minimal typed client for sandbox-manager's internal API (T37/T38). */
class SandboxHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DispatchError(`sandbox-manager ${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  ensureRepo(projectId: string) {
    return this.request<EnsureRepoResponse>("POST", "/internal/v1/repos", { projectId });
  }
  provisionWorktree(input: { projectId: string; volumeName: string; branch: string }) {
    return this.request<ProvisionWorktreeResponse>("POST", "/internal/v1/worktrees", input);
  }
  createWorkspace(input: {
    workspaceId: string;
    isolation: string;
    image: string;
    mounts: { source: string; target: string; readonly: boolean; type: "bind" | "volume" }[];
  }) {
    return this.request<Workspace>("POST", "/internal/v1/workspaces", input);
  }
  destroyWorkspace(workspaceId: string) {
    return this.request<void>("DELETE", `/internal/v1/workspaces/${workspaceId}`);
  }
  removeWorktree(volumeName: string) {
    return this.request<void>("DELETE", `/internal/v1/worktrees/${volumeName}`);
  }
  mergeBranch(input: {
    projectId: string;
    branch: string;
    message: string;
    authorName: string;
    authorEmail: string;
    reviewedBy: string;
  }) {
    return this.request<MergeBranchResponse>("POST", "/internal/v1/repos/merge", input);
  }
  pushBranch(input: { projectId: string; volumeName: string; branch: string; force?: boolean }) {
    return this.request<{ pushed: true; remoteHead: string }>(
      "POST",
      "/internal/v1/worktrees/push",
      input,
    );
  }
  exec(
    workspaceId: string,
    input: {
      command: string[];
      env?: Record<string, string>;
      timeoutMs: number;
      cwd?: string;
      /** Stream PTY frames to NATS `term.<sessionId>` while awaiting (T41). */
      sessionId?: string;
    },
  ) {
    return this.request<ExecResult>("POST", `/internal/v1/workspaces/${workspaceId}/exec`, {
      env: {},
      ...(input.sessionId && { waitForResult: true }),
      ...input,
    });
  }
}

const TAIL_BYTES = 32 * 1024;
const tail = (s: string) => (s.length > TAIL_BYTES ? s.slice(-TAIL_BYTES) : s);

/** Workspace-relative path guard: no escapes, no absolute paths, quotable. */
function safeRelPath(path: string): string {
  if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\0")) {
    throw new DispatchError(`unsafe workspace path: ${path}`);
  }
  return path;
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function createSandboxDispatchPort(options: SandboxDispatchOptions): ToolDispatchPort {
  const db = options.guardedDb;
  // TASK 14 — okuma önbelleği: aynı görevde AYNI read-only çağrı tekrar
  // sandbox'a inmez; sonuç 10 dk önbellekten döner (anti-rescan disiplini).
  const READ_CACHE_TOOLS = new Set(["fs.read", "fs.search", "fs.list", "code.search"]);
  const readCache = new Map<string, { at: number; value: { output: unknown; resultSummary: string } }>();
  const READ_CACHE_TTL_MS = 10 * 60_000;
  const readCacheKey = (taskId: string | null, toolName: string, args: unknown) =>
    `${taskId ?? "-"}:${toolName}:${JSON.stringify(args)}`;
  const readCacheGet = (key: string) => {
    const hit = readCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > READ_CACHE_TTL_MS) {
      readCache.delete(key);
      return null;
    }
    return hit.value;
  };
  const readCachePut = (key: string, value: { output: unknown; resultSummary: string }) => {
    if (readCache.size > 500) {
      const oldest = readCache.keys().next().value;
      if (oldest) readCache.delete(oldest);
    }
    readCache.set(key, { at: Date.now(), value });
  };
  const http = new SandboxHttp(options.sandboxManagerUrl, options.internalApiToken);
  const workspaces = new WorkspaceService(db);
  const reviewsService = new ReviewsService(db);
  const taskState = new TaskStateService(db);
  const tasksService = new TasksService(db);
  const memoryRetrieval = new MemoryRetrievalService(db);
  const defaultImage = options.defaultImage ?? "acos/workspace-node";

  // T38 seam: DB records + events stay in WorkspaceService; the container/git
  // legwork happens in sandbox-manager behind this port.
  function provisioningPort(image: string, isolation: IsolationLevel): SandboxPort {
    return {
      ensureRepo: (projectId) => http.ensureRepo(projectId),
      provisionWorktree: (input) => http.provisionWorktree(input),
      createContainer: async ({ workspaceId, volumeName }) => {
        // Y5 note: isolation.ts calls `analysis` "ro source", which read as a
        // contradiction with the writable mount here. It is not one any more —
        // C2 escalates the task's single workspace to `coding` before any
        // write tool runs, so an `analysis` container never receives one. The
        // mount stays writable because the SAME volume is reused across the
        // escalation; remounting read-only would only move the failure.
        const ws = await http.createWorkspace({
          workspaceId,
          isolation,
          image,
          mounts: [{ source: volumeName, target: "/work", readonly: false, type: "volume" }],
        });
        return { containerId: ws.containerId };
      },
      destroyContainer: (workspaceId) => http.destroyWorkspace(workspaceId),
      removeWorktree: (volumeName) => http.removeWorktree(volumeName),
    };
  }

  /** Get-or-provision the task's live workspace at the tool's level. */
  async function workspaceFor(
    ctx: CompanyContext,
    agentId: string,
    taskId: string,
    level: IsolationLevel,
  ) {
    const { workspace } = await workspaces.provision(
      ctx,
      { taskId, agentId, isolationLevel: level, image: defaultImage },
      provisioningPort(defaultImage, level),
    );
    if (!["ready", "in_use", "idle"].includes(workspace.status)) {
      throw new DispatchError(`workspace ${workspace.id} unusable (status=${workspace.status})`);
    }
    if (workspace.status === "ready" || workspace.status === "idle") {
      await workspaces.transition(ctx, workspace.id, "in_use", {
        actor: { kind: "agent", id: agentId },
      });
    }
    return workspace;
  }

  /**
   * Ajanın komutları ETKİLEŞİMSİZ koşar — sorulan soruya cevap verecek kimse yok.
   *
   * Canlı arıza (2026-08-16): bir ajan `pnpm --filter … typecheck` çalıştırdı,
   * corepack "pnpm-9.15.9.tgz indirilsin mi? [Y/n]" diye sordu ve komut
   * zaman aşımına kadar (300 sn) orada bekledi. Founder ekranda soruyu
   * görüyor ama terminal salt-okunur (24 §6.9) — cevap veremiyor, vermemeli
   * de: o pencere gözlem penceresi, kabuk değil. Ajan aynı komutu üç kez
   * denedi, üç kez aynı yerde takıldı; 15 dakika ve üç adım boşa gitti.
   *
   * Çıktı akışı PTY üzerinden gittiği için stdin bir TTY'dir ve araçlar tam
   * da bu yüzden soru sorma hakkını kendinde görüyor. Çözüm TTY'yi kaldırmak
   * değil (o zaman canlı kare akışı biterdi), araçlara etkileşimsiz olduğunu
   * SÖYLEMEK.
   *
   * Ajan `args.env` ile bunları bilerek ezebilir — varsayılan, yasak değil.
   */
  const NON_INTERACTIVE_ENV: Record<string, string> = {
    // Neredeyse bütün CLI'ların anladığı evrensel işaret
    CI: "1",
    // Buradaki somut suçlu: corepack indirme onayı
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    // npx "paket kurulsun mu?" sorusu
    npm_config_yes: "true",
    // git kimlik bilgisi istemi — sessizce sonsuza kadar bekleyen bir başkası
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    // apt / pip
    DEBIAN_FRONTEND: "noninteractive",
    PIP_NO_INPUT: "1",
  };

  async function execScript(
    workspaceId: string,
    script: string,
    opts: {
      timeoutMs: number;
      env?: Record<string, string>;
      sessionId?: string;
      /** Y3: file payloads ride stdin, never argv (see writeFile below). */
      stdinBase64?: string;
    } = {
      timeoutMs: 60_000,
    },
  ): Promise<ExecResult> {
    return http.exec(workspaceId, {
      command: ["/bin/sh", "-lc", script],
      cwd: "/work",
      timeoutMs: opts.timeoutMs,
      // Etkileşimsiz varsayılanlar HER exec yolunda: yalnız terminal.run'a
      // koymak yetmezdi — git.merge, fs.search ve yazma yolu da aynı kabuğu
      // kullanıyor ve aynı şekilde takılabilir.
      env: { ...NON_INTERACTIVE_ENV, ...opts.env },
      ...(opts.sessionId && { sessionId: opts.sessionId }),
      ...(opts.stdinBase64 !== undefined && { stdinBase64: opts.stdinBase64 }),
    });
  }

  /**
   * Y3 — the one way this module puts bytes into a workspace file.
   *
   * The content used to travel inside the shell command as a base64 argument.
   * Linux caps a single argv entry at MAX_ARG_STRLEN (128 KB) and base64 adds
   * a third, so anything over ~96 KB failed with a raw `E2BIG` in stderr —
   * while `fs.write` advertises 2 MB and `fs.edit` rewrites the WHOLE file,
   * meaning a three-line change in a 100 KB file also blew up. The agent had
   * no way to read that error, so it retried the same doomed call.
   *
   * Now the bytes go over stdin (`cat > file`), which has no size limit, and
   * the command line stays short and constant.
   */
  async function writeFile(
    workspaceId: string,
    path: string,
    content: Buffer,
  ): Promise<ExecResult> {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
    // NOTE: a stdin exec must not be asked for stdout. Half-closing stdin
    // tears down the whole hijacked Docker connection, so anything the command
    // prints afterwards is lost — `echo existed=$existed` came back empty and
    // fs.write reported `created: false` for a file it had just created. The
    // exit code survives (it is read back via exec inspect), so this command
    // reports success or failure ONLY through its exit status; everything the
    // caller needs to know is probed separately.
    const script = `mkdir -p ${shq(dir)} && cat > ${shq(path)}`;
    return execScript(workspaceId, script, {
      timeoutMs: 60_000,
      stdinBase64: content.toString("base64"),
    });
  }

  /** Cheap existence probe — the half of `fs.write` that needs an answer. */
  async function pathExists(workspaceId: string, path: string): Promise<boolean> {
    const probe = await execScript(workspaceId, `[ -e ${shq(path)} ] && echo YES || echo NO`);
    return probe.stdout.includes("YES");
  }

  const port: ToolDispatchPort = {
    // first-touch provisioning (bare repo + worktree clone + image pull +
    // container) happens here, OUTSIDE the tool's execution timeout window
    async prepare({ ctx: rawCtx, tool, agentId, taskId }) {
      const needsWorkspace = ["analysis", "coding", "testing"].includes(tool.sandboxLevel);
      if (!needsWorkspace || !taskId) return;
      await workspaceFor(
        companyContext(rawCtx.companyId),
        agentId,
        taskId,
        tool.sandboxLevel as IsolationLevel,
      );
    },

    async dispatch({ ctx: rawCtx, tool, input, agentId, taskId, agentSessionId, credentials }) {
      const ctx = companyContext(rawCtx.companyId);
      const args = input as Record<string, unknown>;

      // TASK 14 — read-only çağrı önbelleği (dedupe/anti-rescan)
      const cacheKey = READ_CACHE_TOOLS.has(tool.name)
        ? readCacheKey(taskId ?? null, tool.name, args)
        : null;
      if (cacheKey) {
        const cached = readCacheGet(cacheKey);
        if (cached) {
          return {
            output: cached.output,
            resultSummary: `♻ önbellek — ${cached.resultSummary}`,
          } as never;
        }
      }

      // git.merge is SERVER-SIDE in the bare repo (15 §3.6) — no workspace
      if (tool.name === "git.merge") {
        if (!taskId) throw new DispatchError("git.merge needs a task context");
        const eligibility = await reviewsService.mergeEligibility(ctx, taskId);
        if (!eligibility.eligible) {
          throw new DispatchError(
            `merge blocked — reviews not approved (${eligibility.missing.join(", ") || "none requested"})`,
          );
        }
        const [task] = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
        if (!task?.projectId) throw new DispatchError("git.merge needs a project task");
        // C2/Y5: a task used to be able to own several workspace rows over the
        // same volume, and this query took whichever came back first. One
        // workspace per task now, and the ordering makes the pick explicit for
        // tasks whose rows predate that fix.
        const [workspaceRow] = await db
          .select()
          .from(workspacesTable)
          .where(
            and(eq(workspacesTable.companyId, ctx.companyId), eq(workspacesTable.taskId, taskId)),
          )
          .orderBy(asc(workspacesTable.createdAt));
        const branch = (args.branch as string) || workspaceRow?.branch || "";
        if (!branch) throw new DispatchError("git.merge: no task branch found");
        const [agent] = await db
          .select({ name: agents.name, employeeNumber: agents.employeeNumber })
          .from(agents)
          .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)));
        const [company] = await db
          .select({ slug: companies.slug })
          .from(companies)
          .where(eq(companies.id, ctx.companyId));
        const approvedReviewers = (await reviewsService.listForTask(ctx, taskId))
          .filter((r) => r.status === "approved" && r.reviewerAgentId)
          .map((r) => `agent-${r.reviewerAgentId!.slice(-8)}`)
          .join(", ");
        const result = await http.mergeBranch({
          projectId: task.projectId,
          branch,
          message: `merge(${branch}): TASK-${task.number} ${task.title}`.slice(0, 200),
          authorName: agent?.name ?? "ACOS Lead",
          authorEmail: `agent-${String(agent?.employeeNumber ?? 0).padStart(3, "0")}@${company?.slug ?? "acos"}.acos`,
          reviewedBy: approvedReviewers || "review-chain",
        });
        if (!result.merged) {
          return {
            output: {
              merged: false,
              mergeCommitSha: "",
              conflict: { files: result.conflictFiles },
              provenance: "workspace",
            },
            resultSummary: `conflict in ${result.conflictFiles.length} file(s) — rebase in the owner workspace (15 §3.7)`,
          };
        }
        // merged: workspace → merged (locks release), reviews stamped, task → DONE
        if (workspaceRow) {
          if (workspaceRow.status === "ready") {
            await workspaces.transition(ctx, workspaceRow.id, "in_use", {
              actor: { kind: "agent", id: agentId },
            });
          }
          await workspaces
            .transition(ctx, workspaceRow.id, "merged", {
              actor: { kind: "agent", id: agentId },
              mergeCommit: result.mergeCommit,
            })
            .catch(() => {}); // already merged on a replay — fine
        }
        await reviewsService.recordMerge(ctx, taskId, result.mergeCommit);
        // O3/Faz E: bu çağrı her hatayı yutuyordu. Beklenen tek durum
        // görevin QA'da OLMAMASI (onay kapılı akışta motor kapatır) — onu
        // sessizce geçmek doğru. Ama merge OLDU, dal main'de; başka bir
        // sebeple DONE'a geçilemiyorsa bu, kimsenin görmediği bir yarım
        // teslimattır. Beklenmeyen hata artık çağırana dönüyor.
        try {
          await taskState.transition(ctx, taskId, "DONE", { kind: "system" });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          const expected = /illegal transition|may not perform|container/i.test(reason);
          if (!expected) {
            throw new DispatchError(
              `merge succeeded (${result.mergeCommit.slice(0, 8)}) but the task could not be closed: ${reason}`,
            );
          }
        }
        // GitHub yansıması (2026-08-18): merge main'e girdi → dış remote'a
        // best-effort yayın. Başarısızlık merge'i etkilemez (fire-and-forget).
        options.onMergeCompleted?.(ctx.companyId, task.projectId, result.mergeCommit, taskId);
        return {
          output: {
            merged: true,
            mergeCommitSha: result.mergeCommit,
            conflict: null,
            provenance: "workspace",
          },
          resultSummary: `squash-merged ${branch} → main @ ${result.mergeCommit.slice(0, 8)}`,
        };
      }

      // B1' — platform-data tools (17 §4): no workspace, no container. They
      // read the company's OWN tables through the same guarded services the
      // API uses, so tenant isolation and scope rules cannot diverge.
      if (tool.name === "task.query") {
        const statuses = (args.status as string[] | undefined) ?? [];
        const rows = await tasksService.list(ctx, {
          ...(statuses.length > 0 && { status: statuses }),
          ...(typeof args.ownerAgentId === "string" && { ownerAgentId: args.ownerAgentId }),
          ...(typeof args.projectId === "string" && { projectId: args.projectId }),
          ...(typeof args.search === "string" && { q: args.search }),
        });
        const limit = (args.limit as number) ?? 25;
        return {
          output: {
            tasks: rows.slice(0, limit).map((t) => ({
              id: t.id,
              number: t.number,
              title: t.title,
              status: t.status,
              ownerAgentId: t.ownerAgentId,
            })),
            total: rows.length,
            provenance: "platform",
          },
          resultSummary: `${Math.min(rows.length, limit)} of ${rows.length} task(s)`,
        };
      }

      // TASK 17 — preview.ports / http.request: proje runtime standardı.
      // Her ikisi de görevin KENDİ canlı workspace'ine bağlıdır; http.request
      // yalnız keşfedilmiş local portlara çıkabilir.
      if (tool.name === "preview.ports" || tool.name === "http.request") {
        if (!taskId) throw new DispatchError(`${tool.name} needs a task context`);
        const [ws] = await db
          .select({ id: workspacesTable.id, projectId: workspacesTable.projectId })
          .from(workspacesTable)
          .where(
            and(
              eq(workspacesTable.companyId, ctx.companyId),
              eq(workspacesTable.taskId, taskId),
              sql`${workspacesTable.status} NOT IN ('merged','discarded','failed','destroyed')`,
            ),
          )
          .limit(1);
        if (!ws) {
          throw new DispatchError(
            "bu görevin canlı workspace'i yok — önce terminal.run ile uygulamayı başlat",
          );
        }
        const sbHeaders = {
          authorization: `Bearer ${options.internalApiToken}`,
          "content-type": "application/json",
        };
        const portsRes = await fetch(
          `${options.sandboxManagerUrl}/internal/v1/workspaces/${ws.id}/ports`,
          { headers: sbHeaders },
        );
        if (!portsRes.ok) throw new DispatchError(`port discovery failed (${portsRes.status})`);
        const discovered = ((await portsRes.json()) as { ports: number[] }).ports;

        if (tool.name === "preview.ports") {
          const publicUrl = process.env.PUBLIC_SERVER_URL ?? "http://localhost:3000";
          const ports = discovered.map((port) => ({
            port,
            previewUrl: `${publicUrl}/preview/${ctx.companyId}/${ws.id}/${port}/`,
          }));
          // TASK 17: workspace.port.opened — Founder feed'i ve projektör görür
          if (ports.length > 0) {
            const { appendEvents } = await import("@acos/db");
            const { parseEventPayload } = await import("@acos/events");
            await db
              .transaction(async (tx) =>
                appendEvents(
                  tx,
                  ctx,
                  ports.map((p) => ({
                    type: "workspace.port.opened",
                    actor: { kind: "agent" as const, id: agentId },
                    taskId,
                    payload: parseEventPayload("workspace.port.opened", 1, {
                      workspaceId: ws.id,
                      port: p.port,
                      previewUrl: p.previewUrl,
                    }),
                  })),
                ),
              )
              .catch(() => {});
          }
          return {
            output: { ports, provenance: "workspace" },
            resultSummary:
              ports.length > 0
                ? `${ports.length} port: ${ports.map((p) => p.port).join(", ")}`
                : "dinleyen port yok — sunucu çalışıyor mu?",
          };
        }

        // http.request
        const port = args.port as number;
        if (!discovered.includes(port)) {
          throw new DispatchError(
            `port ${port} bu workspace'te dinlemiyor (keşfedilen: ${discovered.join(", ") || "yok"})`,
          );
        }
        const path = String(args.path ?? "/").replace(/^\//, "");
        const method = String(args.method ?? "GET");
        const headers: Record<string, string> = {
          ...sbHeaders,
          ...((args.headers as Record<string, string>) ?? {}),
        };
        const body = typeof args.body === "string" ? args.body : undefined;
        const res = await fetch(
          `${options.sandboxManagerUrl}/internal/v1/workspaces/${ws.id}/preview/${port}/${path}`,
          {
            method,
            headers,
            ...(body !== undefined && !["GET", "HEAD"].includes(method) && { body }),
            signal: AbortSignal.timeout(tool.timeoutMs),
          },
        );
        const text = await res.text();
        const MAX = 64_000;
        const expected = args.expectedStatus as number | undefined;
        return {
          output: {
            status: res.status,
            matchedExpected: expected === undefined ? null : res.status === expected,
            contentType: res.headers.get("content-type"),
            body: text.slice(0, MAX),
            truncated: text.length > MAX,
            provenance: "workspace",
          },
          resultSummary: `${method} :${port}/${path} → ${res.status}${
            expected !== undefined ? (res.status === expected ? " ✓" : ` ✗ (beklenen ${expected})`) : ""
          }`,
        };
      }

      // TASK 13 — code.search: Context Compiler'ın araç yüzü
      if (tool.name === "code.search") {
        if (!taskId) throw new DispatchError("code.search needs a task context");
        const [taskRow] = await db
          .select({ projectId: tasks.projectId })
          .from(tasks)
          .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
        if (!taskRow?.projectId) throw new DispatchError("task is not bound to a project");
        const { queryCodeIndex } = await import("../code-index/query.js");
        const result = await queryCodeIndex(
          {
            guardedDb: options.guardedDb,
            sandbox: { url: options.sandboxManagerUrl, token: options.internalApiToken },
          },
          {
            companyId: ctx.companyId,
            projectId: taskRow.projectId,
            taskId,
            terms: (args.terms as string[]) ?? [],
            limit: (args.limit as number) ?? 10,
          },
        );
        return {
          output: { ...result, provenance: "platform" },
          resultSummary: `${result.symbols.length} sembol (${result.indexState}${result.stale ? " — BAYAT" : ""})`,
        };
      }

      // TASK 10 — CEO org mutasyonları: Agent Factory sunucu tarafında,
      // deterministik. R3 olanlar buraya ancak Founder onayından geçerek düşer.
      if (tool.name === "org.team.create" || tool.name === "agent.hire") {
        const { StaffingService } = await import("../staffing/service.js");
        let projectId: string | undefined;
        if (taskId) {
          const [taskRow] = await db
            .select({ projectId: tasks.projectId })
            .from(tasks)
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
          projectId = taskRow?.projectId ?? undefined;
        }
        const count = tool.name === "agent.hire" ? ((args.count as number) ?? 1) : 0;
        const result = await new StaffingService(options.guardedDb).applyPlan(
          ctx,
          [{ capability: String(args.capability).toLowerCase(), count }],
          { projectId },
        );
        return {
          output:
            tool.name === "agent.hire"
              ? {
                  hiredAgentIds: result.hiredAgentIds,
                  createdUnits: result.createdUnits,
                  provenance: "platform",
                }
              : { createdUnits: result.createdUnits, provenance: "platform" },
          resultSummary:
            tool.name === "agent.hire"
              ? `${result.hiredAgentIds.length} ajan işe alındı (${String(args.capability)})`
              : `takım hazır: ${String(args.capability)}`,
        };
      }

      if (tool.name === "agent.assign_project") {
        if (!taskId) throw new DispatchError("agent.assign_project needs a task context");
        const [taskRow] = await db
          .select({ projectId: tasks.projectId })
          .from(tasks)
          .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
        if (!taskRow?.projectId) throw new DispatchError("task is not bound to a project");
        const { projectMembers } = await import("@acos/db/schema");
        await db
          .insert(projectMembers)
          .values({
            companyId: ctx.companyId,
            projectId: taskRow.projectId,
            agentId: String(args.agentId),
            role: String(args.role ?? "engineer"),
          })
          .onConflictDoNothing();
        return {
          output: { assigned: true, provenance: "platform" },
          resultSummary: `ajan projeye atandı`,
        };
      }

      if (tool.name === "model.bind") {
        const { agentModelBindings, modelProviders } = await import("@acos/db/schema");
        const [provider] = await db
          .select({ id: modelProviders.id })
          .from(modelProviders)
          .where(eq(modelProviders.name, String(args.provider)));
        if (!provider) throw new DispatchError(`unknown provider "${String(args.provider)}"`);
        await db
          .insert(agentModelBindings)
          .values({
            companyId: ctx.companyId,
            agentId: String(args.agentId),
            purpose: String(args.purpose),
            providerId: provider.id,
            model: String(args.model),
          })
          .onConflictDoNothing();
        return {
          output: { bound: true, provenance: "platform" },
          resultSummary: `model bağlandı: ${String(args.purpose)} → ${String(args.model)}`,
        };
      }

      // TASK 6 — github.repo.ensure: CEO niyeti; credential dispatch anında
      // sunucuda çözülür (GitHubConnection → secrets), ajana asla dönmez.
      if (tool.name === "github.repo.ensure") {
        if (!taskId) throw new DispatchError("github.repo.ensure needs a task context");
        const [task] = await db
          .select({ projectId: tasks.projectId })
          .from(tasks)
          .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
        if (!task?.projectId) {
          throw new DispatchError("github.repo.ensure requires a task bound to a project");
        }
        const { publishProjectToGithub } = await import("../integrations/github.js");
        const result = await publishProjectToGithub({
          db: options.guardedDb,
          masterKey: options.masterKey,
          sandbox: {
            url: options.sandboxManagerUrl,
            token: options.internalApiToken,
          },
          companyId: ctx.companyId,
          projectId: task.projectId,
        });
        return {
          output: {
            published: result.published,
            remoteUrl: result.remoteUrl,
            provenance: "platform",
          },
          resultSummary: result.published
            ? `GitHub remote hazır: ${result.remoteUrl}`
            : "GitHub bağlantısı yok — yansı atlandı",
        };
      }

      // B2' — web.fetch (17 §3.1: "via egress proxy; response wrapped with
      // provenance markers (S5)"). The response is UNTRUSTED external text:
      // `provenance: "web"` is what makes the agent loop wrap it in the S5
      // fence before it can reach a Working Set, so it is never optional.
      if (tool.name === "web.fetch") {
        if (!options.egressProxyUrl) {
          throw new DispatchError(
            "web.fetch needs the egress allowlist proxy — EGRESS_PROXY_URL is not configured",
          );
        }
        const maxBytes = (args.maxBytes as number) ?? 1_048_576;
        const method = (args.method as string) ?? "GET";
        const result = await fetchThroughProxy(String(args.url), {
          method,
          maxBytes,
          timeoutMs: tool.timeoutMs,
          proxyUrl: options.egressProxyUrl,
        });
        return {
          output: {
            status: result.status,
            contentType: result.contentType,
            body: result.body,
            truncated: result.truncated,
            provenance: "web",
          },
          resultSummary: `${method} ${result.status} · ${result.contentType || "unknown type"}${
            result.truncated ? ` · truncated at ${maxBytes}B` : ""
          }`,
        };
      }

      // B2' — web.search: the "configured search API adapter" of 17 §3.1. The
      // credential arrives from the gateway (S2: never from agent input), and
      // with no key configured the tool says so instead of pretending.
      if (tool.name === "web.search") {
        const apiKey = credentials["search.api_key"];
        if (!apiKey) {
          throw new DispatchError(
            "web.search has no configured search API key (credential search.api_key) — ask the Founder to configure one",
          );
        }
        if (!options.egressProxyUrl) {
          throw new DispatchError("web.search needs the egress proxy — EGRESS_PROXY_URL is not set");
        }
        const results = await searchTheWeb(String(args.query), {
          maxResults: (args.maxResults as number) ?? 8,
          apiKey,
          endpoint: options.searchApiUrl ?? DEFAULT_SEARCH_ENDPOINT,
          timeoutMs: tool.timeoutMs,
          proxyUrl: options.egressProxyUrl,
        });
        return {
          output: { results, provenance: "web" },
          resultSummary: `${results.length} result(s) for "${String(args.query).slice(0, 60)}"`,
        };
      }

      // B3' (Y2) — db.inspect. 17 §3.1: "READ-ONLY SQL against project DBs;
      // gateway rejects non-SELECT + enforces statement_timeout".
      //
      // The schema-layer check in @acos/tools is the second line of defence,
      // not the first: Postgres will happily run a writing CTE or an
      // `EXPLAIN ANALYZE DELETE` behind a SELECT-looking prefix. What makes a
      // write actually impossible is the transaction below — READ ONLY plus a
      // statement timeout, on a connection to the PROJECT's own database.
      if (tool.name === "db.inspect") {
        if (!taskId) throw new DispatchError("db.inspect needs a task context (project scope)");
        const [task] = await db
          .select({ projectId: tasks.projectId })
          .from(tasks)
          .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
        if (!task?.projectId) throw new DispatchError("db.inspect needs a project task");
        const envName = String(args.environment ?? "local");
        const [env] = await db
          .select({ config: environments.config })
          .from(environments)
          .where(
            and(
              eq(environments.companyId, ctx.companyId),
              eq(environments.projectId, task.projectId),
              eq(environments.name, envName),
            ),
          );
        const config = (env?.config ?? {}) as Record<string, unknown>;
        const url = config.databaseUrl ?? config.database_url;
        if (typeof url !== "string" || url.length === 0) {
          throw new DispatchError(
            `no database configured for environment "${envName}" — set environments.config.databaseUrl (ideally a READ-ONLY role) before using db.inspect`,
          );
        }
        // tenant leak guard: the platform DB holds every company's rows
        if (options.platformDatabaseUrl && sameDatabase(url, options.platformDatabaseUrl)) {
          throw new DispatchError(
            "db.inspect refuses the ACOS platform database — it is not a project database",
          );
        }
        const maxRows = (args.maxRows as number) ?? 100;
        const result = await runReadOnlyQuery(url, String(args.query), {
          maxRows,
          timeoutMs: tool.timeoutMs,
        });
        return {
          output: {
            columns: result.columns,
            rows: result.rows,
            rowCount: result.rowCount,
            truncated: result.truncated,
            provenance: "workspace",
          },
          resultSummary: `${result.rowCount} row(s)${result.truncated ? ` (truncated at ${maxRows})` : ""}`,
        };
      }

      if (tool.name === "memory.search") {
        let projectId: string | null = null;
        if (taskId) {
          const [task] = await db
            .select({ projectId: tasks.projectId })
            .from(tasks)
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
          projectId = task?.projectId ?? null;
        }
        const found = await memoryRetrieval.searchScoped(ctx, {
          agentId,
          projectId,
          taskId: taskId ?? null,
          query: String(args.query),
          scopes: (args.scopes as Array<"agent" | "project" | "company">) ?? [],
          limit: (args.limit as number) ?? 10,
        });
        return {
          output: { memories: found, provenance: "platform" },
          resultSummary:
            found.length === 0
              ? "no active memory matched (semantic lane skipped — lexical only)"
              : `${found.length} memory/memories, top score ${found[0]!.score.toFixed(2)}`,
        };
      }

      const needsWorkspace = ["analysis", "coding", "testing"].includes(tool.sandboxLevel);
      if (!needsWorkspace) {
        throw new DispatchError(`${tool.name} dispatch lands with a later task (T42/T43/T45)`);
      }
      if (!taskId) {
        throw new DispatchError(`${tool.name} needs a task context (workspace tools are per-task)`);
      }
      const level = tool.sandboxLevel as IsolationLevel;
      // fast path after prepare(): the live in_use row is returned as-is
      const ws = await workspaceFor(ctx, agentId, taskId, level);

      switch (tool.name) {
        case "terminal.run": {
          const timeoutSec = args.timeoutSec as number;
          // YAŞAYAN ajan terminali (2026-08-19 runtime, Munder davranışı):
          // oturum bağlamı varsa komut başına aç-kapa YOK — ajan+workspace
          // başına tek kalıcı oturum, bütün komutların kareleri aynı
          // `term.<id>` akışında/ringinde/logunda birikir ve Founder tek
          // pencerede canlı izler. 23 saatlik canlı koşuda terminal_sessions
          // 0 satırdı; komut başına oturum modeli açık kalsa bile izlenecek
          // tek sürekli akış üretmiyordu. Oturum bağlamı olmayan (doğrudan
          // HTTP) çağrılar eski komut-başına davranışı korur.
          const living = agentSessionId != null;
          const session = living
            ? await workspaces.ensureAgentTerminal(ctx, {
                workspaceId: ws.id,
                agentId,
                actor: { kind: "agent", id: agentId },
              })
            : await workspaces.openTerminal(ctx, {
                workspaceId: ws.id,
                agentId,
                title: String(args.command).slice(0, 120),
                actor: { kind: "agent", id: agentId },
              });
          // yaşayan akışta komutlar arasına kabuk-vari bir ayraç bas — izleyen
          // Founder hangi çıktının hangi komuta ait olduğunu görebilsin
          const script = living
            ? `printf '\\r\\n\\033[1;36m$ %s\\033[0m\\r\\n' ${shq(String(args.command))}; ${String(args.command)}`
            : String(args.command);
          try {
            const result = await execScript(ws.id, script, {
              timeoutMs: timeoutSec * 1000,
              // live PTY frames on term.<sessionId> while we await (T41)
              sessionId: session.id,
              env: {
                // 2026-08-19 KÖK NEDEN: burası HOME=/tmp + npm_config_cache=/tmp/.npm
                // enjekte ediyordu ve /tmp NOEXEC — npx'in indirdiği binary
                // çalıştırılamıyor, `create-next-app` her denemede exit 126
                // veriyordu. Konteyner env'i artık doğru adresi taşıyor
                // (workspaceEnv: HOME=/home/node exec'li tmpfs); exec'in onu
                // EZMEMESİ yeterli. Ajan args.env ile hâlâ bilerek ezebilir.
                ...(args.env as Record<string, string>),
              },
            });
            /**
             * Zaman aşımı AÇIKÇA bildirilir.
             *
             * `timedOut` alanı ExecResult'ta zaten vardı ama ajana hiç
             * ulaşmıyordu: ajan yalnız `exit=137` görüyor, bunun "komut
             * öldürüldü" mü "test kırıldı" mı olduğunu ayırt edemiyordu.
             * Canlı sonuç: corepack sorusunda takılan komutu üç kez aynı
             * şekilde tekrarladı. Sessiz başarısızlık, ajanın öğrenemediği
             * başarısızlıktır.
             */
            const timeoutNote = result.timedOut
              ? `TIMED OUT after ${timeoutSec}s and was killed — the command did not finish on its own. Commands run NON-INTERACTIVELY: nothing can answer a prompt, so a tool waiting for input will always end here. Re-run with the tool's non-interactive flag, or raise timeoutSec only if the work genuinely takes that long.`
              : "";
            return {
              output: {
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                ...(timeoutNote && { note: timeoutNote }),
                stdoutTail: tail(result.stdout),
                stderrTail: tail(result.stderr),
                durationMs: result.durationMs,
                terminalSessionId: session.id,
                provenance: "workspace",
              },
              costCents: Math.max(1, Math.ceil(result.durationMs / 60_000)),
              resultSummary: `exit=${result.exitCode} in ${result.durationMs}ms${
                result.timedOut ? " (TIMED OUT)" : ""
              }`,
            };
          } finally {
            // yaşayan oturum AÇIK kalır (workspace transition'ı ya da açılış
            // süpürmesi kapatır); yalnız komut-başına oturum burada kapanır
            if (!living) {
              await workspaces
                .closeTerminal(ctx, session.id, { kind: "agent", id: agentId })
                .catch(() => {});
            }
          }
        }

        case "fs.read": {
          const path = safeRelPath(String(args.path));
          const maxBytes = args.maxBytes as number;
          const result = await execScript(
            ws.id,
            `if [ -d ${shq(path)} ]; then echo DIR; ls -la ${shq(path)}; else echo FILE; head -c ${maxBytes + 1} ${shq(path)}; fi`,
          );
          if (result.exitCode !== 0) {
            throw new DispatchError(`fs.read failed: ${result.stderr.trim()}`);
          }
          const newline = result.stdout.indexOf("\n");
          const kind = result.stdout.slice(0, newline) === "DIR" ? "dir" : "file";
          let content = result.stdout.slice(newline + 1);
          const truncated = kind === "file" && content.length > maxBytes;
          if (truncated) content = content.slice(0, maxBytes);
          return {
            output: {
              kind,
              content,
              truncated,
              byteSize: Buffer.byteLength(content),
              provenance: "workspace",
            },
          };
        }

        case "fs.write": {
          const path = safeRelPath(String(args.path));
          // fail-closed (2026-08-15): var olan dosyaya tam-dosya yazma
          // reddedilir — model uzun dosyayı yeniden üretirken çıktı token
          // tavanına çarpıp gerisini sessizce siliyordu. Düzenleme fs.edit'ten
          // geçer; bilinçli yeniden yazım overwrite:true ile mümkün.
          const existedBefore = await pathExists(ws.id, path);
          if (args.overwrite !== true && existedBefore) {
            throw new DispatchError(
              `fs.write REFUSED: ${path} already exists. Use fs.edit {path, oldText, newText} for surgical changes (whole-file rewrites silently truncate long files). Pass overwrite:true only for a deliberate full rewrite.`,
            );
          }
          const content = String(args.content);
          const bytes =
            args.encoding === "base64"
              ? Buffer.from(content, "base64")
              : Buffer.from(content, "utf8");
          const result = await writeFile(ws.id, path, bytes);
          if (result.exitCode !== 0) {
            // an empty stderr with a non-zero exit is unactionable for the
            // agent — always carry the exit code too
            throw new DispatchError(
              `fs.write failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
            );
          }
          // T38 soft lock on the touched path — warn-not-block (15 §3.8)
          const lock = await workspaces.acquireLock(ctx, {
            workspaceId: ws.id,
            pathPrefix: path,
            actor: { kind: "agent", id: agentId },
          });
          return {
            output: {
              byteSize: bytes.length,
              created: !existedBefore,
              lockConflicts: lock.conflicts.map((c) => ({
                taskId: c.taskId ?? "",
                pathPrefix: c.pathPrefix,
              })),
              provenance: "workspace",
            },
          };
        }

        // fs.edit (2026-08-15): cerrahi düzenleme — dosya base64 olarak alınır,
        // eşleşme NODE tarafında birebir yapılır (shell escape riski yok) ve
        // tamamı geri yazılır. Eşleşme yoksa / çoklu eşleşme replaceAll'suzsa
        // yazma YAPILMAZ; ajan yapılandırılmış hatayı görür (fail-closed).
        case "fs.edit": {
          const path = safeRelPath(String(args.path));
          const oldText = String(args.oldText);
          const newText = String(args.newText);
          const replaceAll = args.replaceAll === true;
          const read = await execScript(ws.id, `base64 -w0 < ${shq(path)}`);
          if (read.exitCode !== 0) {
            throw new DispatchError(`fs.edit failed: cannot read ${path}: ${read.stderr.trim()}`);
          }
          const current = Buffer.from(read.stdout.trim(), "base64").toString("utf8");
          const occurrences = current.split(oldText).length - 1;
          if (occurrences === 0) {
            throw new DispatchError(
              `fs.edit NO_MATCH: oldText not found in ${path} — re-read the file and copy the exact snippet (whitespace included)`,
            );
          }
          if (occurrences > 1 && !replaceAll) {
            throw new DispatchError(
              `fs.edit AMBIGUOUS: oldText occurs ${occurrences} times in ${path} — include more surrounding context or set replaceAll:true`,
            );
          }
          const updated = replaceAll
            ? current.split(oldText).join(newText)
            : current.replace(oldText, newText);
          const write = await writeFile(ws.id, path, Buffer.from(updated, "utf8"));
          if (write.exitCode !== 0) {
            throw new DispatchError(`fs.edit failed: ${write.stderr.trim()}`);
          }
          const editLock = await workspaces.acquireLock(ctx, {
            workspaceId: ws.id,
            pathPrefix: path,
            actor: { kind: "agent", id: agentId },
          });
          return {
            output: {
              replacements: replaceAll ? occurrences : 1,
              byteSize: Buffer.byteLength(updated, "utf8"),
              lockConflicts: editLock.conflicts.map((c) => ({
                taskId: c.taskId ?? "",
                pathPrefix: c.pathPrefix,
              })),
              provenance: "workspace",
            },
          };
        }

        case "fs.search": {
          const pattern = String(args.pattern);
          const maxResults = args.maxResults as number;
          // O1: `glob` is part of the input schema, and the old dispatch
          // dropped it on the floor — the agent believed it had narrowed the
          // search to `*.ts` and got every match in the repo back, with no
          // hint that its filter had been ignored. `-E` matches the
          // documented regex dialect (the description promises ripgrep, i.e.
          // extended regex, while plain grep is BRE and quietly fails to
          // match things like `\d+` or `(a|b)`).
          const flags = args.caseSensitive ? "-rEn" : "-rEni";
          const glob = typeof args.glob === "string" && args.glob.length > 0 ? args.glob : null;
          const script = glob
            ? // find does the path filtering, so a `src/**/*.ts` style glob
              // works the same way an agent expects it to
              `find . -path ./.git -prune -o -type f ${
                glob.includes("/") ? "-path" : "-name"
              } ${shq(glob.includes("/") ? `./${glob.replace(/^\.\//, "")}` : glob)} -print0 ` +
              `| xargs -0 -r grep ${flags} -e ${shq(pattern)} | head -n ${maxResults + 1}`
            : `grep ${flags} --exclude-dir=.git -e ${shq(pattern)} . | head -n ${maxResults + 1}`;
          const result = await execScript(ws.id, script);
          // grep exit 1 = no matches — a result, not a failure
          if (result.exitCode > 1) {
            throw new DispatchError(`fs.search failed: ${result.stderr.trim()}`);
          }
          const lines = result.stdout.split("\n").filter(Boolean);
          const truncated = lines.length > maxResults;
          const matches = lines.slice(0, maxResults).map((line) => {
            const m = /^\.\/(.*?):(\d+):(.*)$/.exec(line);
            return m
              ? { path: m[1]!, line: Number(m[2]), text: m[3]! }
              : { path: "", line: 0, text: line };
          });
          return { output: { matches, truncated, provenance: "workspace" } };
        }

        case "git.diff": {
          const against = String(args.against ?? "main");
          if (!/^[\w./-]+$/.test(against)) throw new DispatchError(`bad ref: ${against}`);
          const paths = (args.paths as string[]).map((p) => shq(safeRelPath(p))).join(" ");
          const mode = args.stat ? "--stat" : "";
          const result = await execScript(
            ws.id,
            `git diff ${mode} ${shq(against)} -- ${paths} 2>/dev/null || git diff ${mode} -- ${paths}`,
          );
          const body = tail(result.stdout);
          const filesChanged = new Set(
            result.stdout.split("\n").filter((l) => l.startsWith("diff --git")),
          ).size;
          return {
            output: {
              diff: body,
              filesChanged,
              truncated: body.length < result.stdout.length,
              provenance: "workspace",
            },
          };
        }

        case "git.commit": {
          // Task: trailer is derived server-side and cannot reference a
          // different task (15 §3.4); author = agent identity, never a model
          const [task] = await db
            .select({ number: tasks.number })
            .from(tasks)
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
          const [agent] = await db
            .select({ name: agents.name, employeeNumber: agents.employeeNumber })
            .from(agents)
            .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)));
          const [company] = await db
            .select({ slug: companies.slug })
            .from(companies)
            .where(eq(companies.id, ctx.companyId));
          const message = String(args.message).replace(/^Task:.*$/gm, "").trimEnd();
          const trailer = `Task: TASK-${task!.number}`;
          const author = `${agent!.name} <agent-${String(agent!.employeeNumber).padStart(3, "0")}@${company!.slug}.acos>`;
          const paths = (args.paths as string[]).map((p) => shq(safeRelPath(p)));
          const addCmd = paths.length > 0 ? `git add -- ${paths.join(" ")}` : "git add -A";
          const empty = args.allowEmpty ? "--allow-empty" : "";
          const result = await execScript(
            ws.id,
            [
              `export GIT_AUTHOR_NAME=${shq(agent!.name)} GIT_AUTHOR_EMAIL=${shq(author.slice(author.indexOf("<") + 1, -1))}`,
              `export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"`,
              addCmd,
              `git commit ${empty} -m ${shq(`${message}\n\n${trailer}`)}`,
              `git rev-parse HEAD`,
              `git diff-tree --no-commit-id --name-only -r HEAD | wc -l`,
              `git rev-parse --abbrev-ref HEAD`,
            ].join(" && "),
          );
          if (result.exitCode !== 0) {
            throw new DispatchError(`git.commit failed: ${tail(result.stderr).trim()}`);
          }
          const lines = result.stdout.trim().split("\n");
          return {
            output: {
              commitSha: lines.at(-3)?.trim() ?? "",
              filesCommitted: Number(lines.at(-2)?.trim() ?? 0),
              branch: lines.at(-1)?.trim() ?? "",
              provenance: "workspace",
            },
            resultSummary: `commit ${lines.at(-3)?.slice(0, 8)} on ${lines.at(-1)}`,
          };
        }

        case "git.branch": {
          // push the task branch worktree → bare repo (T43, 15 §3.1); force
          // only ever reaches task/* (sandbox-manager re-enforces the guard)
          const branch = (args.branch as string) || ws.branch || "";
          if (!ws.volumePath) throw new DispatchError("workspace has no worktree volume");
          const pushed = await http.pushBranch({
            projectId: ws.projectId,
            volumeName: ws.volumePath,
            branch,
            force: args.force === true,
          });
          return {
            output: { pushed: true, remoteHead: pushed.remoteHead, provenance: "workspace" },
            resultSummary: `pushed ${branch} @ ${pushed.remoteHead.slice(0, 8)}`,
          };
        }

        default:
          throw new DispatchError(`${tool.name} dispatch lands with a later task (T43/T45)`);
      }
    },
  };
  // TASK 14: başarılı read-only sonuçlar önbelleğe yazılır (girişteki GET
  // ile birlikte dedupe tamamlanır)
  const rawDispatch = port.dispatch.bind(port);
  port.dispatch = async (req) => {
    const result = await rawDispatch(req);
    const key = READ_CACHE_TOOLS.has(req.tool.name)
      ? readCacheKey(req.taskId ?? null, req.tool.name, req.input)
      : null;
    const summary = String((result as { resultSummary?: string }).resultSummary ?? "");
    if (key && !summary.startsWith("♻")) {
      readCachePut(key, result as { output: unknown; resultSummary: string });
    }
    return result;
  };
  return port;
}
