// Delegation engine moved to @acos/db (T34) — the worker's action dispatch
// shares this implementation. Re-exported for existing import paths.
export {
  DelegationService,
  WIP_LIMIT_BY_ROLE,
  ASSIGNED_QUEUE_CAP,
  TEAM_WIP_MULTIPLIER,
  type DelegationResult,
} from "@acos/db";
