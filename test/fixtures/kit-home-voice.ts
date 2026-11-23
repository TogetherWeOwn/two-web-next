import type { VoiceSnapshot } from "../../src/bot/voice-read";
import { createVoiceSnapshotCache } from "../../src/bot/voice-snapshot";
import type { VoiceView } from "../../web/src/lib/voice-view";

export type HomeVoiceState = "guest" | "member" | "quiet" | "absent" | "belowFloor" | "frozen";
export const allowedRoom = "Co-op Lounge";
export const privateRoom = "Private Room Sentinel";
export const optedOutName = "Opted Out Sentinel";
export const roomId = "100000000000001";
export const memberId = "200000000000001";

// Use the real cache privacy projection with explicit synthetic access proof.
// Only the narrower view below is serialized to the offline Home fixture.
export async function homeVoiceFixture(state: HomeVoiceState): Promise<VoiceView> {
  const member = state === "member" || state === "quiet" || state === "frozen";
  const now = Date.UTC(2026, 9, 20, 12);
  const snapshot: VoiceSnapshot = {
    v: 1,
    observed_at: new Date(now - (state === "frozen" ? 185_000 : 12_000)).toISOString(),
    total_in_voice: state === "quiet" || state === "belowFloor" ? 2 : 5,
    rooms: [
      {
        channel_id: roomId,
        name: allowedRoom,
        position: 1,
        user_limit: 8,
        member_ids: state === "quiet" || state === "belowFloor" ? [] : [memberId, "2", "3"],
      },
      {
        channel_id: "100000000000002",
        name: privateRoom,
        position: 2,
        user_limit: 0,
        member_ids: ["4", "5"],
      },
    ],
  };
  const cache = createVoiceSnapshotCache(() => now);
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (work: Promise<unknown>) => pending.push(work) };
  const viewer = {
    session: member ? { member: true, moderator: false } : null,
    roomAccess: new Map([[roomId, { visibility: "member" as const, canJoin: true }]]),
    profiles: new Map([
      [memberId, { name: "Mika", show_in_live_rooms: true }],
      ["2", { name: optedOutName, show_in_live_rooms: false }],
    ]),
  };
  const read = async () => (state === "absent" ? null : snapshot);
  cache(read, ctx, viewer);
  await Promise.all(pending);
  const result = cache(read, ctx, viewer);
  if (!result) return { audience: member ? "member" : "guest", snapshot: null };
  const { ageMs, freshness } = result;
  if (result.audience === "member") {
    return {
      audience: "member",
      snapshot: {
        ageMs,
        freshness,
        rooms: result.rooms.map(({ name, count, occupants }) => ({ name, count, occupants })),
      },
    };
  }
  return { audience: "guest", snapshot: { ageMs, freshness, count: result.count } };
}
