export const packageName = "@acos/config" as const;

export {
  envSchema,
  loadConfig,
  loadConfigOrExit,
  ConfigError,
  type Config,
  type Env,
  type BootIo,
} from "./env.js";

export { TASK_QUEUES, NATS_SUBJECT_PREFIX, DEFAULT_BUDGETS, type TaskQueue } from "./constants.js";
