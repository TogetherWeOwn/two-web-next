// Calendar row model: anything the month grid or list renders — a persisted
// row or a Discord transient — plus the key/zone/title/location readers every
// calendar leaf shares.
import { transientEventKey } from "../islands/contracts";
import type { DiscordTransient } from "../islands/contracts";
import type { PublicEvent } from "./reads";

/** Anything the calendar renders: a persisted row or a Discord transient. */
export type CalRow = PublicEvent | DiscordTransient;
export const isTransient = (e: CalRow): e is DiscordTransient => "discordId" in e;
export const rowKey = (e: CalRow): string =>
  isTransient(e) ? transientEventKey(e.discordId) : e.eventKey;
export const rowZone = (e: CalRow, fallback: string): string =>
  isTransient(e) ? fallback : e.timezone;
export const rowTitle = (e: CalRow): string => e.title;
export const rowLocation = (e: CalRow): string | null => e.location;
