// T47 — workspace create is IDEMPOTENT on the deterministic container name.
//
// Live finding (2026-08-21, integrated tree): the intake analyzer fan-out
// (N activities, one workspace id) and Temporal retries create the same
// workspace concurrently; Docker answers the losers with 409 "name already in
// use", and the old adopt path looked the winner up ONCE — but Docker reserves
// the NAME before the container is listable, so that lookup found nothing and
// the 409 surfaced as a sandbox-manager 500 → workflow failure. This fake
// Docker models exactly that window (reserve → visible after a delay) and a
// container that is being removed, on a fake clock.
import { describe, expect, it } from "vitest";
import type Docker from "dockerode";
import { CREATE_ADOPT_POLL_MS, CREATE_ADOPT_WINDOW_MS, DockerSandbox, SandboxError } from "./docker.js";
import type { TerminalLogSink, TerminalTransport } from "./terminal.js";

type State = "created" | "running" | "exited" | "removing";
interface FakeContainer {
  id: string;
  name: string;
  labels: Record<string, string>;
  state: State;
  visibleAt: number; // fake-clock ms after which list/inspect see it
}

class FakeDocker {
  containers: FakeContainer[] = [];
  createCalls = 0;
  startCalls = 0;
  now = 0;
  /** ms between name reservation and visibility (Docker's registration gap). */
  registerDelayMs = 300;
  private seq = 0;

  getImage() {
    return { inspect: async () => ({}) };
  }
  async createContainer(opts: { name: string; Labels: Record<string, string> }) {
    this.createCalls += 1;
    const holder = this.containers.find((c) => c.name === opts.name);
    if (holder) {
      const err = Object.assign(new Error(`(HTTP code 409) unexpected - Conflict. The container name "/${opts.name}" is already in use by container "${holder.id}"`), {
        statusCode: 409,
      });
      throw err;
    }
    const c: FakeContainer = { id: `c${++this.seq}`, name: opts.name, labels: opts.Labels, state: "created", visibleAt: this.now + this.registerDelayMs };
    this.containers.push(c);
    return this.getContainer(c.id);
  }
  async listContainers(opts: { filters?: { label?: string[] } }) {
    const want = opts.filters?.label ?? [];
    return this.containers
      .filter((c) => c.visibleAt <= this.now)
      .filter((c) => want.every((kv) => c.labels[kv.split("=")[0]!] === kv.split("=")[1]))
      .map((c) => ({ Id: c.id, State: c.state }));
  }
  getContainer(ref: string) {
    // the CREATOR holds the id and can operate on its container at once; lookups by NAME
    // (and listContainers) only see it once Docker has registered it — the real gap
    const find = () => this.containers.find((c) => c.id === ref || (c.name === ref && c.visibleAt <= this.now));
    const notFound = () => Object.assign(new Error("(HTTP code 404) no such container"), { statusCode: 404 });
    return {
      id: ref,
      inspect: async () => {
        const c = find();
        if (!c) throw notFound();
        return {
          Id: c.id,
          Created: "2026-08-21T00:00:00Z",
          Config: { Labels: c.labels },
          State: { Running: c.state === "running", Status: c.state, Dead: false },
        } as unknown as Docker.ContainerInspectInfo;
      },
      start: async () => {
        const c = find();
        if (!c) throw notFound();
        if (c.state === "removing") throw Object.assign(new Error("container is marked for removal"), { statusCode: 409 });
        this.startCalls += 1;
        c.state = "running";
      },
      remove: async () => {
        const c = find();
        if (!c) throw notFound();
        this.containers = this.containers.filter((x) => x !== c);
      },
    };
  }
}

function harness(fake: FakeDocker) {
  const transport: TerminalTransport = { publish: () => {} };
  const logSink: TerminalLogSink = { append: () => {} };
  const log: string[] = [];
  const make = () =>
    new DockerSandbox({
      docker: fake as unknown as Docker,
      transport,
      logSink,
      nowMs: () => fake.now,
      // the adopt poll advances the fake clock instead of sleeping
      sleep: async (ms) => {
        fake.now += ms;
        await Promise.resolve();
      },
      log: (m) => log.push(m),
    });
  return { make, log };
}

const req = (workspaceId: string) => ({ workspaceId, isolation: "analysis" as const, env: {}, mounts: [], labels: {} });

describe("createWorkspace idempotency (T47)", () => {
  it("in-process: N concurrent creates for one workspaceId share ONE Docker create and resolve to the same container", async () => {
    const fake = new FakeDocker();
    const sandbox = harness(fake).make();
    const results = await Promise.all(Array.from({ length: 6 }, () => sandbox.createWorkspace(req("ws-a"))));
    expect(fake.createCalls).toBe(1);
    expect(new Set(results.map((r) => r.containerId)).size).toBe(1);
    expect(results.every((r) => r.status === "running")).toBe(true);
    // a LATER create (Temporal retry after the first resolved) reuses the live container, no new create
    fake.now += 1_000; // wall clock moves on; Docker has long registered the container
    const again = await sandbox.createWorkspace(req("ws-a"));
    expect(again.containerId).toBe(results[0]!.containerId);
    expect(fake.createCalls).toBe(1);
  });

  it("cross-process: the 409 loser polls through Docker's reserve→visible gap and ADOPTS the winner (no 500)", async () => {
    const fake = new FakeDocker();
    fake.registerDelayMs = 3 * CREATE_ADOPT_POLL_MS + 50; // the winner is invisible for several polls
    const h = harness(fake);
    const A = h.make();
    const B = h.make(); // separate instance = separate coalescing map, like a second sandbox-manager process
    const [a, b] = await Promise.all([A.createWorkspace(req("ws-b")), B.createWorkspace(req("ws-b"))]);
    expect(a.containerId).toBe(b.containerId);
    expect(a.status).toBe("running");
    expect(b.status).toBe("running");
    expect(fake.createCalls).toBeGreaterThanOrEqual(2); // the loser really hit the 409
    expect(fake.containers).toHaveLength(1);
  });

  it("a name held by a container that is being REMOVED frees up; the create waits and then creates fresh", async () => {
    const fake = new FakeDocker();
    fake.registerDelayMs = 0;
    // a leftover 'removing' holder of the name, visible; the fake frees it after 2 polls
    fake.containers.push({ id: "zombie", name: "acos-ws-ws-c", labels: { "acos.workspace_id": "ws-c" }, state: "removing", visibleAt: 0 });
    const origList = fake.listContainers.bind(fake);
    fake.listContainers = async (opts) => {
      if (fake.now >= 2 * CREATE_ADOPT_POLL_MS) fake.containers = fake.containers.filter((c) => c.id !== "zombie");
      return origList(opts);
    };
    const sandbox = harness(fake).make();
    const ws = await sandbox.createWorkspace(req("ws-c"));
    expect(ws.containerId).not.toBe("zombie");
    expect(ws.status).toBe("running");
  });

  it("a stopped same-name container is restarted (INVARIANT 15), not re-created", async () => {
    const fake = new FakeDocker();
    fake.registerDelayMs = 0;
    fake.containers.push({ id: "stopped", name: "acos-ws-ws-d", labels: { "acos.workspace_id": "ws-d" }, state: "exited", visibleAt: 0 });
    const ws = await harness(fake).make().createWorkspace(req("ws-d"));
    expect(ws.containerId).toBe("stopped");
    expect(ws.status).toBe("running");
    expect(fake.createCalls).toBe(0);
  });

  it("a non-409 Docker error is NOT retried — it surfaces as DOCKER_ERROR at once", async () => {
    const fake = new FakeDocker();
    fake.createContainer = async () => {
      throw Object.assign(new Error("(HTTP code 500) server error - boom"), { statusCode: 500 });
    };
    const sandbox = harness(fake).make();
    await expect(sandbox.createWorkspace(req("ws-e"))).rejects.toMatchObject({ code: "DOCKER_ERROR" });
    expect(fake.now).toBe(0); // no poll
  });

  it("a name that stays in conflict with NO adoptable container for the whole window fails loudly (bounded)", async () => {
    const fake = new FakeDocker();
    fake.registerDelayMs = Number.POSITIVE_INFINITY; // the "winner" never becomes visible — pathological daemon
    const sandbox = harness(fake).make();
    await sandbox.createWorkspace(req("ws-f")).catch(() => {}); // reserve the name (invisible forever)
    fake.createCalls = 0;
    const err = await sandbox.createWorkspace(req("ws-f")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect(String((err as Error).message)).toContain("stayed in conflict");
    expect(fake.now).toBeGreaterThanOrEqual(CREATE_ADOPT_WINDOW_MS);
  });
});
