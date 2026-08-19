// TypeScriptIndexer (LIFECYCLE TASK 4): mevcut TS Compiler API implementasyonu
// LanguageIndexer arayüzüne sarılır — gerçek AST, regex değil.
import type { LanguageIndexer } from "./index.js";
import { parseSourceFile } from "../parser.js";

export const typescriptIndexer: LanguageIndexer = {
  name: "typescript",
  matches: (path) => /\.[cm]?[jt]sx?$/.test(path),
  parse: (input) => parseSourceFile(input),
};
