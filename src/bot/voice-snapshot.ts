import type { DbSessionRow } from "../sessions";
import type { VoiceReader, VoiceSnapshot } from "./voice-read";

const GUEST_FLOOR = 5;
type Access = { visibility: "member" | "moderator"; canJoin: boolean };
type Profile = { name: string; avatarUrl?: string; show_in_live_rooms?: boolean };
type Audience = {
  session: Pick<DbSessionRow, "member" | "moderator"> | null;
  // Trusted View/Connect decisions for this viewer. Missing entries reveal nothing.
  roomAccess?: ReadonlyMap<string, Access>;
  // Current site profiles only; never bot input or cached preferences.
  profiles?: ReadonlyMap<string, Profile>;
};
type State = { freshness: "fresh" | "aging" | "frozen"; ageMs: number };
type WaitContext = Pick<ExecutionContext, "waitUntil">;

function project(snapshot: VoiceSnapshot, state: State, viewer: Audience) {
  if (viewer.session?.member !== true) {
    return snapshot.total_in_voice < GUEST_FLOOR
      ? null
      : { ...state, audience: "guest" as const, count: snapshot.total_in_voice };
  }
  const moderator = viewer.session.moderator === true;
  const rooms = snapshot.rooms.flatMap((room) => {
    const access = viewer.roomAccess?.get(room.channel_id);
    if (access?.visibility !== "member" && !(access?.visibility === "moderator" && moderator))
      return [];
    const ids = room.afk ? [] : room.member_ids;
    const occupants = ids.flatMap((id) => {
      const profile = viewer.profiles?.get(id);
      if (!profile || profile.show_in_live_rooms === false) return [];
      // Custom Discord CDN paths include member IDs. Use initials unless an ID-free avatar is available.
      const { name, avatarUrl } = profile;
      const safe =
        avatarUrl && /^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/[0-5]\.png$/.test(avatarUrl);
      return [safe ? { name, avatarUrl } : { name }];
    });
    return [
      {
        channelId: room.channel_id,
        name: room.name,
        count: ids.length,
        occupants,
        occupiedSince: room.afk ? null : (room.occupied_since ?? null),
        eventKey: room.event_key,
        canMove: state.freshness !== "frozen" && !room.afk && access.canJoin === true,
      },
    ];
  });
  return { ...state, audience: "member" as const, rooms };
}

export function createVoiceSnapshotCache(now = Date.now) {
  let good: { snapshot: VoiceSnapshot; fetchedAt: number } | undefined;
  let failed = false;
  let nextAttempt = -Infinity;
  let inFlight = false;
  return (read: VoiceReader, ctx: WaitContext, viewer: Audience) => {
    const time = now();
    if (!inFlight && time >= nextAttempt) {
      inFlight = true;
      nextAttempt = time + 10_000;
      ctx.waitUntil(
        Promise.resolve().then(async () => {
          try {
            const snapshot = await read();
            failed = snapshot === null;
            if (snapshot) good = { snapshot, fetchedAt: now() };
          } catch {
            failed = true;
          } finally {
            inFlight = false;
          }
        }),
      );
    }
    if (!good) return null;
    const ageMs = Math.max(0, time - good.fetchedAt, time - Date.parse(good.snapshot.observed_at));
    const freshness = failed || ageMs > 120_000 ? "frozen" : ageMs > 30_000 ? "aging" : "fresh";
    return project(good.snapshot, { freshness, ageMs }, viewer);
  };
}

/** Page-facing entry point: one cache per isolate; returns only a safe projection. */
export const readVoiceSnapshot = createVoiceSnapshotCache();
