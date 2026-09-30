import { describe, expect, it } from "vitest";
import {
  InvalidActionRequestError,
  announcementPayload,
  assertIdempotencyKey,
  eventCancelPayload,
  eventUpsertPayload,
  roleAssignPayload,
} from "../src/bot/actions";

// W15: construction-time validation for the bot action payloads, ported from
// two-web tests/Unit/Services/Bot/RoleAndAnnouncementTest.php and the
// validation dataset of InternalActionClientTest.php
// ('rejects an event that breaks the documented limits' + the two limit
// boundary tests). The wire behaviour around these payloads — signing,
// envelopes, retryability, replay headers — is pinned in bot-signer.test.ts;
// the ingress side in agent-events.test.ts.
//
// Pure: no database, no HTTP. What is asserted here is only what differs
// between the actions: role.assign carries NO idempotency key (natural
// idempotency, docs/INTERNAL_ACTIONS.md §3), while announcement.post /
// event.upsert / event.cancel require a UUID key on every call.

const UUID = "9f1c0a2b-3d4e-5f60-7182-93a4b5c6d7e8";

describe("role.assign", () => {
  it("builds the documented payload, by key and never by role id", () => {
    expect(roleAssignPayload({ discordId: "900000000000009999", roleKey: "rocketleague" })).toEqual({
      action: "role.assign",
      discord_id: "900000000000009999",
      role_key: "rocketleague",
    });
  });

  it.each(["everyone", "<@900000000000009999>", "", "999999999999999999999", "9000000000000099ab"])(
    "refuses a discord id that is not a snowflake: %j",
    (discordId) => {
      expect(() => roleAssignPayload({ discordId, roleKey: "rocketleague" })).toThrow(InvalidActionRequestError);
    },
  );

  it("refuses a blank role key", () => {
    expect(() => roleAssignPayload({ discordId: "900000000000009999", roleKey: "  " })).toThrow(
      InvalidActionRequestError,
    );
  });
});

describe("announcement.post", () => {
  it("builds the payload verbatim, mentions included", () => {
    // The bot posts with `allowed_mentions: { parse: [] }`, so an @everyone
    // appears as typed and notifies nobody. Stripping or escaping it here
    // would be a second, invisible policy on top of the one enforced there.
    expect(announcementPayload({ channelKey: "qa-throwaway", body: "hi @everyone" })).toEqual({
      action: "announcement.post",
      channel_key: "qa-throwaway",
      body: "hi @everyone",
    });
  });

  it.each([
    ["no channel key", "", "hello"],
    ["blank channel key", "   ", "hello"],
    ["no body", "qa-throwaway", ""],
    ["blank body", "qa-throwaway", "  \n "],
    ["body over 2000 characters", "qa-throwaway", "a".repeat(2001)],
  ])("refuses an announcement that breaks the documented limits (%s)", (_label, channelKey, body) => {
    expect(() => announcementPayload({ channelKey, body })).toThrow(InvalidActionRequestError);
  });

  it("accepts a body exactly on the 2000 character limit and counts characters not bytes", () => {
    // 2000 multi-byte characters is 4000 bytes. Counting bytes would refuse an
    // announcement Discord accepts.
    expect(announcementPayload({ channelKey: "qa-throwaway", body: "é".repeat(2000) }).body).toHaveLength(2000);
    expect(announcementPayload({ channelKey: "qa-throwaway", body: "a".repeat(2000) }).body).toHaveLength(2000);
  });
});

describe("event.upsert", () => {
  const movieNight = () =>
    eventUpsertPayload({
      eventKey: "movie-night-2026-09-01",
      name: "Movie Night",
      startsAt: new Date("2026-09-01T18:00:00Z"),
      endsAt: new Date("2026-09-01T20:30:00Z"),
      location: "https://twitch.tv/togetherweown",
      description: "Bring popcorn.",
    });

  it("sends exactly the json body it means to send", () => {
    // Pinned byte for byte. The body is what gets hashed into the signature,
    // so it is not free to drift: a reordered key or an escaped slash changes
    // the digest, and the bot answers `unauthorized` with no clue as to why.
    // (bot-signer.test.ts signs this exact string.)
    expect(JSON.stringify(movieNight())).toBe(
      '{"action":"event.upsert","event_key":"movie-night-2026-09-01",' +
        '"name":"Movie Night","starts_at":"2026-09-01T18:00:00Z","ends_at":"2026-09-01T20:30:00Z",' +
        '"location":"https://twitch.tv/togetherweown","description":"Bring popcorn."}',
    );
  });

  it("sends location and never channel_key", () => {
    // EventUpsert has no channel_key to set: sending exactly one of the two
    // is a property of the type.
    const body = movieNight();
    expect(body).toHaveProperty("location");
    expect(body).not.toHaveProperty("channel_key");
  });

  it("omits description entirely when there is none", () => {
    // A null is not the same as an absent field to a validator that checks types.
    const body = eventUpsertPayload({
      eventKey: "raid-night",
      name: "Raid Night",
      startsAt: new Date("2026-09-02T18:00:00Z"),
      endsAt: new Date("2026-09-02T21:00:00Z"),
      location: "The Lounge",
      description: null,
    });
    expect(body).not.toHaveProperty("description");
  });

  it("sends instants in utc whatever timezone they were built in", () => {
    // 19:00 Europe/London (BST) is 18:00 UTC. An offset the bot has to
    // reinterpret is a bug waiting for the clocks to change (TOG-52).
    const body = eventUpsertPayload({
      eventKey: "london-social",
      name: "London Social",
      startsAt: new Date("2026-09-01T19:00:00+01:00"),
      endsAt: new Date("2026-09-01T21:00:00+01:00"),
      location: "The Lounge",
      description: null,
    });
    expect(body.starts_at).toBe("2026-09-01T18:00:00Z");
    expect(body.ends_at).toBe("2026-09-01T20:00:00Z");
  });

  it.each([
    ["name over 100 characters", { name: "a".repeat(101) }],
    ["description over 1000 characters", { description: "a".repeat(1001) }],
    ["ends_at before starts_at", { startsAt: new Date("2026-09-01T19:00:00Z"), endsAt: new Date("2026-09-01T18:00:00Z") }],
    ["ends_at equal to starts_at", { startsAt: new Date("2026-09-01T18:00:00Z"), endsAt: new Date("2026-09-01T18:00:00Z") }],
    ["blank name", { name: "   " }],
    ["blank event key", { eventKey: "" }],
    ["blank location", { location: "   " }],
  ])("refuses an event that breaks the documented limits (%s)", (_label, override) => {
    expect(() =>
      eventUpsertPayload({
        eventKey: "k",
        name: "Name",
        startsAt: new Date("2026-09-01T18:00:00Z"),
        endsAt: new Date("2026-09-01T19:00:00Z"),
        location: "here",
        description: null,
        ...override,
      }),
    ).toThrow(InvalidActionRequestError);
  });

  it("refuses instants that serialize to the same whole second", () => {
    // The wire carries whole seconds: .100Z and .900Z of the same second are
    // the zero-length event the constructor promises to refuse.
    expect(() =>
      eventUpsertPayload({
        eventKey: "k",
        name: "Name",
        startsAt: new Date("2026-09-01T18:00:00.100Z"),
        endsAt: new Date("2026-09-01T18:00:00.900Z"),
        location: "here",
        description: null,
      }),
    ).toThrow(InvalidActionRequestError);
    // A full second apart still serializes to distinct timestamps.
    const body = eventUpsertPayload({
      eventKey: "k",
      name: "Name",
      startsAt: new Date("2026-09-01T18:00:00.900Z"),
      endsAt: new Date("2026-09-01T18:00:01.100Z"),
      location: "here",
      description: null,
    });
    expect(body.starts_at).toBe("2026-09-01T18:00:00Z");
    expect(body.ends_at).toBe("2026-09-01T18:00:01Z");
  });

  it("accepts a name and a description exactly on the limit", () => {
    const body = eventUpsertPayload({
      eventKey: "k",
      name: "a".repeat(100),
      startsAt: new Date("2026-09-01T18:00:00Z"),
      endsAt: new Date("2026-09-01T19:00:00Z"),
      location: "here",
      description: "b".repeat(1000),
    });
    expect(body.name).toHaveLength(100);
    expect(body.description).toHaveLength(1000);
  });

  it("counts characters and not bytes against the limits", () => {
    // Discord's ceiling is characters. Counting bytes would refuse a
    // legitimate 100-character name with an accent in it.
    const body = eventUpsertPayload({
      eventKey: "k",
      name: "é".repeat(100),
      startsAt: new Date("2026-09-01T18:00:00Z"),
      endsAt: new Date("2026-09-01T19:00:00Z"),
      location: "here",
      description: null,
    });
    expect([...body.name!].length).toBe(100);
  });
});

describe("event.cancel", () => {
  it("builds the documented payload", () => {
    expect(eventCancelPayload({ eventKey: "movie-night-2026-09-01" })).toEqual({
      action: "event.cancel",
      event_key: "movie-night-2026-09-01",
    });
  });

  it("refuses a blank event key", () => {
    expect(() => eventCancelPayload({ eventKey: "  " })).toThrow(InvalidActionRequestError);
  });
});

describe("idempotency keys", () => {
  it("accepts a uuid key and refuses anything else, before anything is sent", () => {
    expect(() => assertIdempotencyKey(UUID)).not.toThrow();
    expect(() => assertIdempotencyKey("not-a-uuid")).toThrow(InvalidActionRequestError);
    expect(() => assertIdempotencyKey("")).toThrow(InvalidActionRequestError);
  });
});
