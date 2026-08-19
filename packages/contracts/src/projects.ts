// Projects API (T42; 14 §1–2, 21 §3): minimal Founder import contract —
// name + objective (+constraints, +optional git URL source); intake
// discovers everything else (P4).
import { z } from "zod";

export const PROJECT_STATUSES = [
  // Yeni yaşam döngüsü (PROJECT-LIFECYCLE-CONTEXT-ARCHITECTURE TASK 2)
  "draft",
  "repository_setup",
  "indexing",
  "ready",
  "planning",
  "staffing_review",
  "waiting_for_founder",
  "executing",
  "failed",
  // miras durumlar (eski kayıtlar + köprüler)
  "proposed",
  "intake",
  "active",
  "paused",
  "completed",
  "archived",
  "cancelled",
] as const;

export const ProjectDtoSchema = z.object({
  githubConnectionId: z.uuid().nullable().default(null),
  indexState: z.string().default("none"),
  indexCommitSha: z.string().nullable().default(null),
  headSha: z.string().nullable().default(null),
  id: z.uuid(),
  slug: z.string(),
  name: z.string(),
  objective: z.string(),
  constraints: z.string().nullable(),
  status: z.enum(PROJECT_STATUSES),
  intakeReportArtifactId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  /** kind is DERIVED: a repository with origin_url ⇒ imported (recorded). */
  kind: z.enum(["greenfield", "imported"]),
  repository: z
    .object({
      barePath: z.string(),
      defaultBranch: z.string(),
      originUrl: z.string().nullable(),
    })
    .nullable(),
});
export type ProjectDto = z.infer<typeof ProjectDtoSchema>;

export const CreateProjectRequestSchema = z.object({
  /** TASK 7: proje yalnız bağlantı referansı taşır. */
  githubConnectionId: z.uuid().optional(),
  name: z.string().min(2).max(120),
  objective: z.string().min(4).max(8000),
  constraints: z.string().max(4000).optional(),
  /** Absent ⇒ greenfield; git URL ⇒ import intake (14 §2). */
  source: z
    .object({
      kind: z.literal("git_url"),
      url: z.string().regex(/^https?:\/\/[^\s'"\\]+$/).max(2048),
    })
    .optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const ProjectListResponseSchema = z.object({ items: z.array(ProjectDtoSchema) });
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

export const ArtifactDtoSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  title: z.string(),
  contentMd: z.string().nullable(),
  createdAt: z.iso.datetime(),
  meta: z.unknown(),
});
export type ArtifactDto = z.infer<typeof ArtifactDtoSchema>;
