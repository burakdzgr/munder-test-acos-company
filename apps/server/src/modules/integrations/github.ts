// GitHub bağlantısı (2026-08-18, Founder kararı: "github adresimi tam
// yetkiyle bağlamak istiyorum — repo açsınlar, publish etsinler").
//
// S2 korunur: PAT yalnız secrets seam'inde (MASTER_KEY ile mühürlü) yaşar,
// hiçbir ajan girdisinden/çıktısından geçmez; ajanlar GitHub'a DOĞRUDAN
// dokunmaz — iç bare repo tek gerçek kaynaktır (ADR-010), GitHub bir YANSIdır:
// lead merge sonrası sunucu default branch'i uzağa iter (publish), repo yoksa
// Founder'ın hesabında açar. Token URL'e gömülü gider ama asla loglanmaz.
import { and, eq } from "drizzle-orm";
import { companyContext, type CompanyContext, type GuardedDb } from "@acos/db";
import { githubConnections, projects, repositories, secrets } from "@acos/db/schema";
import { sealSecret, unsealSecret } from "../auth/crypto.js";

const TOKEN_SECRET = "github.token";
const OWNER_SECRET = "github.owner";
const API = "https://api.github.com";

export class GithubError extends Error {
  constructor(
    readonly code: "NOT_CONNECTED" | "TOKEN_INVALID" | "API_FAILED",
    message: string,
  ) {
    super(message);
  }
}

export interface GithubStatus {
  connected: boolean;
  owner: string | null;
}

export interface GithubConnectionDto {
  id: string;
  owner: string;
  scopes: string[];
  status: string;
  lastValidatedAt: string | null;
}

export class GithubService {
  constructor(
    private readonly db: GuardedDb,
    private readonly masterKey: string | undefined,
  ) {}

  private requireKey(): string {
    if (!this.masterKey) throw new GithubError("API_FAILED", "MASTER_KEY not configured");
    return this.masterKey;
  }

  private async readSecret(ctx: CompanyContext, name: string): Promise<string | null> {
    const [row] = await this.db
      .select({ ciphertext: secrets.ciphertext })
      .from(secrets)
      .where(and(eq(secrets.companyId, ctx.companyId), eq(secrets.name, name)));
    if (!row) return null;
    return unsealSecret(this.requireKey(), Buffer.from(row.ciphertext as Uint8Array));
  }

  private async writeSecret(
    ctx: CompanyContext,
    name: string,
    value: string,
    userId: string,
  ): Promise<void> {
    const sealed = await sealSecret(this.requireKey(), value);
    const existing = await this.db
      .select({ id: secrets.id })
      .from(secrets)
      .where(and(eq(secrets.companyId, ctx.companyId), eq(secrets.name, name)));
    if (existing[0]) {
      await this.db
        .update(secrets)
        .set({ ciphertext: sealed })
        .where(and(eq(secrets.companyId, ctx.companyId), eq(secrets.name, name)));
    } else {
      await this.db.insert(secrets).values({
        companyId: ctx.companyId,
        name,
        scope: "company",
        ciphertext: sealed,
        createdByUserId: userId,
      });
    }
  }

  async status(ctx: CompanyContext): Promise<GithubStatus> {
    if (!this.masterKey) return { connected: false, owner: null };
    const [conn] = await this.db
      .select({ owner: githubConnections.owner })
      .from(githubConnections)
      .where(
        and(
          eq(githubConnections.companyId, ctx.companyId),
          eq(githubConnections.status, "active"),
        ),
      )
      .limit(1);
    if (conn) return { connected: true, owner: conn.owner };
    // miras yol: 0021 öncesi tekil secret çifti
    const owner = await this.readSecret(ctx, OWNER_SECRET);
    const token = await this.readSecret(ctx, TOKEN_SECRET);
    return { connected: token !== null, owner };
  }

  /** TASK 7: bağlantı listesi — UI proje formunda seçim için. */
  async listConnections(ctx: CompanyContext): Promise<GithubConnectionDto[]> {
    const rows = await this.db
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.companyId, ctx.companyId));
    return rows
      .filter((r) => r.status !== "revoked")
      .map((r) => ({
        id: r.id,
        owner: r.owner,
        scopes: r.scopes,
        status: r.status,
        lastValidatedAt: r.lastValidatedAt?.toISOString() ?? null,
      }));
  }

  /**
   * PAT'i doğrular (GET /user) ve GitHubConnection satırı olarak modeller
   * (TASK 7): token `github.token.<connectionId>` adıyla mühürlenir, satır
   * yalnız credentialRef taşır. Aynı owner için yeniden bağlanmak token'ı
   * tazeler (idempotent).
   */
  async connect(ctx: CompanyContext, token: string, userId: string): Promise<GithubStatus> {
    const res = await fetch(`${API}/user`, { headers: this.headers(token) });
    if (res.status === 401 || res.status === 403) {
      throw new GithubError("TOKEN_INVALID", "GitHub token reddedildi (401/403)");
    }
    if (!res.ok) throw new GithubError("API_FAILED", `GitHub /user → ${res.status}`);
    const scopes = (res.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((sc) => sc.trim())
      .filter(Boolean);
    const user = (await res.json()) as { login?: string };
    if (!user.login) throw new GithubError("API_FAILED", "GitHub /user cevabında login yok");

    const [existing] = await this.db
      .select()
      .from(githubConnections)
      .where(
        and(
          eq(githubConnections.companyId, ctx.companyId),
          eq(githubConnections.owner, user.login),
        ),
      );
    let connectionId: string;
    if (existing) {
      connectionId = existing.id;
      await this.db
        .update(githubConnections)
        .set({
          status: "active",
          scopes,
          lastValidatedAt: new Date(),
          credentialRef: `github.token.${existing.id}`,
        })
        .where(
          and(
            eq(githubConnections.companyId, ctx.companyId),
            eq(githubConnections.id, existing.id),
          ),
        );
    } else {
      const [inserted] = await this.db
        .insert(githubConnections)
        .values({
          companyId: ctx.companyId,
          owner: user.login,
          credentialRef: "pending",
          scopes,
          status: "active",
          lastValidatedAt: new Date(),
        })
        .returning({ id: githubConnections.id });
      connectionId = inserted!.id;
      await this.db
        .update(githubConnections)
        .set({ credentialRef: `github.token.${connectionId}` })
        .where(
          and(
            eq(githubConnections.companyId, ctx.companyId),
            eq(githubConnections.id, connectionId),
          ),
        );
    }
    await this.writeSecret(ctx, `github.token.${connectionId}`, token, userId);
    return { connected: true, owner: user.login };
  }

  async disconnect(ctx: CompanyContext): Promise<void> {
    const rows = await this.db
      .select({ id: githubConnections.id, credentialRef: githubConnections.credentialRef })
      .from(githubConnections)
      .where(eq(githubConnections.companyId, ctx.companyId));
    for (const row of rows) {
      await this.db
        .delete(secrets)
        .where(and(eq(secrets.companyId, ctx.companyId), eq(secrets.name, row.credentialRef)));
      await this.db
        .update(githubConnections)
        .set({ status: "revoked" })
        .where(
          and(eq(githubConnections.companyId, ctx.companyId), eq(githubConnections.id, row.id)),
        );
    }
    // miras secret çifti de düşer
    await this.db
      .delete(secrets)
      .where(and(eq(secrets.companyId, ctx.companyId), eq(secrets.name, TOKEN_SECRET)));
    await this.db
      .delete(secrets)
      .where(and(eq(secrets.companyId, ctx.companyId), eq(secrets.name, OWNER_SECRET)));
  }

  /**
   * TASK 7: dispatch anında credential çözümü — proje bağlantısı → şirketin
   * ilk aktif bağlantısı → miras secret çifti. Token çağrı sınırından dışarı
   * ASLA çıkmaz (prompt/log/env yok).
   */
  async resolveConnection(
    ctx: CompanyContext,
    projectId: string | null,
  ): Promise<{ token: string; owner: string } | null> {
    if (!this.masterKey) return null;
    let row: { credentialRef: string; owner: string } | undefined;
    if (projectId) {
      const [project] = await this.db
        .select({ githubConnectionId: projects.githubConnectionId })
        .from(projects)
        .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, projectId)));
      if (project?.githubConnectionId) {
        [row] = await this.db
          .select({
            credentialRef: githubConnections.credentialRef,
            owner: githubConnections.owner,
          })
          .from(githubConnections)
          .where(
            and(
              eq(githubConnections.companyId, ctx.companyId),
              eq(githubConnections.id, project.githubConnectionId),
              eq(githubConnections.status, "active"),
            ),
          );
      }
    }
    if (!row) {
      [row] = await this.db
        .select({
          credentialRef: githubConnections.credentialRef,
          owner: githubConnections.owner,
        })
        .from(githubConnections)
        .where(
          and(
            eq(githubConnections.companyId, ctx.companyId),
            eq(githubConnections.status, "active"),
          ),
        )
        .limit(1);
    }
    if (row) {
      const token = await this.readSecret(ctx, row.credentialRef);
      if (token) return { token, owner: row.owner };
    }
    // miras yol
    const legacyToken = await this.readSecret(ctx, TOKEN_SECRET);
    const legacyOwner = await this.readSecret(ctx, OWNER_SECRET);
    if (legacyToken && legacyOwner) return { token: legacyToken, owner: legacyOwner };
    return null;
  }

  private headers(token: string): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "acos",
      "x-github-api-version": "2022-11-28",
    };
  }

  /**
   * Projenin GitHub yansımasını garanti eder: repositories.github_remote
   * doluysa onu döner; boşsa Founder hesabında private repo AÇAR ve bağlar.
   * Ad çakışırsa (422) mevcut repo bağlanır — idempotent.
   */
  async ensureRemote(
    ctx: CompanyContext,
    projectId: string,
    repoName: string,
  ): Promise<{ remoteUrl: string; token: string } | null> {
    const resolved = await this.resolveConnection(ctx, projectId).catch(() => null);
    if (!resolved) return null; // bağlı değil — sessizce atla (yansı opsiyonel)
    const { token, owner } = resolved;

    const [repo] = await this.db
      .select()
      .from(repositories)
      .where(and(eq(repositories.companyId, ctx.companyId), eq(repositories.projectId, projectId)));
    if (!repo) return null;
    if (repo.githubRemote) return { remoteUrl: repo.githubRemote, token };

    const safeName = repoName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90) || `acos-${projectId.slice(0, 8)}`;
    const res = await fetch(`${API}/user/repos`, {
      method: "POST",
      headers: { ...this.headers(token), "content-type": "application/json" },
      body: JSON.stringify({ name: safeName, private: true, auto_init: false }),
    });
    let remoteUrl: string;
    if (res.ok) {
      const created = (await res.json()) as { clone_url?: string };
      remoteUrl = created.clone_url ?? `https://github.com/${owner}/${safeName}.git`;
    } else if (res.status === 422) {
      // ad zaten var — mevcut repoya bağlan (idempotent yeniden yayın)
      remoteUrl = `https://github.com/${owner}/${safeName}.git`;
    } else {
      throw new GithubError("API_FAILED", `GitHub repo create → ${res.status}`);
    }
    await this.db
      .update(repositories)
      .set({ githubRemote: remoteUrl })
      .where(and(eq(repositories.companyId, ctx.companyId), eq(repositories.id, repo.id)));
    return { remoteUrl, token };
  }

  /** https://github.com/o/r.git → tokenlı push URL'i (asla loglanmaz). */
  static tokenizedUrl(remoteUrl: string, token: string): string {
    return remoteUrl.replace(/^https:\/\//, `https://x-access-token:${token}@`);
  }
}

/**
 * Projeyi GitHub'a yayınlar: remote yoksa Founder hesabında açar + bağlar,
 * sonra iç bare repo'yu iter. Route'tan (Founder tetikler) ve merge-sonrası
 * hook'tan (otomatik senkron) çağrılır. GitHub bağlı değilse sessiz no-op.
 */
export async function publishProjectToGithub(deps: {
  db: GuardedDb;
  masterKey: string | undefined;
  sandbox: { url: string; token: string };
  companyId: string;
  projectId: string;
}): Promise<{ published: boolean; remoteUrl: string | null }> {
  const ctx = companyContext(deps.companyId);
  const svc = new GithubService(deps.db, deps.masterKey);
  const [project] = await deps.db
    .select({ slug: projects.slug, name: projects.name })
    .from(projects)
    .where(and(eq(projects.companyId, ctx.companyId), eq(projects.id, deps.projectId)));
  if (!project) return { published: false, remoteUrl: null };
  const remote = await svc.ensureRemote(ctx, deps.projectId, project.slug ?? project.name);
  if (!remote) return { published: false, remoteUrl: null };
  const authB64 = Buffer.from(`x-access-token:${remote.token}`).toString("base64");
  const res = await fetch(`${deps.sandbox.url}/internal/v1/repos/publish`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${deps.sandbox.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ projectId: deps.projectId, remoteUrl: remote.remoteUrl, authB64 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GithubError("API_FAILED", `publish → ${res.status}: ${text.slice(0, 300)}`);
  }
  return { published: true, remoteUrl: remote.remoteUrl };
}

export function githubServiceFactory(
  guardedDb: () => GuardedDb,
  masterKey: string | undefined,
): (companyId: string) => { svc: GithubService; ctx: CompanyContext } {
  return (companyId) => ({
    svc: new GithubService(guardedDb(), masterKey),
    ctx: companyContext(companyId),
  });
}
