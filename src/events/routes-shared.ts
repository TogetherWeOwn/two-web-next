// Shared event-route middleware and serializers. Split out of
// src/events/routes.tsx so each route group registers from its own module;
// this file holds what at least two groups use. Re-exported from the barrel.
import type { Context, Hono } from "hono";
import type { Env, Session } from "../env";
import { loginUrl, wallDateIso, wallTimeHm } from "../islands/contracts";
import { safeNext } from "../join/service";
import { throttleGuard } from "../throttle";
import type { PublicEvent } from "./reads";

export type Ctx = Context<{ Bindings: Env }>;
export type App = Hono<{ Bindings: Env }>;
export type SessionReader = (c: Ctx) => Promise<Session | null>;

export const PUBLIC_EVENT_READS_PER_MINUTE = 60;

/** One client budget across public pages and feeds, before event or session reads. */
export async function publicReadGuard(c: Ctx): Promise<Response | null> {
  const limited = await throttleGuard(c, "events-read", PUBLIC_EVENT_READS_PER_MINUTE);
  if (limited) limited.headers.set("cache-control", "no-store, private");
  return limited;
}

export const eventsUnavailable = (c: Ctx) => c.text("Events temporarily unavailable", 503);

export function eventJson(e: PublicEvent) {
  // Legacy EventResource order: event_key first, synced_to_discord
  // last, never the autoincrement id. The wall readings sit beside the UTC
  // instants so consumers render the host's wall time without re-resolving
  // the zone; synced_to_discord derives from the mirror column so the raw
  // discord_event_id never leaves the server.
  const wall = (d: Date) => `${wallDateIso(d, e.timezone)} ${wallTimeHm(d, e.timezone)}`;
  return {
    event_key: e.eventKey,
    title: e.title,
    game: e.game,
    description: e.description,
    starts_at: e.startsAt.toISOString(),
    ends_at: e.endsAt.toISOString(),
    starts_at_local: wall(e.startsAt),
    ends_at_local: wall(e.endsAt),
    timezone: e.timezone,
    location: e.location,
    capacity: e.capacity,
    going_count: e.goingCount,
    status: e.status,
    rsvp_open: e.rsvpOpen,
    synced_to_discord: e.discordEventId !== null,
  };
}

async function etagFor(body: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(body));
  return `"${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

export async function jsonSession(
  c: Ctx,
  readFragmentSession: SessionReader,
): Promise<Session | Response> {
  c.header("cache-control", "private, no-store");
  c.header("vary", "Cookie, Accept");
  // Non-rotating: JSON polling must not consume the browser's session cookie.
  const session = await readFragmentSession(c);
  if (session) return session;
  const ranges = (c.req.header("accept") ?? "")
    .toLowerCase()
    .split(",")
    .map((range) => {
      const [type, ...parameters] = range.split(";").map((part) => part.trim());
      const weights = parameters.filter((parameter) => /^q\s*=/.test(parameter));
      const quality = weights[0]?.replace(/^q\s*=\s*/, "") ?? "1";
      const accepted =
        weights.length <= 1 &&
        /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(quality) &&
        Number(quality) > 0;
      return { type, accepted };
    });
  // Any explicit JSON range keeps mixed clients on the JSON refusal path.
  if (
    ranges.some((range) => range.type === "text/html" && range.accepted) &&
    !ranges.some((range) => range.type === "application/json")
  ) {
    const url = new URL(c.req.url);
    return c.redirect(loginUrl(safeNext(url.pathname + url.search)), 302);
  }
  return c.json({ error: "unauthenticated" }, 401);
}

export async function jsonResponse(c: Ctx, value: unknown): Promise<Response> {
  const body = JSON.stringify(value);
  const etag = await etagFor(body);
  c.header("cache-control", "private, no-cache");
  c.header("etag", etag);
  if (c.req.header("if-none-match") === etag) return c.body(null, 304);
  return c.body(body, 200, { "content-type": "application/json; charset=UTF-8" });
}

export async function body(
  c: Pick<Ctx, "req">,
  opts?: { onMalformedForm?: "empty" | "throw" },
): Promise<Record<string, unknown>> {
  // Media types are case-insensitive (RFC 2045 §5.1): normalize before the
  // JSON check so `Application/Json` cannot smuggle a body past the trap.
  // Forms parse with all values preserved: duplicate keys arrive as arrays
  // (first-wins would let a filled duplicate hide behind an empty sibling).
  const ct = (c.req.header("content-type") ?? "").toLowerCase();
  if (ct.includes("application/json")) {
    const j = await c.req.json().catch(() => null);
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  }
  // A malformed multipart body rejects the parse (Node: TypeError from
  // Response.formData()): fail open to an empty body so the caller answers a
  // 4xx (401/422) instead of throwing into the alerting 500 path. The JSON
  // branch above already fails open to {}; the form branch must do the same,
  // before and independent of the session check. Callers that must never turn
  // a parse failure into an empty write (eventBody) opt into the throw and
  // map it to a 422 themselves.
  const parsed = c.req.parseBody({ all: true });
  if (opts?.onMalformedForm === "throw") return (await parsed) as Record<string, unknown>;
  return (await parsed.catch(() => ({}))) as Record<string, unknown>;
}
