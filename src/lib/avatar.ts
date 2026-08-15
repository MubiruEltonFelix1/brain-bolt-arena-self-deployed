import { AVATARS, AVATARS_BY_ID, type Avatar } from "@/assets/avatars";

export const DEFAULT_AVATAR_ID = AVATARS[0]?.id ?? "owl";

/**
 * Resolve an avatar by id. Falls back to a deterministic pick based on a seed
 * (e.g. participant id or nickname) so legacy records without an avatar_id
 * still render a stable avatar rather than a blank placeholder.
 */
export function resolveAvatar(id?: string | null, seed?: string | null): Avatar {
  if (id && AVATARS_BY_ID[id]) return AVATARS_BY_ID[id];
  if (seed && seed.length > 0) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    return AVATARS[Math.abs(h) % AVATARS.length];
  }
  return AVATARS_BY_ID[DEFAULT_AVATAR_ID] ?? AVATARS[0];
}

export { AVATARS, AVATARS_BY_ID, type Avatar };
