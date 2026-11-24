import { describe, expect, it } from "vitest";
import { projectPublicEcho } from "../src/events/echo-public";

const echo = {
  eventId: 7,
  eventKey: "01KTESTEVENTKEY000000000001",
  headline: "A full night in the Tavern",
  attendedCount: 2,
  peakConcurrent: 24,
  rooms: [
    { channel_id: "111111111111111111", name_at_close: "Tavern", name: "Renamed Tavern" },
    { channel_id: "222222222222222222", name_at_close: "Side Room" },
  ],
  windowEndsAt: new Date("2026-10-20T21:00:00Z"),
  thresholdMinutes: 10,
};

const publicEcho = {
  eventId: 7,
  eventKey: "01KTESTEVENTKEY000000000001",
  label: "attendance record",
  headline: "A full night in the Tavern",
  attendedCount: 2,
  peakConcurrent: 24,
  rooms: [{ name: "Tavern" }, { name: "Side Room" }],
  windowEndsAt: "2026-10-20T21:00:00.000Z",
  thresholdMinutes: 10,
};

describe("projectPublicEcho", () => {
  it("keeps only approved metadata, frozen counts, and room names", () => {
    const internalEcho = {
      ...echo,
      id: 42,
      members: [
        { userId: "900000000000000001", minutes: 95, sessions: 2 },
        { userId: "900000000000000002", minutes: 4, sessions: 1 },
      ],
      absences: [{ userId: "900000000000000003" }],
    };

    expect(projectPublicEcho(internalEcho)).toStrictEqual(publicEcho);
  });

  it("preserves zero counts, empty rooms, and a null headline", () => {
    const empty = { headline: null, attendedCount: 0, peakConcurrent: 0, rooms: [] };
    expect(projectPublicEcho({ ...echo, ...empty })).toStrictEqual({ ...publicEcho, ...empty });
  });

  it("preserves an empty headline", () => {
    expect(projectPublicEcho({ ...echo, headline: "" })).toStrictEqual({
      ...publicEcho,
      headline: "",
    });
  });
});
