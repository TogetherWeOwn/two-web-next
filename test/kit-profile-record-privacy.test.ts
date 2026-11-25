import { expect, it } from "vitest";
import type { AttendanceMember } from "../src/bot/attendance-read";
import { buildFrozenEcho } from "../src/events/echoes";
import { profileRecordEntries, profileRecordFixture } from "./fixtures/profile-record-preview";

const owner = { id: "900000000000000001", leaderboardOptOut: false };
const other = "900000000000000002";
const optedOut = { ...owner, leaderboardOptOut: true };

function member(id: string, minutes: number): Omit<AttendanceMember, "first_joined_at"> {
  return { discord_id: id, minutes, sessions: 2 };
}

function frozenEvent(
  id: number,
  day: string,
  title: string,
  members: ReturnType<typeof member>[],
  thresholdMinutes = 10,
) {
  const eventKey = `fixture-event-${id}`;
  const snapshot = buildFrozenEcho(
    { id, eventKey, status: "past" },
    {
      ok: true,
      attendance: {
        v: 1,
        event_key: eventKey,
        window: { starts_at: `${day}T18:00:00Z`, ends_at: `${day}T21:00:00Z` },
        threshold_minutes: thresholdMinutes,
        peak_concurrent: members.length,
        rooms: [{ channel_id: "900000000000000099", name_at_close: "Fixture room" }],
        members: members.map((row) => ({ ...row, first_joined_at: `${day}T18:31:00Z` })),
        final: true,
      },
    },
  );
  if (!snapshot) throw new Error("Expected a frozen synthetic Echo");

  // Additive internal fields must stay private even if the snapshot type grows.
  return { title, snapshot: { ...snapshot, absence: { userId: owner.id, missed: 17 } } };
}

const qualifying = [
  frozenEvent(1, "2026-10-12", "Fixture raid", [member(owner.id, 10)]),
  frozenEvent(2, "2026-10-21", "Fixture co-op", [member(other, 91), member(owner.id, 37)]),
];
const noQualifying = [
  frozenEvent(
    3,
    "2026-10-22",
    "Fixture short visit",
    [member(owner.id, 14), member(other, 64)],
    15,
  ),
  frozenEvent(4, "2026-10-23", "Fixture other night", [member(other, 62)]),
];
const events = [...noQualifying, ...qualifying];

function previewPayload(viewerId: string, subject = owner, input = events): unknown {
  return JSON.parse(JSON.stringify(profileRecordFixture(viewerId, subject, input)));
}

it("serializes only the owner's qualifying Echo days and dated Record entries", () => {
  expect(previewPayload(owner.id)).toStrictEqual({
    echoTrail: ["2026-10-21", "2026-10-12"],
    record: [
      { day: "2026-10-21", title: "Fixture co-op", kind: "Echo" },
      profileRecordEntries[0],
      { day: "2026-10-12", title: "Fixture raid", kind: "Echo" },
      profileRecordEntries[1],
    ],
  });
});

it("gives another viewer the same Record with or without the subject's opt-out", () => {
  const expected = { record: profileRecordEntries };
  expect(previewPayload(other)).toStrictEqual(expected);
  expect(previewPayload(other, optedOut)).toStrictEqual(expected);
});

it("omits the trail and attendance Record entries for an opted-out owner", () => {
  expect(previewPayload(owner.id, optedOut)).toStrictEqual({ record: profileRecordEntries });
});

it("makes a below-threshold or missing member row indistinguishable from no Echo", () => {
  const expected = { record: profileRecordEntries };
  expect(previewPayload(owner.id, owner, noQualifying)).toStrictEqual(expected);
  expect(previewPayload(owner.id, owner, [])).toStrictEqual(expected);
});
