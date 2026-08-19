// PythonIndexer (LIFECYCLE TASK 4): satır-yapısal deterministic çıkarım —
// def/class blokları girinti ile, importlar ve sınıf kalıtımı. Tam AST değil
// ama sembol/kenar grafiği kanonik şemaya oturur; daha derin analiz isteyen
// kurulum bu adapter'ı gerçek parser'la değiştirebilir.
import type { ParsedImport, ParsedSymbol } from "@acos/db";
import type { LanguageIndexer } from "./index.js";

const TEST_PATH = /(?:^|\/)test_[^/]+\.py$|_test\.py$|(?:^|\/)tests?\//;

function resolvePyImport(
  fromPath: string,
  module: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  // "pkg.mod" → pkg/mod.py veya pkg/mod/__init__.py; göreli "." önekleri
  // dosyanın dizininden yukarı sayılır.
  let parts = fromPath.split("/").slice(0, -1);
  let rest = module;
  while (rest.startsWith(".")) {
    rest = rest.slice(1);
    if (rest.startsWith(".")) parts = parts.slice(0, -1);
  }
  const segs = rest.split(".").filter(Boolean);
  for (const base of [parts.concat(segs), segs]) {
    const joined = base.join("/");
    for (const candidate of [`${joined}.py`, `${joined}/__init__.py`]) {
      if (knownPaths.has(candidate)) return candidate;
    }
  }
  return null;
}

export const pythonIndexer: LanguageIndexer = {
  name: "python",
  matches: (path) => /\.py$/.test(path),
  parse: ({ path, sha, content, knownPaths }) => {
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const calls = new Set<string>();
    const heritage: Array<{ symbol: string; kind: "implements" | "extends"; target: string }> = [];
    const lines = content.split("\n");

    let currentClass: { name: string; indent: number } | null = null;
    lines.forEach((line, i) => {
      const lineNo = i + 1;
      const indent = line.length - line.trimStart().length;
      if (currentClass && indent <= currentClass.indent && line.trim().length > 0) {
        currentClass = null;
      }
      let m = /^(\s*)class\s+([A-Za-z_]\w*)\s*(?:\(([^)]*)\))?\s*:/.exec(line);
      if (m) {
        const name = m[2]!;
        symbols.push({ name, kind: "class", startLine: lineNo, endLine: lineNo, exported: true });
        for (const base of (m[3] ?? "").split(",").map((b) => b.trim()).filter(Boolean)) {
          const target = base.split(".").pop()!;
          if (/^[A-Za-z_]\w*$/.test(target) && target !== "object") {
            heritage.push({ symbol: name, kind: "extends", target });
          }
        }
        currentClass = { name, indent: m[1]!.length };
        return;
      }
      m = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
      if (m) {
        const inClass = currentClass && m[1]!.length > currentClass.indent;
        const name = inClass ? `${currentClass!.name}.${m[2]!}` : m[2]!;
        symbols.push({
          name,
          kind: inClass ? "method" : "function",
          startLine: lineNo,
          endLine: lineNo,
          exported: !m[2]!.startsWith("_"),
        });
        return;
      }
      m = /^\s*from\s+([\w.]+)\s+import\s+(.+)$/.exec(line);
      if (m) {
        const names = m[2]!
          .split(",")
          .map((n) => n.trim().split(/\s+as\s+/)[0]!.trim())
          .filter((n) => /^[A-Za-z_]\w*$/.test(n));
        imports.push({
          module: m[1]!,
          resolvedPath: resolvePyImport(path, m[1]!, knownPaths),
          names,
        });
        return;
      }
      m = /^\s*import\s+([\w.]+)/.exec(line);
      if (m) {
        imports.push({
          module: m[1]!,
          resolvedPath: resolvePyImport(path, m[1]!, knownPaths),
          names: [],
        });
        return;
      }
      // çağrılar: name( — anahtar kelimeler hariç
      for (const call of line.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
        const callee = call[1]!;
        if (!["if", "for", "while", "return", "print", "def", "class", "with", "elif"].includes(callee)) {
          calls.add(callee);
        }
      }
    });

    return {
      path,
      sha,
      language: "python",
      loc: lines.length,
      isTest: TEST_PATH.test(path),
      symbols,
      imports,
      calls: [...calls],
      heritage,
    };
  },
};
