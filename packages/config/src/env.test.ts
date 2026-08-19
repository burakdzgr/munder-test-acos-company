import { describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig, loadConfigOrExit } from "./env.js";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

const VALID_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://acos:acos@localhost:5432/acos",
  NATS_URL: "nats://localhost:4222",
  TEMPORAL_ADDRESS: "localhost:7233",
  MASTER_KEY,
  SESSION_SECRET: "a-long-session-secret",
  INTERNAL_API_TOKEN: "an-internal-api-token",
};

describe("loadConfig", () => {
  it("parses a minimal valid env and applies documented defaults", () => {
    const config = loadConfig(VALID_ENV);
    expect(config.nodeEnv).toBe("development");
    expect(config.serverPort).toBe(3000);
    expect(config.webPort).toBe(5173);
    expect(config.dataDir).toBe("./data");
    expect(config.logLevel).toBe("info");
    // Demo kadrosu VARSAYILAN OLARAK KURULMAZ: ajanlar dinamik oluşur, ve
    // varsayılan açıkken her kurulum 17 uydurma çalışanla başlayıp bunu
    // gizliyordu. e2e yığını bayrağı açıkça açar.
    expect(config.seedDemo).toBe(false);
    expect(config.temporal.namespace).toBe("acos");
    expect(config.security.argon2MemoryKib).toBe(65536);
    expect(config.embeddings).toEqual({ provider: "openai", model: "text-embedding-3-small" });
    expect(config.sandbox.maxWorkspaces).toBe(8);
    expect(config.sandbox.egressProxyUrl).toBe("http://egress-proxy:3128");
    expect(config.budgets.defaultCompanyDailyCents).toBe(5000);
  });

  it("treats empty strings as unset for optional keys (as shipped in .env.example)", () => {
    const config = loadConfig({
      ...VALID_ENV,
      ANTHROPIC_API_KEY: "",
      OPENROUTER_API_KEY: "",
      VLLM_BASE_URL: "",
      OTEL_EXPORTER_OTLP_ENDPOINT: "",
      BACKUP_S3_URL: "",
    });
    expect(config.llm.anthropicApiKey).toBeUndefined();
    expect(config.observability.otelExporterOtlpEndpoint).toBeUndefined();
    expect(config.backups.s3Url).toBeUndefined();
  });

  it("no configured LLM provider => Ollama offline profile (A3)", () => {
    expect(loadConfig(VALID_ENV).llm.offlineProfile).toBe(true);
    expect(
      loadConfig({ ...VALID_ENV, ANTHROPIC_API_KEY: "sk-ant-test" }).llm.offlineProfile,
    ).toBe(false);
  });

  it("missing required vars throw a ConfigError naming EVERY problem", () => {
    let error: ConfigError | undefined;
    try {
      loadConfig({});
    } catch (e) {
      error = e as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const named = ["DATABASE_URL", "NATS_URL", "TEMPORAL_ADDRESS", "MASTER_KEY", "SESSION_SECRET", "INTERNAL_API_TOKEN"];
    for (const key of named) {
      expect(error!.problems.some((p) => p.startsWith(`${key}:`)), key).toBe(true);
    }
    expect(error!.message).toContain("Invalid environment configuration (6 problem(s))");
    expect(error!.message).toContain(".env.example");
  });

  it("rejects invalid values with named messages", () => {
    let error: ConfigError | undefined;
    try {
      loadConfig({
        ...VALID_ENV,
        DATABASE_URL: "mysql://nope",
        SERVER_PORT: "99999",
        MASTER_KEY: "dG9vLXNob3J0",
        EMBEDDINGS_PROVIDER: "pinecone",
        TEMPORAL_ADDRESS: "not-an-address",
      });
    } catch (e) {
      error = e as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error!.problems.some((p) => p.startsWith("DATABASE_URL:") && p.includes("postgres://"))).toBe(true);
    expect(error!.problems.some((p) => p.startsWith("SERVER_PORT:"))).toBe(true);
    expect(error!.problems.some((p) => p.startsWith("MASTER_KEY:") && p.includes("32 bytes"))).toBe(true);
    expect(error!.problems.some((p) => p.startsWith("EMBEDDINGS_PROVIDER:"))).toBe(true);
    expect(error!.problems.some((p) => p.startsWith("TEMPORAL_ADDRESS:") && p.includes("host:port"))).toBe(true);
  });
});

describe("loadConfigOrExit", () => {
  it("prints the named problem list and exits 1 on invalid env (T03 acceptance)", () => {
    const error = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit(${code})`);
    });
    expect(() => loadConfigOrExit({}, { error, exit })).toThrow("exit(1)");
    expect(exit).toHaveBeenCalledWith(1);
    const printed = error.mock.calls.map((c) => c[0]).join("\n");
    expect(printed).toContain("Invalid environment configuration");
    expect(printed).toContain("DATABASE_URL:");
    expect(printed).toContain("SESSION_SECRET:");
    expect(printed).toContain("Fix your .env");
  });

  it("returns the config and prints nothing on valid env", () => {
    const error = vi.fn();
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit(${code})`);
    });
    const config = loadConfigOrExit(VALID_ENV, { error, exit });
    expect(config.database.url).toBe(VALID_ENV.DATABASE_URL);
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
