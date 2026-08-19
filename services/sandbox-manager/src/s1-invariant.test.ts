// S1 invariant (structural, CI-blocking): ONLY sandbox-manager mounts the
// Docker socket — server/workers/web cannot reach dockerd. Asserted against
// the canonical compose file so a stray socket mount in another service
// fails the build (the runtime probe is the compose stack itself).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const composePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../infrastructure/docker/compose.yaml",
);

describe("S1: only sandbox-manager touches the Docker socket", () => {
  it("exactly one service block mounts docker.sock, and it is sandbox-manager", () => {
    const text = readFileSync(composePath, "utf8");
    const lines = text.split("\n");
    // walk services, tracking the current top-level service name
    let currentService = "";
    const socketOwners: string[] = [];
    for (const line of lines) {
      const service = /^ {2}([a-z0-9-]+):\s*$/.exec(line);
      if (service) currentService = service[1]!;
      if (line.includes("docker.sock")) socketOwners.push(currentService);
    }
    expect(socketOwners).toEqual(["sandbox-manager"]);
  });
});
