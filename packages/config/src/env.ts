// Zod-validated environment (27-INFRASTRUCTURE.md §13 = 28-REPOSITORY-STRUCTURE.md §7).
// Missing/invalid keys fail fast with a readable error listing every problem —
// never a stack trace.
import { z } from "zod";

const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);

const optionalSecret = z.preprocess(emptyToUndefined, z.string().min(1).optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.url().optional());

const port = z.coerce.number().int().min(1).max(65535);

const boolFromString = z
  .enum(["true", "false"])
  .transform((v) => v === "true");

const base64Key32 = z
  .string({ error: "required — 32-byte base64 master key (generate with `pnpm ops keygen`)" })
  .refine(
  (s) => {
    try {
      return Buffer.from(s, "base64").length === 32;
    } catch {
      return false;
    }
  },
  { message: "must be 32 bytes, base64-encoded (generate with `pnpm ops keygen`)" },
);

export const envSchema = z.object({
  // Core
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  WEB_PORT: port.default(5173),
  SERVER_PORT: port.default(3000),
  DATA_DIR: z.string().min(1).default("./data"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /**
   * Demo şirketini ("Acme Technologies" + 17 isimli ajan) açılışta kur.
   *
   * Varsayılan FALSE. Ajanlar dinamik oluşur — işe alım API'si `agent.hired`
   * olayı üretir, CEO kaskadı da yeni ajan talep edebilir. Seed'deki isimler
   * çalışma zamanı verisi değil, bir TEST FİKSTÜRÜDÜR; varsayılan açık
   * olduğu için her kurulum kendiliğinden 17 uydurma çalışanla başlıyordu ve
   * bu, dinamik işe alımı gizliyordu (2026-08-17 Founder itirazı).
   *
   * Entegrasyon testleri `ensureSeed`'i KENDİLERİ çağırır, bu bayraktan
   * etkilenmezler. Yalnız e2e yığını açılıştaki seed'e bağlıdır ve onu
   * scripts/e2e-stack.mjs artık AÇIKÇA açar — örtük varsayılana güvenmek
   * yerine bağımlılık görünür oldu.
   */
  SEED_DEMO: boolFromString.default(false),

  // Datastores
  DATABASE_URL: z.string({ error: "required — postgres connection string" }).startsWith("postgres://", {
    message: "must be a postgres:// connection string",
  }),
  NATS_URL: z.string({ error: "required — nats connection string" }).startsWith("nats://", {
    message: "must be a nats:// connection string",
  }),
  TEMPORAL_ADDRESS: z
    .string({ error: "required — host:port of the Temporal frontend" })
    .regex(/^[^\s:]+:\d+$/, { message: "must be host:port (e.g. localhost:7233)" }),
  TEMPORAL_NAMESPACE: z.string().min(1).default("acos"),

  // Security
  // Single-user mode (Founder decision 2026-08-13): no login UI; the server
  // transparently mints a Founder session. Set "false" to restore the login flow.
  AUTH_AUTOLOGIN: boolFromString.default(true),
  // REVISION TASK 7 — production fail-closed: NODE_ENV=production iken
  // AUTH_AUTOLOGIN=true boot'u durdurur; bu bayrak BİLİNÇLİ tek kullanıcılı
  // kurulum istisnasıdır (Founder karari 2026-08-13'ün açık opt-in'i).
  AUTH_AUTOLOGIN_ALLOW_PRODUCTION: boolFromString.default(false),
  MASTER_KEY: base64Key32,
  SESSION_SECRET: z.string({ error: "required — cookie signing secret" }).min(16, {
    message: "must be at least 16 characters",
  }),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).default(65536),
  INTERNAL_API_TOKEN: z.string({ error: "required — shared bearer for internal HTTP" }).min(16, {
    message: "must be at least 16 characters",
  }),

  // LLM providers (any subset; none => Ollama offline profile)
  ANTHROPIC_API_KEY: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
  GEMINI_API_KEY: optionalSecret,
  CLAUDE_CLI_BRIDGE_URL: z.string().url().optional(),
  OPENROUTER_API_KEY: optionalSecret,
  OLLAMA_BASE_URL: optionalUrl,
  VLLM_BASE_URL: optionalUrl,

  // Embeddings
  EMBEDDINGS_PROVIDER: z.enum(["openai", "ollama"]).default("openai"),
  EMBEDDINGS_MODEL: z.string().min(1).default("text-embedding-3-small"),

  // Execution plane
  SANDBOX_MANAGER_URL: z.url().default("http://localhost:3010"),
  MAX_WORKSPACES: z.coerce.number().int().min(1).default(8),
  DOCKER_SOCK: z.string().min(1).default("/var/run/docker.sock"),
  EGRESS_PROXY_URL: z.url().default("http://egress-proxy:3128"),

  // Budgets / safety defaults
  DEFAULT_COMPANY_DAILY_BUDGET_CENTS: z.coerce.number().int().min(0).default(5000),

  // Observability (optional profile; empty => no-op exporter)
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  GRAFANA_ADMIN_PASSWORD: optionalSecret,

  // Backups
  BACKUP_S3_URL: optionalSecret,
});

export type Env = z.infer<typeof envSchema>;

export interface Config {
  readonly nodeEnv: Env["NODE_ENV"];
  readonly appBaseUrl: string;
  readonly webPort: number;
  readonly serverPort: number;
  readonly dataDir: string;
  readonly logLevel: Env["LOG_LEVEL"];
  readonly seedDemo: boolean;
  readonly database: { readonly url: string };
  readonly nats: { readonly url: string };
  readonly temporal: { readonly address: string; readonly namespace: string };
  readonly security: {
    readonly masterKey: string;
    readonly sessionSecret: string;
    readonly argon2MemoryKib: number;
    readonly internalApiToken: string;
    /** Single-user mode: mint a Founder session for cookie-less requests. */
    readonly autologinFounder: boolean;
    /** Explicit opt-in: autologin may stay on in a production build. */
    readonly autologinAllowProduction: boolean;
  };
  readonly llm: {
    readonly anthropicApiKey: string | undefined;
    readonly openaiApiKey: string | undefined;
    readonly geminiApiKey: string | undefined;
    readonly claudeCliUrl: string | undefined;
    readonly openrouterApiKey: string | undefined;
    readonly ollamaBaseUrl: string | undefined;
    readonly vllmBaseUrl: string | undefined;
    /** No provider configured => Ollama offline profile (_DECISIONS.md §0 A3). */
    readonly offlineProfile: boolean;
  };
  readonly embeddings: { readonly provider: Env["EMBEDDINGS_PROVIDER"]; readonly model: string };
  readonly sandbox: {
    readonly managerUrl: string;
    readonly maxWorkspaces: number;
    readonly dockerSock: string;
    readonly egressProxyUrl: string;
  };
  readonly budgets: { readonly defaultCompanyDailyCents: number };
  readonly observability: {
    readonly otelExporterOtlpEndpoint: string | undefined;
    readonly grafanaAdminPassword: string | undefined;
  };
  readonly backups: { readonly s3Url: string | undefined };
}

export class ConfigError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(
      `Invalid environment configuration (${problems.length} problem(s)):\n` +
        problems.map((p) => `  ✗ ${p}`).join("\n") +
        "\nFix your .env (see .env.example).",
    );
    this.name = "ConfigError";
  }
}

/** Parse + validate the environment. Throws ConfigError naming every problem. */
export function loadConfig(processEnv: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(processEnv);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const key = issue.path.length > 0 ? String(issue.path[0]) : "<env>";
      return `${key}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }
  const env = parsed.data;
  const llmProviderConfigured =
    env.ANTHROPIC_API_KEY !== undefined ||
    env.OPENAI_API_KEY !== undefined ||
    env.OPENROUTER_API_KEY !== undefined ||
    env.VLLM_BASE_URL !== undefined;
  return {
    nodeEnv: env.NODE_ENV,
    appBaseUrl: env.APP_BASE_URL,
    webPort: env.WEB_PORT,
    serverPort: env.SERVER_PORT,
    dataDir: env.DATA_DIR,
    logLevel: env.LOG_LEVEL,
    seedDemo: env.SEED_DEMO,
    database: { url: env.DATABASE_URL },
    nats: { url: env.NATS_URL },
    temporal: { address: env.TEMPORAL_ADDRESS, namespace: env.TEMPORAL_NAMESPACE },
    security: {
      masterKey: env.MASTER_KEY,
      sessionSecret: env.SESSION_SECRET,
      argon2MemoryKib: env.ARGON2_MEMORY_KIB,
      internalApiToken: env.INTERNAL_API_TOKEN,
      autologinFounder: env.AUTH_AUTOLOGIN,
      autologinAllowProduction: env.AUTH_AUTOLOGIN_ALLOW_PRODUCTION,
    },
    llm: {
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      openaiApiKey: env.OPENAI_API_KEY,
      geminiApiKey: env.GEMINI_API_KEY,
      claudeCliUrl: env.CLAUDE_CLI_BRIDGE_URL,
      openrouterApiKey: env.OPENROUTER_API_KEY,
      ollamaBaseUrl: env.OLLAMA_BASE_URL,
      vllmBaseUrl: env.VLLM_BASE_URL,
      offlineProfile: !llmProviderConfigured,
    },
    embeddings: { provider: env.EMBEDDINGS_PROVIDER, model: env.EMBEDDINGS_MODEL },
    sandbox: {
      managerUrl: env.SANDBOX_MANAGER_URL,
      maxWorkspaces: env.MAX_WORKSPACES,
      dockerSock: env.DOCKER_SOCK,
      egressProxyUrl: env.EGRESS_PROXY_URL,
    },
    budgets: { defaultCompanyDailyCents: env.DEFAULT_COMPANY_DAILY_BUDGET_CENTS },
    observability: {
      otelExporterOtlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      grafanaAdminPassword: env.GRAFANA_ADMIN_PASSWORD,
    },
    backups: { s3Url: env.BACKUP_S3_URL },
  };
}

export interface BootIo {
  error: (message: string) => void;
  exit: (code: number) => never;
}

/** Boot-time variant: prints the named problem list and exits 1 (27 §13). */
export function loadConfigOrExit(
  processEnv: Record<string, string | undefined>,
  io: BootIo = {
    error: (m) => console.error(m),
    exit: (code) => process.exit(code),
  },
): Config {
  try {
    return loadConfig(processEnv);
  } catch (err) {
    if (err instanceof ConfigError) {
      io.error(err.message);
      return io.exit(1);
    }
    throw err;
  }
}
