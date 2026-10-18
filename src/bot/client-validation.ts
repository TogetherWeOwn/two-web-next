import { BotTerminalError } from "../jobs/types";
import type { Announcement, EventUpsert, RoleAssignment } from "../jobs/types";

const charLen = (s: string): number => [...s].length;

/** Map keys are short slugs (MCP event_key ≤64, src/mcp/server.ts); location ≤255 (admin event form). Characters, never bytes. */
const KEY_MAX = 64;
const LOCATION_MAX = 255;

/** `role.assign`: discord_id is a snowflake (digits, ≤20); role_key is a key, never an ID. */
export function validateRoleAssign(a: RoleAssignment): void {
  if (!/^\d{1,20}$/.test(a.userId))
    throw new BotTerminalError(
      "A role.assign needs a Discord snowflake for discord_id: decimal digits, at most 20 of them.",
    );
  if (a.roleKey.trim() === "")
    throw new BotTerminalError(
      "A role.assign needs a role_key. It is a key from the bot role map, not a Discord role id.",
    );
  if (charLen(a.roleKey) > KEY_MAX)
    throw new BotTerminalError(
      `A role_key is at most ${KEY_MAX} characters; this one is ${charLen(a.roleKey)}.`,
    );
}

/** `announcement.post`: needs an idempotency key on every call (a repeat without one posts twice). */
export function validateAnnouncement(a: Announcement): void {
  if (a.channelKey.trim() === "")
    throw new BotTerminalError(
      "An announcement.post needs a channel_key. It is a key from the bot channel map, not a Discord channel id.",
    );
  if (charLen(a.channelKey) > KEY_MAX)
    throw new BotTerminalError(
      `A channel_key is at most ${KEY_MAX} characters; this one is ${charLen(a.channelKey)}.`,
    );
  if (a.body.trim() === "") throw new BotTerminalError("An announcement.post needs a body.");
  if (charLen(a.body) > 2000)
    throw new BotTerminalError(
      `An announcement body is at most 2000 characters; this one is ${charLen(a.body)}.`,
    );
}

/** `event.upsert`: external events only (location, exactly one of channel_key/location — this client only sends location). */
export function validateEventUpsert(e: EventUpsert): void {
  if (e.eventKey.trim() === "")
    throw new BotTerminalError(
      "An event.upsert needs an event_key: it is how the bot finds the event to update.",
    );
  if (charLen(e.eventKey) > KEY_MAX)
    throw new BotTerminalError(
      `An event_key is at most ${KEY_MAX} characters; this one is ${charLen(e.eventKey)}.`,
    );
  if (e.name.trim() === "") throw new BotTerminalError("An event.upsert needs a name.");
  if (charLen(e.name) > 100)
    throw new BotTerminalError(
      `An event name is at most 100 characters; this one is ${charLen(e.name)}.`,
    );
  if (e.description !== null && charLen(e.description) > 1000)
    throw new BotTerminalError(
      `An event description is at most 1000 characters; this one is ${charLen(e.description)}.`,
    );
  if (e.location.trim() === "")
    throw new BotTerminalError(
      "An event.upsert needs a location. The bot takes exactly one of channel_key or location, and this client only ever sends location.",
    );
  if (charLen(e.location) > LOCATION_MAX)
    throw new BotTerminalError(
      `A location is at most ${LOCATION_MAX} characters; this one is ${charLen(e.location)}.`,
    );
  const startsAt = Date.parse(e.startsAt);
  const endsAt = e.endsAt === null ? NaN : Date.parse(e.endsAt);
  if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || endsAt <= startsAt)
    throw new BotTerminalError("An event needs valid timestamps and must end after it starts.");
}
