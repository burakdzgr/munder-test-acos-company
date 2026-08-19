// CodeIndex depolama (REVISION TASK 4). Parser (apps/server) AST'den
// ParsedFileIndex üretir; burası tek transaction'da dosya/sembol/kenar
// satırlarını değiştirir. Incremental: sha değişmeyen dosya atlanır, yalnız
// değişen dosyaların sembol+kenarları yeniden yazılır.
//
// Kenar tazeliği: `files` içinde gelen HER dosyanın giden kenarları yeniden
// kurulur (sembol satırları yalnız sha değiştiyse yazılır). Böylece değişen
// dosyanın sembolleri cascade ile düşse bile, snapshot'a katılan komşu
// dosyaların kenarları aynı transaction'da geri gelir.
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { codeEdges, codeFiles, codeSymbols } from "./schema/index.js";

export interface ParsedSymbol {
  name: string;
  kind: "class" | "function" | "method" | "interface" | "type" | "enum" | "const";
  startLine: number;
  endLine: number;
  exported: boolean;
}

export interface ParsedImport {
  /** import belirtimi ("./util.js", "react", …) */
  module: string;
  /** proje içi çözülmüş yol (repo-relative) — dışsa null */
  resolvedPath: string | null;
  /** named import'lar */
  names: string[];
}

export interface ParsedFileIndex {
  path: string;
  sha: string;
  language: string;
  loc: number;
  isTest: boolean;
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  /** çağrılan tanımlayıcı adları (call/called_by kenarları için) */
  calls: string[];
  /** TASK 4: sınıf/arayüz kalıtımı — implements/extends kenarları */
  heritage?: Array<{ symbol: string; kind: "implements" | "extends"; target: string }>;
}

export interface CodeIndexResult {
  filesIndexed: number;
  filesSkipped: number;
  filesRemoved: number;
  symbols: number;
  edges: number;
}

const EDGE_CAP_PER_FILE = 300;

export class CodeIndexService {
  constructor(private readonly db: GuardedDb) {}

  async replaceIndex(
    ctx: CompanyContext,
    projectId: string,
    files: ParsedFileIndex[],
    opts: { full: boolean; removedPaths?: string[]; overlayRef?: string | null },
  ): Promise<CodeIndexResult> {
    // TASK 5: overlayRef NULL → canonical katman; 'task:<id>' → o görev
    // worktree'ının gölge katmanı. Bütün yazma işlemleri kendi katmanına
    // hapsolur; çözümleme haritaları canonical+overlay birlikte okur.
    const overlayRef = opts.overlayRef ?? null;
    const layerFilter = overlayRef === null
      ? isNull(codeFiles.overlayRef)
      : eq(codeFiles.overlayRef, overlayRef);
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: codeFiles.id, path: codeFiles.path, sha: codeFiles.sha })
        .from(codeFiles)
        .where(
          and(
            eq(codeFiles.companyId, ctx.companyId),
            eq(codeFiles.projectId, projectId),
            layerFilter,
          ),
        );
      const existingByPath = new Map(existing.map((f) => [f.path, f]));
      const incomingPaths = new Set(files.map((f) => f.path));

      // silinen dosyalar: full'de "artık ağaçta yok", incremental'da açık liste
      const toRemove = opts.full
        ? existing.filter((f) => !incomingPaths.has(f.path)).map((f) => f.id)
        : existing
            .filter((f) => (opts.removedPaths ?? []).includes(f.path))
            .map((f) => f.id);
      if (toRemove.length > 0) {
        await tx
          .delete(codeFiles)
          .where(and(eq(codeFiles.companyId, ctx.companyId), inArray(codeFiles.id, toRemove)));
      }

      let filesSkipped = 0;
      const changed: Array<{ file: ParsedFileIndex; fileId: string }> = [];
      /** sha değişmedi ama giden kenarları tazelenecek dosyalar */
      const edgeOnly: Array<{ file: ParsedFileIndex; fileId: string }> = [];
      for (const file of files) {
        const prior = existingByPath.get(file.path);
        if (prior && prior.sha === file.sha) {
          filesSkipped += 1;
          edgeOnly.push({ file, fileId: prior.id });
          continue;
        }
        if (prior) {
          await tx
            .update(codeFiles)
            .set({
              sha: file.sha,
              language: file.language,
              loc: file.loc,
              isTest: file.isTest,
              indexedAt: sql`now()`,
            })
            .where(and(eq(codeFiles.companyId, ctx.companyId), eq(codeFiles.id, prior.id)));
          await tx
            .delete(codeSymbols)
            .where(and(eq(codeSymbols.companyId, ctx.companyId), eq(codeSymbols.fileId, prior.id)));
          await tx
            .delete(codeEdges)
            .where(and(eq(codeEdges.companyId, ctx.companyId), eq(codeEdges.fromFileId, prior.id)));
          changed.push({ file, fileId: prior.id });
        } else {
          const [inserted] = await tx
            .insert(codeFiles)
            .values({
              companyId: ctx.companyId,
              projectId,
              path: file.path,
              language: file.language,
              sha: file.sha,
              loc: file.loc,
              isTest: file.isTest,
              overlayRef,
            })
            .returning({ id: codeFiles.id });
          changed.push({ file, fileId: inserted!.id });
        }
      }

      // sembolleri yaz
      let symbolCount = 0;
      for (const { file, fileId } of changed) {
        if (file.symbols.length === 0) continue;
        await tx.insert(codeSymbols).values(
          file.symbols.slice(0, 500).map((s) => ({
            companyId: ctx.companyId,
            projectId,
            fileId,
            name: s.name.slice(0, 300),
            kind: s.kind,
            startLine: s.startLine,
            endLine: s.endLine,
            exported: s.exported,
          })),
        );
        symbolCount += Math.min(file.symbols.length, 500);
      }

      // çözümleme haritaları: path→fileId ve sembol adı→[{id,fileId}]
      const allFiles = await tx
        .select({ id: codeFiles.id, path: codeFiles.path, overlayRef: codeFiles.overlayRef })
        .from(codeFiles)
        .where(
          and(
            eq(codeFiles.companyId, ctx.companyId),
            eq(codeFiles.projectId, projectId),
            overlayRef === null
              ? isNull(codeFiles.overlayRef)
              : sql`(${codeFiles.overlayRef} IS NULL OR ${codeFiles.overlayRef} = ${overlayRef})`,
          ),
        );
      // önce canonical, sonra overlay — overlay aynı path'i gölgeler
      const fileIdByPath = new Map<string, string>();
      for (const f of allFiles.filter((x) => x.overlayRef === null)) fileIdByPath.set(f.path, f.id);
      for (const f of allFiles.filter((x) => x.overlayRef !== null)) fileIdByPath.set(f.path, f.id);
      const layerFileIds = allFiles.map((f) => f.id);
      const allSymbols = layerFileIds.length
        ? await tx
            .select({ id: codeSymbols.id, name: codeSymbols.name, fileId: codeSymbols.fileId })
            .from(codeSymbols)
            .where(
              and(
                eq(codeSymbols.companyId, ctx.companyId),
                eq(codeSymbols.projectId, projectId),
                inArray(codeSymbols.fileId, layerFileIds),
              ),
            )
        : [];
      const symbolsByName = new Map<string, Array<{ id: string; fileId: string }>>();
      for (const s of allSymbols) {
        const list = symbolsByName.get(s.name) ?? [];
        list.push({ id: s.id, fileId: s.fileId });
        symbolsByName.set(s.name, list);
      }
      const symbolsByFile = new Map<string, Map<string, string>>();
      for (const s of allSymbols) {
        const m = symbolsByFile.get(s.fileId) ?? new Map<string, string>();
        m.set(s.name, s.id);
        symbolsByFile.set(s.fileId, m);
      }

      // kenarları yaz — sembolü değişenler + kenar-tazelenenler
      for (const { fileId } of edgeOnly) {
        await tx
          .delete(codeEdges)
          .where(and(eq(codeEdges.companyId, ctx.companyId), eq(codeEdges.fromFileId, fileId)));
      }
      let edgeCount = 0;
      for (const { file, fileId } of [...changed, ...edgeOnly]) {
        const rows: Array<typeof codeEdges.$inferInsert> = [];
        for (const imp of file.imports) {
          const toFileId = imp.resolvedPath ? (fileIdByPath.get(imp.resolvedPath) ?? null) : null;
          rows.push({
            companyId: ctx.companyId,
            projectId,
            kind: "import",
            fromFileId: fileId,
            toFileId,
            toModule: imp.module.slice(0, 300),
          });
          // reference: named import → hedef dosyada aynı adlı sembol
          if (toFileId) {
            const targetSymbols = symbolsByFile.get(toFileId);
            for (const name of imp.names.slice(0, 50)) {
              const toSymbolId = targetSymbols?.get(name);
              if (toSymbolId) {
                rows.push({
                  companyId: ctx.companyId,
                  projectId,
                  kind: "reference",
                  fromFileId: fileId,
                  toFileId,
                  toSymbolId,
                  symbolName: name.slice(0, 300),
                });
              }
            }
            if (file.isTest) {
              rows.push({
                companyId: ctx.companyId,
                projectId,
                kind: "tests",
                fromFileId: fileId,
                toFileId,
              });
            }
          }
        }
        // implements / extends (TASK 4): hedef ad proje genelinde tek
        // sembole çözülürse bağlanır; çözülmezse ad-only kenar kalır
        for (const h of (file.heritage ?? []).slice(0, 50)) {
          const matches = symbolsByName.get(h.target);
          const unique = matches && matches.length === 1 ? matches[0] : null;
          rows.push({
            companyId: ctx.companyId,
            projectId,
            kind: h.kind,
            fromFileId: fileId,
            toFileId: unique?.fileId ?? null,
            toSymbolId: unique?.id ?? null,
            symbolName: `${h.symbol}->${h.target}`.slice(0, 300),
          });
        }
        // call: tanımlayıcı proje genelinde TEK sembole çözülüyorsa kenar yaz
        for (const callee of [...new Set(file.calls)].slice(0, 200)) {
          const matches = symbolsByName.get(callee);
          if (matches && matches.length === 1 && matches[0]!.fileId !== fileId) {
            rows.push({
              companyId: ctx.companyId,
              projectId,
              kind: "call",
              fromFileId: fileId,
              toFileId: matches[0]!.fileId,
              toSymbolId: matches[0]!.id,
              symbolName: callee.slice(0, 300),
            });
          }
        }
        const capped = rows.slice(0, EDGE_CAP_PER_FILE);
        if (capped.length > 0) {
          await tx.insert(codeEdges).values(capped);
          edgeCount += capped.length;
        }
      }

      return {
        filesIndexed: changed.length,
        filesSkipped,
        filesRemoved: toRemove.length,
        symbols: symbolCount,
        edges: edgeCount,
      };
    });
  }

  /** TASK 5: merge sonrası görevin gölge katmanı düşer. */
  async deleteOverlay(ctx: CompanyContext, projectId: string, overlayRef: string): Promise<number> {
    const rows = await this.db
      .delete(codeFiles)
      .where(
        and(
          eq(codeFiles.companyId, ctx.companyId),
          eq(codeFiles.projectId, projectId),
          eq(codeFiles.overlayRef, overlayRef),
        ),
      )
      .returning({ id: codeFiles.id });
    return rows.length;
  }

  async summary(ctx: CompanyContext, projectId: string) {
    const result = await this.db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM code_files
          WHERE company_id = ${ctx.companyId} AND project_id = ${projectId}) AS files,
        (SELECT count(*)::int FROM code_symbols
          WHERE company_id = ${ctx.companyId} AND project_id = ${projectId}) AS symbols,
        (SELECT count(*)::int FROM code_edges
          WHERE company_id = ${ctx.companyId} AND project_id = ${projectId}) AS edges,
        (SELECT count(*)::int FROM code_files
          WHERE company_id = ${ctx.companyId} AND project_id = ${projectId} AND is_test) AS test_files
    `);
    const row = result.rows[0] as {
      files: number;
      symbols: number;
      edges: number;
      test_files: number;
    };
    return {
      files: Number(row.files),
      symbols: Number(row.symbols),
      edges: Number(row.edges),
      testFiles: Number(row.test_files),
    };
  }
}
