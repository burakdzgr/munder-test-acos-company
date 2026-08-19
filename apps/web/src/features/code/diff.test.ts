import { describe, expect, it } from "vitest";
import { diffLineClass, splitDiff } from "./diff.js";

const SAMPLE = `diff --git a/src/oauth.ts b/src/oauth.ts
index 111..222 100644
--- a/src/oauth.ts
+++ b/src/oauth.ts
@@ -1,3 +1,4 @@
 export async function handleOAuth(req) {
-  return sign(t)
+  const t = await exchange(req.code)
+  return signSession(t)
 }
diff --git a/src/session.ts b/src/session.ts
new file mode 100644
--- /dev/null
+++ b/src/session.ts
@@ -0,0 +1,2 @@
+export function signSession(t) {
+}`;

describe("splitDiff", () => {
  it("splits a unified diff into per-file chunks by the b/ path", () => {
    const files = splitDiff(SAMPLE);
    expect(files.map((f) => f.path)).toEqual(["src/oauth.ts", "src/session.ts"]);
    expect(files[0]!.lines.some((l) => l.startsWith("@@ -1,3"))).toBe(true);
    expect(files[1]!.lines.some((l) => l.includes("signSession"))).toBe(true);
    // no cross-contamination between chunks
    expect(files[0]!.lines.some((l) => l.includes("new file mode"))).toBe(false);
  });

  it("returns an empty list for prose without diff headers", () => {
    expect(splitDiff("not a diff\nat all")).toEqual([]);
  });
});

describe("diffLineClass", () => {
  it("classifies additions/deletions/hunks/file headers distinctly", () => {
    expect(diffLineClass("+added")).toContain("3fd0a0");
    expect(diffLineClass("-removed")).toContain("ff6b8a");
    expect(diffLineClass("@@ -1 +1 @@")).toContain("dept-product");
    expect(diffLineClass("+++ b/x")).toBe(diffLineClass("--- a/x"));
    expect(diffLineClass(" context")).toBe("text-acos-fg1");
  });
});
