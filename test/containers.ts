// Shared Testcontainers helpers for *.int.test.ts suites (T07; 32 §2, §12).
// Each suite boots the containers it needs; images are pinned here so every
// integration suite runs against the same infrastructure versions.
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from "testcontainers";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";

export const IMAGES = {
  postgres: "pgvector/pgvector:pg16",
  nats: "nats:2.10-alpine",
  temporal: "temporalio/temporal:1.8.2", // CLI image; `server start-dev`
} as const;

/** PostgreSQL 16 + pgvector, ready to accept connections. */
export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(IMAGES.postgres)
    .withDatabase("acos_test")
    .withUsername("acos")
    .withPassword("acos")
    .start();
}

export interface StartedNats {
  container: StartedTestContainer;
  url: string;
}

/** NATS 2.10 with JetStream enabled; resolves once /healthz answers. */
export async function startNats(): Promise<StartedNats> {
  const container = await new GenericContainer(IMAGES.nats)
    .withCommand(["-js", "-m", "8222"])
    .withExposedPorts(4222, 8222)
    .withWaitStrategy(Wait.forHttp("/healthz", 8222))
    .start();
  return {
    container,
    url: `nats://${container.getHost()}:${container.getMappedPort(4222)}`,
  };
}

export interface StartedTemporal {
  container: StartedTestContainer;
  address: string;
}

/** Temporal dev server (in-memory) with the `acos` namespace pre-created. */
export async function startTemporal(): Promise<StartedTemporal> {
  const container = await new GenericContainer(IMAGES.temporal)
    .withCommand([
      "server",
      "start-dev",
      "--ip",
      "0.0.0.0",
      "--headless",
      "--namespace",
      "acos",
    ])
    .withExposedPorts(7233)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  return {
    container,
    address: `${container.getHost()}:${container.getMappedPort(7233)}`,
  };
}
