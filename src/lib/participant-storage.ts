// Per-session participant identity stored in localStorage so the player keeps
// their seat after a reload.
export type ParticipantIdentity = {
  id: string;
  sessionId: string;
  nickname: string;
  secretToken: string;
  avatarId?: string | null;
};

const KEY = "brainbolt:participants";

function readAll(): Record<string, ParticipantIdentity> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, ParticipantIdentity>) {
  localStorage.setItem(KEY, JSON.stringify(map));
}

export function getParticipant(sessionId: string): ParticipantIdentity | null {
  return readAll()[sessionId] ?? null;
}

export function saveParticipant(p: ParticipantIdentity) {
  const all = readAll();
  all[p.sessionId] = p;
  writeAll(all);
}

export function clearParticipant(sessionId: string) {
  const all = readAll();
  delete all[sessionId];
  writeAll(all);
}
