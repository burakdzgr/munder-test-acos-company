import Docker from "dockerode";
import { randomUUID } from "node:crypto";
import { DockerSandbox } from "../src/docker.js";
const docker = new Docker();
const mk = () => new DockerSandbox({ docker, transport: { publish: () => {} }, logSink: { append: () => {} }, nowMs: () => Date.now() });
const A = mk(), B = mk(), C = mk();
const req = (workspaceId: string) => ({ workspaceId, isolation: "analysis" as const, env: {}, mounts: [], labels: {} });
// 1) cross-instance race: three independent sandboxes (no shared coalescing) × 2 calls each
for (let r = 0; r < 3; r++) {
  const id = randomUUID(); const t0 = Date.now();
  const res = await Promise.allSettled([A, B, C, A, B, C].map((s) => s.createWorkspace(req(id))));
  const ok = res.filter((x): x is PromiseFulfilledResult<{ containerId: string; status: string }> => x.status === "fulfilled");
  const bad = res.filter((x): x is PromiseRejectedResult => x.status === "rejected");
  console.log(`xproc round ${r}: ${ok.length} ok / ${bad.length} failed in ${Date.now() - t0} ms; distinct=${new Set(ok.map((x) => x.value.containerId)).size}; statuses=${[...new Set(ok.map((x) => x.value.status))]}`);
  for (const b of bad.slice(0, 2)) console.log("  ERR:", String(b.reason).slice(0, 200));
  await A.destroyWorkspace(id);
}
// 2) create-while-removing: create, fire destroy without awaiting, create again immediately (retry racing a teardown)
for (let r = 0; r < 3; r++) {
  const id = randomUUID(); const t0 = Date.now();
  const first = await A.createWorkspace(req(id));
  const removal = A.destroyWorkspace(id);
  const second = await B.createWorkspace(req(id)).catch((e) => ({ err: String(e).slice(0, 160) }));
  await removal.catch(() => {});
  const info = "containerId" in second ? await docker.getContainer(second.containerId).inspect().then((i) => i.State.Status).catch((e) => "inspect-err " + String(e).slice(0, 60)) : "n/a";
  console.log(`removing round ${r}: first=${first.containerId.slice(0, 12)} second=${"containerId" in second ? second.containerId.slice(0, 12) + " status=" + second.status + " live=" + info : JSON.stringify(second)} in ${Date.now() - t0} ms`);
  await A.destroyWorkspace(id).catch(() => {});
}
