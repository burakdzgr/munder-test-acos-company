// sandbox-manager internal API (28 §2, 27 §11; T37). These schemas define
// the ONLY contract between the execution plane (execution-worker, T40) and
// the Docker-socket owner (S1). The service lives outside the control plane
// and holds zero domain state — so its API schemas live here, not in a
// per-service package. All routes require the shared INTERNAL_API_TOKEN
// bearer (18 §2); there is no session/PAT path.
import { z } from "zod";

export const IsolationLevelSchema = z.enum(["analysis", "coding", "testing"]);
export type IsolationLevelValue = z.infer<typeof IsolationLevelSchema>;

export const WorkspaceMountSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  readonly: z.boolean().default(false),
  /** Named Docker volumes (worktrees, T38) use "volume"; host paths "bind". */
  type: z.enum(["bind", "volume"]).default("bind"),
});

export const CreateWorkspaceRequestSchema = z.object({
  /** Caller-supplied id (uuid) — idempotent: a live container is returned as-is. */
  workspaceId: z.uuid(),
  isolation: IsolationLevelSchema,
  /** Workspace image; defaults to a minimal base until T38 wires real images. */
  image: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).default({}),
  mounts: z.array(WorkspaceMountSchema).default([]),
  /** Labels stamped on the container for GC and audit (companyId, taskId, …). */
  labels: z.record(z.string(), z.string()).default({}),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const WorkspaceSchema = z.object({
  workspaceId: z.uuid(),
  containerId: z.string(),
  isolation: IsolationLevelSchema,
  status: z.enum(["running", "exited", "destroyed"]),
  createdAt: z.iso.datetime(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const ExecRequestSchema = z.object({
  command: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  /** Stream PTY frames to NATS `term.<sessionId>` while executing. */
  sessionId: z.uuid().optional(),
  /** With sessionId: await the result (frames still stream live) instead of
   *  the fire-and-forget 202 ack (T41 — tools want frames AND the result). */
  waitForResult: z.boolean().default(false),
  /**
   * Y3: payload written to the process's stdin instead of being baked into
   * `command`. Linux caps a single argv entry at MAX_ARG_STRLEN (128 KB), and
   * base64 inflates by a third — so file writes above ~96 KB died with an
   * unreadable `E2BIG` even though the tool schemas promise 2 MB. stdin has no
   * such limit. Encoded, so no byte sequence can break out of the transport.
   */
  stdinBase64: z.string().max(8_000_000).optional(),
  timeoutMs: z.number().int().min(1).max(3_600_000).default(120_000),
});
export type ExecRequest = z.infer<typeof ExecRequestSchema>;

/** Buffered exec result (non-streaming). Streaming execs return {sessionId}. */
export const ExecResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int(),
  /** true when killed by the timeout rather than exiting on its own. */
  timedOut: z.boolean(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;

export const ExecStreamAckSchema = z.object({
  sessionId: z.uuid(),
  streaming: z.literal(true),
});

/** One PTY frame on `term.<sessionId>` (22 §4 terminal envelope). */
export const TerminalFrameSchema = z.object({
  seq: z.number().int(),
  ts: z.number().int(),
  stream: z.enum(["stdout", "stderr"]),
  /** base64 chunk. */
  data: z.string(),
});
export type SandboxTerminalFrame = z.infer<typeof TerminalFrameSchema>;

/** Ring/log replay for late subscribers (22 §5.2, T41): live ring when the
 *  session is running, log-tail fallback after restarts. */
export const TerminalRingResponseSchema = z.object({
  frames: z.array(TerminalFrameSchema),
  currentSeq: z.number().int(),
  source: z.enum(["ring", "log", "none"]),
});
export type TerminalRingResponse = z.infer<typeof TerminalRingResponseSchema>;

export const WorkspaceListSchema = z.array(WorkspaceSchema);

// ---------------------------------------------------------------------------
// Git model (T38, ADR-010, 15 §3): bare repos + per-task worktree volumes.
// The strict patterns double as shell-safety: every value interpolated into a
// git helper script must match one of these.
// ---------------------------------------------------------------------------

/** `task/<task-number>-<slug>` (15 §3.1, _DECISIONS §13). */
export const TASK_BRANCH_PATTERN = /^task\/[0-9]+-[a-z0-9-]+$/;
/** Worktree volume names: `ws-<task_number>-<uuid prefix>` (15 §3.1 naming
 *  decision + a task-id suffix for cross-tenant uniqueness — recorded T38
 *  deviation). */
export const WORKTREE_VOLUME_PATTERN = /^ws-[0-9]+-[0-9a-f]{8}$/;

export const EnsureRepoRequestSchema = z.object({
  /** Bare repo lives at `/data/repos/<projectId>.git` on the repos volume. */
  projectId: z.uuid(),
});
export type EnsureRepoRequest = z.infer<typeof EnsureRepoRequestSchema>;

export const EnsureRepoResponseSchema = z.object({
  barePath: z.string(),
  /** HEAD of the default branch (`main`) after the (idempotent) init. */
  headCommit: z.string().regex(/^[0-9a-f]{40}$/),
  created: z.boolean(),
});
export type EnsureRepoResponse = z.infer<typeof EnsureRepoResponseSchema>;

export const ProvisionWorktreeRequestSchema = z.object({
  projectId: z.uuid(),
  volumeName: z.string().regex(WORKTREE_VOLUME_PATTERN),
  branch: z.string().regex(TASK_BRANCH_PATTERN),
});
export type ProvisionWorktreeRequest = z.infer<typeof ProvisionWorktreeRequestSchema>;

export const ProvisionWorktreeResponseSchema = z.object({
  volumeName: z.string(),
  /** Commit the worktree was cloned at (branch base). */
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  /** false when the volume already held a worktree (idempotent re-provision). */
  created: z.boolean(),
});
export type ProvisionWorktreeResponse = z.infer<typeof ProvisionWorktreeResponseSchema>;

// ---------------------------------------------------------------------------
// Project intake ingest (T42, 14 §3.1 stage 1): copy a source into the
// platform's own bare repo. `git_url` clones over http(s); `empty` seeds a
// greenfield repo. Local-path import needs a host-path mapping decision and
// is deferred (recorded T42 deviation).
// ---------------------------------------------------------------------------

export const IngestSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("git_url"),
    url: z.string().regex(/^https?:\/\/[^\s'"\\]+$/).max(2048),
  }),
  z.object({ kind: z.literal("empty") }),
]);
export type IngestSource = z.infer<typeof IngestSourceSchema>;

export const IngestRepoRequestSchema = z.object({
  projectId: z.uuid(),
  source: IngestSourceSchema,
});
export type IngestRepoRequest = z.infer<typeof IngestRepoRequestSchema>;

/** Lead squash-merge into main in the bare repo (T43, 15 §3.6). */
export const MergeBranchRequestSchema = z.object({
  projectId: z.uuid(),
  branch: z.string().regex(TASK_BRANCH_PATTERN),
  message: z.string().min(1).max(500),
  authorName: z.string().min(1).max(120),
  authorEmail: z.string().min(3).max(200),
  reviewedBy: z.string().min(1).max(200),
});
export type MergeBranchRequest = z.infer<typeof MergeBranchRequestSchema>;

export const MergeBranchResponseSchema = z.union([
  z.object({ merged: z.literal(true), mergeCommit: z.string().regex(/^[0-9a-f]{40}$/) }),
  z.object({ merged: z.literal(false), conflictFiles: z.array(z.string()) }),
]);
export type MergeBranchResponse = z.infer<typeof MergeBranchResponseSchema>;

export const IngestRepoResponseSchema = z.object({
  barePath: z.string(),
  headCommit: z.string().regex(/^[0-9a-f]{40}$/),
  defaultBranch: z.string(),
  branches: z.array(z.string()),
  sizeKb: z.number().int(),
  created: z.boolean(),
  /** Read-only intake worktree volume (`ws-0-<proj8>`), null for `empty`. */
  worktreeVolume: z.string().nullable(),
});
export type IngestRepoResponse = z.infer<typeof IngestRepoResponseSchema>;
