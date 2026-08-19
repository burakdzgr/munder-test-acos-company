// LanguageIndexer kayıt sistemi (LIFECYCLE TASK 4): CodeIndex belirli bir dile
// bağımlı değildir — her dil kendi adapter'ını getirir, kayıt buradan yapılır.
// Kanonik çıktı her dilde aynıdır: Repository → File → Symbol → Edge.
import type { ParsedFileIndex } from "@acos/db";
import { typescriptIndexer } from "./typescript.js";
import { pythonIndexer } from "./python.js";
import { genericTextIndexer } from "./generic.js";

export interface LanguageIndexerInput {
  path: string;
  sha: string;
  content: string;
  /** proje ağacındaki tüm yollar — göreli import çözümü için */
  knownPaths: ReadonlySet<string>;
}

export interface LanguageIndexer {
  name: string;
  /** Bu adapter'ın sahiplendiği dosya yolları. */
  matches: (path: string) => boolean;
  parse: (input: LanguageIndexerInput) => ParsedFileIndex;
}

/** Sıra önemli: ilk eşleşen kazanır; generic her zaman sondadır. */
const INDEXERS: LanguageIndexer[] = [typescriptIndexer, pythonIndexer, genericTextIndexer];

export function indexerFor(path: string): LanguageIndexer {
  return INDEXERS.find((ix) => ix.matches(path)) ?? genericTextIndexer;
}

/** Yeni dil adapter'ı eklemek: bu listeye kayıt + kendi dosyası. */
export function registeredIndexers(): readonly LanguageIndexer[] {
  return INDEXERS;
}

/** Snapshot'a hangi dosyaların gireceği — adapter'ı olan her uzantı. */
export const INDEXABLE_FILE = /\.(?:[cm]?[jt]sx?|py|php|go|rb|java|rs|cs)$/;
