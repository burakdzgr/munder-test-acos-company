// CodeIndex servisi (REVISION TASK 4): bare repo anlık görüntüsünü çeker,
// AST ile ayrıştırır, CodeIndexService (db) ile saklar. İki giriş:
//  - rebuild: tam indeks (intake sonrası / manuel)
//  - updateFromMerge: git diff'ten yalnız değişen dosyalar (incremental)
import { companyContext, CodeIndexService, type GuardedDb, type ParsedFileIndex } from "@acos/db";
import { indexerFor, INDEXABLE_FILE } from "./indexers/index.js";

export interface CodeIndexerDeps {
  guardedDb: GuardedDb;
  sandbox: { url: string; token: string };
}

const CODE_FILE = INDEXABLE_FILE;

async function sandboxJson<T>(
  deps: CodeIndexerDeps,
  path: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(`${deps.sandbox.url}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.sandbox.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`sandbox ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

interface Snapshot {
  head: string;
  files: Array<{ path: string; sha: string; contentBase64: string }>;
}

function parseSnapshot(files: Snapshot["files"], extraPaths: string[] = []): ParsedFileIndex[] {
  const knownPaths = new Set([...files.map((f) => f.path), ...extraPaths]);
  const parsed: ParsedFileIndex[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = Buffer.from(file.contentBase64, "base64").toString("utf8");
    } catch {
      continue;
    }
    if (content.length > 500_000) continue;
    try {
      // TASK 4: dil adapter'ı kayıttan seçilir — TS/Python/Generic…
      parsed.push(
        indexerFor(file.path).parse({ path: file.path, sha: file.sha, content, knownPaths }),
      );
    } catch {
      // tek dosyanın parse hatası indeksi durdurmaz
    }
  }
  return parsed;
}

export async function rebuildCodeIndex(
  deps: CodeIndexerDeps,
  companyId: string,
  projectId: string,
) {
  // TASK 3 (INVARIANT 3): indeks durumu ve commit bağlaması proje satırında
  const { projects } = await import("@acos/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const ctx = companyContext(companyId);
  const mark = (state: string, extra: Record<string, unknown> = {}) =>
    deps.guardedDb
      .update(projects)
      .set({ indexState: state, ...extra })
      .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, projectId)));
  await mark("running");
  try {
    const snapshot = await sandboxJson<Snapshot>(deps, "/internal/v1/repos/code-snapshot", {
      projectId,
    });
    const parsed = parseSnapshot(snapshot.files);
    const service = new CodeIndexService(deps.guardedDb);
    const result = await service.replaceIndex(ctx, projectId, parsed, { full: true });
    await mark("ready", { indexCommitSha: snapshot.head, headSha: snapshot.head });
    return { head: snapshot.head, ...result };
  } catch (err) {
    await mark("failed").catch(() => {});
    throw err;
  }
}

/** Merge sonrası incremental güncelleme: mergeCommit~1..mergeCommit diff'i. */
export async function updateCodeIndexFromMerge(
  deps: CodeIndexerDeps,
  companyId: string,
  projectId: string,
  mergeCommit: string,
  previousCommit: string,
) {
  const diff = await sandboxJson<{ changed: string[] }>(
    deps,
    "/internal/v1/repos/changed-files",
    { projectId, from: previousCommit, to: mergeCommit },
  );
  const codePaths = diff.changed.filter(
    (p) => CODE_FILE.test(p) && !p.includes("node_modules/"),
  );
  if (codePaths.length === 0) {
    return { filesIndexed: 0, filesSkipped: 0, filesRemoved: 0, symbols: 0, edges: 0 };
  }
  // değişen dosyalara kenarı olan komşular da snapshot'a girer — sembolleri
  // yeniden yazılmaz ama giden kenarları tazelenir (cascade telafisi)
  const { codeEdges: edgesTable, codeFiles: filesTable } = await import("@acos/db/schema");
  const drizzle = await import("drizzle-orm");
  const ctxEarly = companyContext(companyId);
  const targets = await deps.guardedDb
    .select({ id: filesTable.id, path: filesTable.path })
    .from(filesTable)
    .where(
      drizzle.and(
        drizzle.eq(filesTable.companyId, ctxEarly.companyId),
        drizzle.eq(filesTable.projectId, projectId),
        drizzle.inArray(filesTable.path, codePaths),
      ),
    );
  let dependentPaths: string[] = [];
  if (targets.length > 0) {
    const dependents = await deps.guardedDb
      .select({ path: filesTable.path })
      .from(edgesTable)
      .innerJoin(filesTable, drizzle.eq(filesTable.id, edgesTable.fromFileId))
      .where(
        drizzle.and(
          drizzle.eq(edgesTable.companyId, ctxEarly.companyId),
          drizzle.inArray(edgesTable.toFileId, targets.map((t) => t.id)),
        ),
      );
    dependentPaths = [...new Set(dependents.map((d) => d.path))].filter(
      (p) => !codePaths.includes(p),
    );
  }
  const snapshot = await sandboxJson<Snapshot>(deps, "/internal/v1/repos/code-snapshot", {
    projectId,
    paths: [...codePaths, ...dependentPaths],
  });
  const present = new Set(snapshot.files.map((f) => f.path));
  const removedPaths = codePaths.filter((p) => !present.has(p));
  // göreli import'lar değişmeyen dosyalara da çözülebilsin: bilinen yol
  // kümesi = snapshot + mevcut indeksteki yollar
  const { codeFiles } = await import("@acos/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const ctx = companyContext(companyId);
  const indexed = await deps.guardedDb
    .select({ path: codeFiles.path })
    .from(codeFiles)
    .where(and(eq(codeFiles.companyId, ctx.companyId), eq(codeFiles.projectId, projectId)));
  const parsed = parseSnapshot(snapshot.files, indexed.map((f) => f.path));
  const service = new CodeIndexService(deps.guardedDb);
  const result = await service.replaceIndex(ctx, projectId, parsed, {
    full: false,
    removedPaths,
  });
  // TASK 3/5: canonical indeks bu merge commit'ine bağlandı
  const { projects: projectsTable } = await import("@acos/db/schema");
  await deps.guardedDb
    .update(projectsTable)
    .set({ indexState: "ready", indexCommitSha: mergeCommit, headSha: mergeCommit })
    .where(
      (await import("drizzle-orm")).and(
        (await import("drizzle-orm")).eq(projectsTable.companyId, ctx.companyId),
        (await import("drizzle-orm")).eq(projectsTable.id, projectId),
      ),
    );
  return result;
}

/**
 * TASK 5 — Task Overlay: görev worktree'ının default branch'e göre değişen
 * dosyaları 'task:<taskId>' katmanına indekslenir. Context sorgusu canonical
 * + overlay birlikte okur; merge sonrası katman silinir.
 */
export async function updateTaskOverlayIndex(
  deps: CodeIndexerDeps,
  companyId: string,
  projectId: string,
  taskId: string,
): Promise<{ overlayRef: string; filesIndexed: number; deleted: number; head: string } | null> {
  const { workspaces } = await import("@acos/db/schema");
  const drizzle = await import("drizzle-orm");
  const ctx = companyContext(companyId);
  const [ws] = await deps.guardedDb
    .select({ volumePath: workspaces.volumePath })
    .from(workspaces)
    .where(
      drizzle.and(
        drizzle.eq(workspaces.companyId, ctx.companyId),
        drizzle.eq(workspaces.taskId, taskId),
        drizzle.sql`${workspaces.status} NOT IN ('merged','discarded','failed','destroyed')`,
      ),
    )
    .limit(1);
  if (!ws?.volumePath) return null; // canlı worktree yok — overlay üretilmez
  const snapshot = await sandboxJson<{
    head: string;
    files: Array<{ path: string; sha: string; contentBase64: string }>;
    deleted: string[];
  }>(deps, "/internal/v1/worktrees/code-snapshot", { volumeName: ws.volumePath });

  const overlayRef = `task:${taskId}`;
  const { codeFiles } = await import("@acos/db/schema");
  const canonical = await deps.guardedDb
    .select({ path: codeFiles.path })
    .from(codeFiles)
    .where(
      drizzle.and(
        drizzle.eq(codeFiles.companyId, ctx.companyId),
        drizzle.eq(codeFiles.projectId, projectId),
        drizzle.isNull(codeFiles.overlayRef),
      ),
    );
  const parsed = parseSnapshot(snapshot.files, canonical.map((f) => f.path));
  const service = new CodeIndexService(deps.guardedDb);
  const result = await service.replaceIndex(ctx, projectId, parsed, {
    full: true, // katman içi tam eşitleme: değişen küme = katmanın tamamı
    overlayRef,
  });
  return {
    overlayRef,
    filesIndexed: result.filesIndexed + result.filesSkipped,
    deleted: snapshot.deleted.length,
    head: snapshot.head,
  };
}

export async function deleteTaskOverlayIndex(
  deps: CodeIndexerDeps,
  companyId: string,
  projectId: string,
  taskId: string,
): Promise<number> {
  const service = new CodeIndexService(deps.guardedDb);
  return service.deleteOverlay(companyContext(companyId), projectId, `task:${taskId}`);
}
