import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import { fetchKitEventDetailJson } from "../src/events/kit-detail-json-fetch";
import * as reads from "../src/events/reads";
import * as waitlist from "../src/events/waitlist";
import * as join from "../src/join/service";
import { createMemorySessionStore, SESSION_ROLE_RECHECK_SECONDS } from "../src/sessions";
import { fetchApp } from "./helpers/fetch-app";
import { calendarRow, KEY } from "./helpers/ics-wire-fixture";
import { cookieFor, env as baseEnv, MEMBER, MODERATOR, OUTSIDER } from "./helpers/member-data";

const IP = "192.0.2.45";
const REQUEST_ID = "0123456789abcdef-IAD";
const PATH = `/events/${KEY}`;
const DB = {} as Db;
const event: reads.PublicEvent = {
  ...calendarRow({ title: "Échecs ♟", capacity: 5, discordEventId: "fixture-mirror" }),
  goingCount: 3,
  goingOccupancy: 5,
};

type RequestOptions = {
  method?: "GET" | "HEAD";
  accept?: string;
  actor?: typeof MEMBER;
  key?: string;
  path?: string;
  stale?: boolean;
  validator?: string;
};

function fixture(db: Db | null = DB) {
  let now = Date.now();
  const store = createMemorySessionStore(() => now);
  const readSession = vi.spyOn(store, "get");
  const rotate = vi.spyOn(store, "rotate");
  const env = { ...baseEnv, ADMIN_DB: db, SESSION_STORE: store, THROTTLE_STORE: async () => null };

  async function compare(status: number, options: RequestOptions = {}) {
    const { method = "GET", accept, actor, key = KEY, stale = false, validator } = options;
    const path = options.path ?? `/events/${encodeURIComponent(key)}`;
    const headers = new Headers({ "cf-connecting-ip": IP, "cf-ray": REQUEST_ID });
    if (accept !== undefined) headers.set("accept", accept);
    if (validator !== undefined) headers.set("if-none-match", validator);
    async function request() {
      if (actor) {
        now = Date.now();
        headers.set("cookie", await cookieFor(store, actor));
        if (stale) now += SESSION_ROLE_RECHECK_SECONDS * 1000;
      }
      return new Request(new URL(path, env.APP_URL), { method, headers });
    }
    const discord = vi.mocked(fetch).mockClear();
    const admit = vi.mocked(join.checkJoinThrottle).mockClear();
    const mounted = await fetchApp(await request(), env);
    expect(admit).toHaveBeenCalledExactlyOnceWith(null, `events-read:${IP}`, 60);
    expect(discord).toHaveBeenCalledTimes(stale ? 1 : 0);
    admit.mockClear();
    discord.mockClear();
    const candidate = await fetchKitEventDetailJson(await request(), env, key, REQUEST_ID);
    expect(admit).toHaveBeenCalledExactlyOnceWith(null, `events-read:${IP}`, 60);
    if (!candidate) throw new Error("Candidate declined a matched event detail request");
    expect([mounted.status, candidate.status]).toEqual([status, status]);
    const bytes = Buffer.from(await candidate.arrayBuffer());
    expect(bytes).toEqual(Buffer.from(await mounted.arrayBuffer()));
    if (method === "HEAD" || status === 304) expect(bytes).toHaveLength(0);
    for (const name of [
      "cache-control",
      "content-type",
      "etag",
      "location",
      "retry-after",
      "vary",
      "x-robots-tag",
    ])
      expect(candidate.headers.get(name), name).toBe(mounted.headers.get(name));
    expect(mounted.headers.getSetCookie()).toEqual([]);
    expect(candidate.headers.getSetCookie()).toEqual([]);
    expect(discord).toHaveBeenCalledTimes(stale ? 1 : 0);
    expect(rotate).not.toHaveBeenCalled();
    return { headers: candidate.headers, bytes };
  }
  return { compare, readSession };
}

beforeEach(() => {
  vi.spyOn(join, "checkJoinThrottle").mockResolvedValue({ limited: false });
  vi.spyOn(reads, "getPublicEvent").mockResolvedValue(event);
  vi.spyOn(waitlist, "waitlistPosition").mockImplementation(async (_db, _id, viewer) =>
    viewer === MEMBER.userId ? 2 : null,
  );
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected outbound request")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each([
  [undefined, 401],
  ["*/*", 401],
  ["application/json", 401],
  ["text/html, application/json;q=0", 401],
  ["text/html;q=0", 401],
  ["text/html;q=0.5", 302],
  ["text/html;q=1;q=0.5", 401],
] as const)("matches guest Accept %s on GET and HEAD", async (accept, status) => {
  const path = `${PATH}?source=calendar`;
  const { compare, readSession } = fixture();
  for (const method of ["GET", "HEAD"] as const) {
    const result = await compare(status, { method, path, accept, validator: "*" });
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(result.headers.get("vary")).toBe("Cookie, Accept");
    expect(result.headers.get("location")).toBe(
      status === 302 ? `/join/discord?next=${encodeURIComponent(path)}` : null,
    );
    const body = status === 401 && method === "GET" ? '{"error":"unauthenticated"}' : "";
    expect(result.bytes.toString()).toBe(body);
  }
  expect(readSession).not.toHaveBeenCalled();
  expect(reads.getPublicEvent).not.toHaveBeenCalled();
  expect(waitlist.waitlistPosition).not.toHaveBeenCalled();
});

it("keeps the field allowlist, HEAD metadata and viewer-specific validators", async () => {
  const { compare } = fixture();
  const get = await compare(200, { actor: MEMBER, accept: "text/html" });
  const data = {
    event_key: KEY,
    title: "Échecs ♟",
    game: null,
    description: "Bring stims.",
    starts_at: "2026-07-15T18:00:00.000Z",
    ends_at: "2026-07-15T20:00:00.000Z",
    starts_at_local: "2026-07-15 19:00",
    ends_at_local: "2026-07-15 21:00",
    timezone: "Europe/London",
    location: "Voice: General",
    capacity: 5,
    going_count: 3,
    going_occupancy: 5,
    status: "published",
    rsvp_open: true,
    synced_to_discord: true,
    waitlist_position: 2,
  };
  expect(get.bytes.toString()).toBe(JSON.stringify({ data }));
  expect(get.headers.get("content-type")).toBe("application/json; charset=UTF-8");
  expect(get.headers.get("cache-control")).toBe("private, no-cache");
  expect(get.headers.get("vary")).toBe("Cookie, Accept");
  const etag = `"${createHash("sha1").update(get.bytes).digest("hex")}"`;
  expect(get.headers.get("etag")).toBe(etag);
  expect(reads.getPublicEvent).toHaveBeenLastCalledWith(DB, KEY);
  expect(waitlist.waitlistPosition).toHaveBeenLastCalledWith(DB, event.id, MEMBER.userId);

  const head = await compare(200, { method: "HEAD", actor: MEMBER });
  expect(head.headers.get("etag")).toBe(etag);
  expect(head.headers.get("content-type")).toBe(get.headers.get("content-type"));
  const validated = await compare(304, {
    method: "HEAD",
    actor: MEMBER,
    validator: `"old", W/${etag}`,
  });
  expect(validated.headers.get("etag")).toBe(etag);
  expect(validated.headers.get("content-type")).toBeNull();
  expect(validated.headers.get("cache-control")).toBe("private, no-cache");
  expect(validated.headers.get("vary")).toBe("Cookie, Accept");

  const other = await compare(200, { actor: OUTSIDER, validator: etag });
  expect(other.headers.get("etag")).not.toBe(etag);
  const otherData = { ...data, waitlist_position: null };
  expect(other.bytes.toString()).toBe(JSON.stringify({ data: otherData }));
  expect(waitlist.waitlistPosition).toHaveBeenLastCalledWith(DB, event.id, OUTSIDER.userId);
});

it("checks draft visibility ahead of conditional responses and viewer reads", async () => {
  vi.mocked(reads.getPublicEvent).mockResolvedValue({ ...event, status: "draft" });
  const { compare } = fixture();
  const moderator = await compare(200, { actor: MODERATOR });
  expect(moderator.bytes.toString()).toContain('"status":"draft"');
  expect(moderator.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  const validator = moderator.headers.get("etag")!;
  const conditional = await compare(304, { actor: MODERATOR, validator });
  expect(conditional.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  vi.mocked(waitlist.waitlistPosition).mockClear();
  const guest = await compare(401, { validator });
  expect(guest.bytes.toString()).toBe('{"error":"unauthenticated"}');
  expect(guest.headers.get("etag")).toBeNull();
  // A definitive guild response with no moderator role demotes the stale
  // session. Each side starts with its own signed bearer.
  vi.mocked(fetch).mockImplementation(async () => Response.json({ roles: [] }));
  for (const actor of [MEMBER, OUTSIDER, MODERATOR]) {
    const refused = await compare(403, { actor, validator, stale: actor === MODERATOR });
    expect(refused.bytes.toString()).toBe('{"error":"forbidden"}');
    expect(refused.headers.get("etag")).toBeNull();
    expect(refused.headers.get("cache-control")).toBe("private, no-store");
  }
  expect(waitlist.waitlistPosition).not.toHaveBeenCalled();
});

it("charges admission before canonicalization or session lookup", async () => {
  const { compare, readSession } = fixture();
  const key = KEY.toLowerCase();
  const request = { key, path: `/events/${key}?source=calendar`, actor: MEMBER };
  const alias = await compare(301, request);
  expect(alias.headers.get("location")).toBe(`${PATH}?source=calendar`);
  vi.mocked(join.checkJoinThrottle).mockResolvedValue({ limited: true, retryAfter: 42 });
  const limited = await compare(429, { ...request, accept: "application/json" });
  expect(limited.headers.get("retry-after")).toBe("42");
  expect(limited.headers.get("cache-control")).toBe("no-store, private");
  expect(limited.bytes.toString()).toContain(`"request_id":"${REQUEST_ID}"`);
  expect(readSession).not.toHaveBeenCalled();
  expect(reads.getPublicEvent).not.toHaveBeenCalled();
  expect(waitlist.waitlistPosition).not.toHaveBeenCalled();
});

it("preserves missing, invalid and cancelled responses ahead of viewer reads", async () => {
  const { compare } = fixture();
  const invalid = await compare(404, { key: `${KEY}/part`, actor: MEMBER });
  expect(invalid.bytes.toString()).toBe('{"error":"not_found"}');
  expect(reads.getPublicEvent).not.toHaveBeenCalled();
  vi.mocked(reads.getPublicEvent).mockResolvedValue(null);
  const missing = await compare(404, { actor: MEMBER, validator: "*" });
  expect(missing.bytes).toEqual(invalid.bytes);
  vi.mocked(reads.getPublicEvent).mockResolvedValue({ ...event, status: "cancelled" });
  const cancelled = await compare(410, { actor: MEMBER, validator: "*" });
  expect(cancelled.headers.get("etag")).toBeNull();
  const cancellation = {
    reason: "event_cancelled",
    message: "This event was cancelled.",
    event_key: KEY,
    status: "cancelled",
  };
  expect(cancelled.bytes.toString()).toBe(JSON.stringify(cancellation));
  expect(waitlist.waitlistPosition).not.toHaveBeenCalled();
});

it("keeps past events readable by a signed-in nonmember", async () => {
  vi.mocked(reads.getPublicEvent).mockResolvedValue({ ...event, status: "past", rsvpOpen: false });
  const past = await fixture().compare(200, { actor: OUTSIDER });
  expect(past.bytes.toString()).toContain('"status":"past","rsvp_open":false');
  expect(past.headers.get("x-robots-tag")).toBeNull();
});

it("preserves the inline database refusal and a classified read outage", async () => {
  const unbound = await fixture(null).compare(503, { actor: MEMBER });
  expect(unbound.bytes.toString()).toBe('{"error":"db_unavailable"}');
  expect(unbound.headers.get("retry-after")).toBe("60");
  expect(reads.getPublicEvent).not.toHaveBeenCalled();
  vi.mocked(reads.getPublicEvent).mockRejectedValue(
    Object.assign(new Error("fixture outage"), { code: "ECONNREFUSED" }),
  );
  const outage = await fixture().compare(503, { actor: MEMBER, accept: "application/json" });
  expect(outage.headers.get("cache-control")).toBe("no-store, private");
  expect(outage.headers.get("retry-after")).toBe("60");
  expect(outage.bytes.toString()).toContain(`"request_id":"${REQUEST_ID}"`);
  expect(waitlist.waitlistPosition).not.toHaveBeenCalled();
});

it.each(["POST", "PATCH"])("declines %s before admission or lookups", async (method) => {
  const request = new Request(new URL(PATH, baseEnv.APP_URL), { method });
  expect(await fetchKitEventDetailJson(request, baseEnv, KEY)).toBeNull();
  expect(join.checkJoinThrottle).not.toHaveBeenCalled();
  expect(reads.getPublicEvent).not.toHaveBeenCalled();
  expect(waitlist.waitlistPosition).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});
