// AST parser (REVISION TASK 4): TypeScript compiler API ile gerçek sembol
// çıkarımı — regex değil. Tek dosya → ParsedFileIndex (sembol, import, call).
// tsx/jsx dahil; dil bilgisi dosya uzantısından.
import ts from "typescript";
import type { ParsedFileIndex, ParsedImport, ParsedSymbol } from "@acos/db";

const TEST_PATH = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:__tests__\/)|(?:^|\/)tests?\//;

function languageOf(path: string): string {
  if (/\.tsx$/.test(path)) return "tsx";
  if (/\.[cm]?ts$/.test(path)) return "ts";
  if (/\.jsx$/.test(path)) return "jsx";
  return "js";
}

/** "./util.js" gibi göreli belirtimleri repo-relative yola çözer. */
export function resolveRelativeImport(
  fromPath: string,
  spec: string,
  knownPaths: ReadonlySet<string>,
): string | null {
  if (!spec.startsWith(".")) return null;
  const dir = fromPath.split("/").slice(0, -1);
  const parts = [...dir];
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    else if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const base = parts.join("/");
  const candidates = [
    base,
    // TS çıktı-uzantısı düzeltmesi: "./x.js" kaynakta "./x.ts" olabilir
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base.replace(/\.mjs$/, ".mts"),
    base.replace(/\.cjs$/, ".cts"),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  for (const c of candidates) {
    if (knownPaths.has(c)) return c;
  }
  return null;
}

export function parseSourceFile(input: {
  path: string;
  sha: string;
  content: string;
  /** proje ağacındaki tüm yollar — göreli import çözümü için */
  knownPaths: ReadonlySet<string>;
}): ParsedFileIndex {
  const { path, sha, content } = input;
  const source = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    path.endsWith(".tsx") || path.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const calls = new Set<string>();
  const namedExports = new Set<string>();
  const heritage: Array<{ symbol: string; kind: "implements" | "extends"; target: string }> = [];

  const lineOf = (pos: number) => source.getLineAndCharacterOfPosition(pos).line + 1;

  const hasExport = (node: ts.HasModifiers): boolean =>
    (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  const push = (
    name: string,
    kind: ParsedSymbol["kind"],
    node: ts.Node,
    exported: boolean,
  ): void => {
    symbols.push({ name, kind, startLine: lineOf(node.getStart(source)), endLine: lineOf(node.end), exported });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const names: string[] = [];
      const clause = node.importClause;
      if (clause?.name) names.push(clause.name.text);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) names.push(el.name.text);
      }
      imports.push({
        module: spec,
        resolvedPath: resolveRelativeImport(path, spec, input.knownPaths),
        names,
      });
    } else if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) namedExports.add(el.name.text);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      push(node.name.text, "function", node, hasExport(node));
    } else if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;
      push(className, "class", node, hasExport(node));
      for (const clause of node.heritageClauses ?? []) {
        const kind =
          clause.token === ts.SyntaxKind.ImplementsKeyword ? "implements" : "extends";
        for (const type of clause.types) {
          const expr = type.expression;
          if (ts.isIdentifier(expr)) heritage.push({ symbol: className, kind, target: expr.text });
        }
      }
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          push(`${className}.${member.name.text}`, "method", member, hasExport(node));
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      const ifaceName = node.name.text;
      push(ifaceName, "interface", node, hasExport(node));
      for (const clause of node.heritageClauses ?? []) {
        for (const type of clause.types) {
          const expr = type.expression;
          if (ts.isIdentifier(expr))
            heritage.push({ symbol: ifaceName, kind: "extends", target: expr.text });
        }
      }
    } else if (ts.isTypeAliasDeclaration(node)) {
      push(node.name.text, "type", node, hasExport(node));
    } else if (ts.isEnumDeclaration(node)) {
      push(node.name.text, "enum", node, hasExport(node));
    } else if (ts.isVariableStatement(node) && node.parent === source) {
      const exported = hasExport(node);
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const init = decl.initializer;
        const isFn = init !== undefined && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        push(decl.name.text, isFn ? "function" : "const", node, exported);
      }
    } else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      if (ts.isIdentifier(expr)) calls.add(expr.text);
      else if (ts.isPropertyAccessExpression(expr)) calls.add(expr.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // `export { a, b }` sonradan işaretler
  for (const s of symbols) {
    if (namedExports.has(s.name)) s.exported = true;
  }

  return {
    path,
    sha,
    language: languageOf(path),
    loc: content.split("\n").length,
    isTest: TEST_PATH.test(path),
    symbols,
    imports,
    calls: [...calls],
    heritage,
  };
}
