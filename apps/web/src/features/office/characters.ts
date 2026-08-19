// Avatar library (36 §15 / PixelLab-ASSET-BRIEF §3 — U15): loads the baked
// avatars.json index and resolves an agent's character. PURE data — the
// office lint rule keeps Pixi loading inside the bridge (OfficeCanvas).
// Persistent-identity invariant, visually: the same agent always resolves to
// the same character (explicit `pixel:avNN` from the hire modal, else a
// deterministic hash of the agent id).
export type WalkDir = "down" | "up" | "left" | "right";

export interface AvatarEntry {
  avatarId: string;
  portrait: string;
  walk: Record<WalkDir, string[]>;
  idle: Record<WalkDir, string>;
}

export const AVATAR_COUNT = 24;
export const SPRITE_BASE = "/sprites/characters";

let cached: Promise<AvatarEntry[]> | null = null;

export function loadAvatars(): Promise<AvatarEntry[]> {
  cached ??= fetch(`${SPRITE_BASE}/avatars.json`).then(async (response) => {
    if (!response.ok) throw new Error(`avatars.json ${response.status}`);
    return (await response.json()) as AvatarEntry[];
  });
  return cached;
}

/** hire modal writes agents.avatar_url as `pixel:avNN`; anything else falls
 *  back to a stable per-agent hash so unpicked agents still get a face. */
export function resolveAvatarId(agentId: string, avatarUrl?: string | null): string {
  const explicit = avatarUrl?.match(/^pixel:(av\d{2})$/);
  if (explicit) return explicit[1]!;
  let hash = 0;
  for (const char of agentId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `av${String((hash % AVATAR_COUNT) + 1).padStart(2, "0")}`;
}

export function portraitUrl(avatarId: string): string {
  return `${SPRITE_BASE}/portraits/${avatarId}.png`;
}
