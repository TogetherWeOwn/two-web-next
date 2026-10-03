// Bot action contracts (W15). Ports the construction-time validation from
// two-web app/Services/Bot/{RoleAssignment,Announcement,EventUpsert,EventCancel}.php,
// pinned by tests/Unit/Services/Bot/RoleAndAnnouncementTest.php and
// InternalActionClientTest.php. The signer (src/bot/signer.ts, W14) puts these
// payloads on the wire; the queue consumer (src/jobs/*, W13) carries them.
//
// The rules that matter:
// - `role.assign` sends NO idempotency key (natural idempotency, §3); a keyed
//   repeat of `announcement.post` / `event.upsert` / `event.cancel` WOULD post
//   twice, so those require a UUID key on every call.
// - Limits count CHARACTERS, not bytes: a 2000-character accented body posts.
// - `[Symbol.iterator]`/`length` count UTF-16 code units, not characters; the
//   legacy counts with mb_strlen (grapheme-ish code points). `[...s].length`
//   matches it for the BMP text Discord accepts.
// - `discordId` is decimal digits, at most 20 (a 64-bit snowflake); blank
//   channel/body/name/location/keys are refused, all before anything is sent.

export class InvalidActionRequestError extends Error {}

/** Exact bytes the vectors were signed over (bot-signer.test.ts). */
export type ActionPayload = Record<string, string>;

const isUuid = (v: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Discord counts characters; match PHP mb_strlen for BMP text. */
const charLen = (s: string): number => [...s].length;

const blank = (v: string): boolean => v.trim() === "";

export function assertIdempotencyKey(key: string): void {
  if (!isUuid(key))
    throw new InvalidActionRequestError(
      `An idempotency key is a UUID; got ${JSON.stringify(key)}.`,
    );
}

export type RoleAssignment = { discordId: string; roleKey: string };

export function roleAssignPayload(a: RoleAssignment): ActionPayload {
  // Up to 20 digits: a snowflake is a 64-bit integer, and a truncated id is
  // still digits — the width is worth pinning (legacy RoleAssignment).
  if (!/^\d{1,20}$/.test(a.discordId)) {
    throw new InvalidActionRequestError(
      "A role.assign needs a Discord snowflake for discord_id: decimal digits, at most 20 of them.",
    );
  }
  if (blank(a.roleKey)) {
    throw new InvalidActionRequestError(
      "A role.assign needs a role_key. It is a key from the bot role map, not a Discord role id.",
    );
  }
  return { action: "role.assign", discord_id: a.discordId, role_key: a.roleKey };
}

const ANNOUNCEMENT_MAX_BODY = 2000;

export type Announcement = { channelKey: string; body: string };

export function announcementPayload(a: Announcement): ActionPayload {
  if (blank(a.channelKey)) {
    throw new InvalidActionRequestError(
      "An announcement.post needs a channel_key. It is a key from the bot channel map, not a Discord channel id.",
    );
  }
  if (blank(a.body)) throw new InvalidActionRequestError("An announcement.post needs a body.");
  // Characters, not bytes — the difference is whether a 2000-character
  // announcement with an accent in it posts (legacy Announcement).
  if (charLen(a.body) > ANNOUNCEMENT_MAX_BODY) {
    throw new InvalidActionRequestError(
      `An announcement body is at most ${ANNOUNCEMENT_MAX_BODY} characters; this one is ${charLen(a.body)}.`,
    );
  }
  return { action: "announcement.post", channel_key: a.channelKey, body: a.body };
}

const EVENT_MAX_NAME = 100;
const EVENT_MAX_DESCRIPTION = 1000;

export type EventUpsert = {
  eventKey: string;
  name: string;
  /** UTC instants; the wire carries Zulu, never an offset (TOG-52). */
  startsAt: Date;
  endsAt: Date;
  location: string;
  /** Null omits the key entirely (null ≠ absent on the wire). */
  description: string | null;
};

const toZulu = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, "Z");

// The wire carries whole seconds, so ordering is judged at whole-second
// precision: sub-second instants inside the same second would otherwise be
// accepted here and serialized as a zero-length event Discord refuses.
// Truncation (floor), never rounding — rounding could push endsAt up a whole
// second past what the caller approved.
const toWholeSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);

export function eventUpsertPayload(e: EventUpsert): ActionPayload {
  if (blank(e.eventKey)) {
    throw new InvalidActionRequestError(
      "An event.upsert needs an event_key: it is how the bot finds the event to update.",
    );
  }
  if (blank(e.name)) throw new InvalidActionRequestError("An event.upsert needs a name.");
  if (charLen(e.name) > EVENT_MAX_NAME) {
    throw new InvalidActionRequestError(
      `An event name is at most ${EVENT_MAX_NAME} characters; this one is ${charLen(e.name)}.`,
    );
  }
  if (e.description !== null && charLen(e.description) > EVENT_MAX_DESCRIPTION) {
    throw new InvalidActionRequestError(
      `An event description is at most ${EVENT_MAX_DESCRIPTION} characters; this one is ${charLen(e.description)}.`,
    );
  }
  if (blank(e.location)) {
    throw new InvalidActionRequestError(
      "An event.upsert needs a location. The bot takes exactly one of channel_key or location, and this client only ever sends location.",
    );
  }
  // Strictly after at the precision the wire carries: Discord refuses a
  // zero-length event, and two instants inside the same second serialize
  // to equal timestamps.
  if (!(toWholeSeconds(e.endsAt) > toWholeSeconds(e.startsAt))) {
    throw new InvalidActionRequestError("An event must end after it starts.");
  }
  const payload: ActionPayload = {
    action: "event.upsert",
    event_key: e.eventKey,
    name: e.name,
    starts_at: toZulu(e.startsAt),
    ends_at: toZulu(e.endsAt),
    location: e.location,
  };
  if (e.description !== null) payload.description = e.description;
  return payload;
}

export type EventCancel = { eventKey: string };

export function eventCancelPayload(e: EventCancel): ActionPayload {
  if (blank(e.eventKey)) {
    throw new InvalidActionRequestError("An event.cancel needs an event_key.");
  }
  return { action: "event.cancel", event_key: e.eventKey };
}
