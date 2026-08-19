// Unified-diff presentation helpers for the Kod panel (36 §7 — U09).
export interface DiffFile {
  path: string;
  lines: string[];
}

/** Split a unified diff into per-file chunks keyed by the b/ path. */
export function splitDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      current = { path: header[2]!, lines: [] };
      files.push(current);
      continue;
    }
    current?.lines.push(line);
  }
  return files;
}

export function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-acos-fg2";
  if (line.startsWith("@@")) return "text-dept-product";
  if (line.startsWith("+")) return "text-[#3fd0a0]";
  if (line.startsWith("-")) return "text-[#ff6b8a]";
  return "text-acos-fg1";
}
