import type { LiveVoiceEvent, NextVoiceEvent, VoiceView } from "../../web/src/lib/voice-view";

const nextEvent = { title: "Friday Raid", timeLabel: "21:00 BST" };
const liveEvent = { title: "Thursday Co-op", key: "thursday-co-op" };
const rooms = [
  {
    name: "Raid 1",
    count: 4,
    occupants: [{ name: "Mika" }, { name: "Robin" }],
    eventKey: liveEvent.key,
  },
  { name: "Squad 2", count: 2, occupants: [{ name: "Ari" }] },
];

type Fixture = { view: VoiceView; nextEvent?: NextVoiceEvent; liveEvent?: LiveVoiceEvent };
export const voiceViews = {
  quiet: {
    view: {
      audience: "member",
      snapshot: {
        freshness: "fresh",
        ageMs: 12_000,
        rooms: [{ name: "Raid 1", count: 0, occupants: [] }],
      },
    },
    nextEvent,
  },
  member: {
    view: { audience: "member", snapshot: { freshness: "aging", ageMs: 45_000, rooms } },
    nextEvent,
    liveEvent,
  },
  guest: {
    view: { audience: "guest", snapshot: { freshness: "fresh", ageMs: 12_000, count: 5 } },
    nextEvent,
    liveEvent,
  },
  // The guest projection is null below the floor and when no snapshot exists.
  absent: { view: { audience: "guest", snapshot: null }, nextEvent, liveEvent },
  frozen: {
    view: { audience: "member", snapshot: { freshness: "frozen", ageMs: 185_000, rooms } },
    nextEvent,
    liveEvent,
  },
} satisfies Record<string, Fixture>;
