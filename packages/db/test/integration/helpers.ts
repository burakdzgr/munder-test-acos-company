// Re-export of the repo-wide Testcontainers helpers (test/containers.ts) so
// suites in this package import from a stable local path.
export * from "../../../../test/containers";
export type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
