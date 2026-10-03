import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { parseSigned, serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import app from "./app";
import { AUTH_STATUS_COOKIE } from "../src/auth-status";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { eventIcs, eventsIcsCollection, eventsRss } from "../src/events/feeds";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/events/${KEY}.ics`;
const SECRET = "test-session-secret-at-least-32-bytes-long";
const COOKIE = "__Host-two_session";

// Mounted app, fixture-backed Drizzle reads and the real signed-cookie boundary; no external I/O.
function fixture(status: "draft" | "published" = "draft") {
  const row: typeof events.$inferSelect = {
    id: 1,
    eventKey: KEY,
    title: "Private draft chess night",
    game: "Chess",
    description: "Moderator-only planning details",
    startsAt: new Date("2099-01-10T20:00:00Z"),
    endsAt: new Date("2099-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "Private voice channel",
    capacity: 10,
    status,
    rsvpOpen: true,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    icsSequence: 0n,
    syncRevision: 1,
    syncedRevision: 0,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:00:00Z"),
  };
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof row)[];
  const values = columns.map((key) =>
    row[key] instanceof Date ? (row[key] as Date).toISOString() : row[key],
  );
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "events"') && sql.includes('"event_key" =')) {
      return { rows: params[0] === KEY ? [values] : [] };
    }
    if (sql.includes('from "events"') && sql.includes('"status" in')) {
      const now = new Date(params[params.length - 1] as string);
      return {
        rows: params.slice(0, -1).includes(row.status) && row.endsAt >= now ? [values] : [],
      };
    }
    throw new Error(`Unexpected fixture query: ${sql}`);
  });
  const store = createMemorySessionStore();
  const env = {
    APP_URL,
    SESSION_SECRET: SECRET,
    SESSION_STORE: store,
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  return {
    row,
    store,
    async session(moderator = true, expired = false, signingSecret = SECRET) {
      const token = newSessionToken();
      const tokenHash = await hashToken(token);
      await store.create({
        tokenHash,
        userId: moderator ? "moderator" : "member",
        username: "fixture",
        avatar: null,
        member: true,
        moderator,
        expiresAt: new Date(Date.now() + (expired ? -1000 : 3600_000)),
      });
      const cookie = (
        await serializeSigned(COOKIE, token, signingSecret, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      return { cookie, tokenHash };
    },
    request(cookie?: string, etag?: string, path = PATH) {
      const headers = new Headers();
      if (cookie) headers.set("cookie", cookie);
      if (etag) headers.set("if-none-match", etag);
      return app.request(path, { headers }, env);
    },
  };
}

async function validator(body: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `"${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
}

async function replacement(
  response: Response,
  source: ReturnType<typeof fixture>,
  consumed: { cookie: string; tokenHash: string },
) {
  expect(await source.store.get(consumed.tokenHash)).toBeNull();
  const cookies = response.headers.getSetCookie();
  expect(cookies).toHaveLength(2);
  expect(cookies.filter((cookie) => cookie.startsWith(`${AUTH_STATUS_COOKIE}=`))).toHaveLength(1);
  // The companion liveness hash cannot replace the one-use login token.
  const replacements = cookies.filter((cookie) => cookie.startsWith(`${COOKIE}=`));
  expect(replacements).toHaveLength(1);
  const setCookie = replacements[0]!;
  for (const flag of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=7200"]) {
    expect(setCookie.split("; ")).toContain(flag);
  }
  expect(setCookie).not.toMatch(/(?:^|;\s*)Domain=/i);
  const cookie = setCookie.split(";")[0]!;
  expect(cookie).not.toBe(consumed.cookie);
  const token = (await parseSigned(cookie, SECRET, COOKIE))[COOKIE];
  expect(typeof token).toBe("string");
  const tokenHash = await hashToken(token as string);
  expect(await source.store.get(tokenHash)).toMatchObject({
    userId: "moderator",
    member: true,
    moderator: true,
  });
  return { cookie, tokenHash };
}

async function expectForbidden(response: Response) {
  expect(response.status).toBe(403);
  expect(response.headers.get("etag")).toBeNull();
  expect(response.headers.get("content-type")).not.toContain("text/calendar");
  expect(await response.text()).toBe("Forbidden");
}

describe("draft ICS rotated session delivery (fixture-only)", () => {
  it("follows replacements from 200 through 304 into another authorized request and refuses consumed cookies", async () => {
    const source = fixture();
    const original = await source.session();
    const body = eventIcs(source.row, APP_URL);
    const etag = await validator(body);
    const first = await source.request(original.cookie);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe(body);
    expect(first.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(first.headers.get("content-disposition")).toBe(`attachment; filename="${KEY}.ics"`);
    expect(first.headers.get("etag")).toBe(etag);
    expect(first.headers.get("cache-control")).toBe("max-age=300, private");
    const current = await replacement(first, source, original);
    await expectForbidden(await source.request(original.cookie, etag));
    const statusOnly = first.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${AUTH_STATUS_COOKIE}=`))!
      .split(";")[0]!;
    await expectForbidden(await source.request(statusOnly, etag));

    const unchanged = await source.request(current.cookie, etag);
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("etag")).toBe(etag);
    expect(unchanged.headers.get("cache-control")).toBe("max-age=300, private");
    const latest = await replacement(unchanged, source, current);
    await expectForbidden(await source.request(current.cookie, etag));

    const changed = await source.request(latest.cookie, '"nonmatching-validator"');
    expect(changed.status).toBe(200);
    expect(await changed.text()).toBe(body);
    expect(changed.headers.get("etag")).toBe(etag);
    expect(changed.headers.get("cache-control")).toBe("max-age=300, private");
    const next = await replacement(changed, source, latest);
    await expectForbidden(await source.request(latest.cookie, etag));
    expect(await source.store.get(next.tokenHash)).toMatchObject({ moderator: true });
  });

  it("delivers a signed replacement on 304 independently of the preceding 200", async () => {
    const source = fixture();
    const moderator = await source.session();
    const etag = await validator(eventIcs(source.row, APP_URL));
    const unchanged = await source.request(moderator.cookie, etag);
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("etag")).toBe(etag);
    expect(unchanged.headers.get("cache-control")).toBe("max-age=300, private");
    await replacement(unchanged, source, moderator);
  });

  it.each(["guest", "member", "expired moderator", "forged moderator"] as const)(
    "refuses a matching draft validator before 304 for a %s",
    async (actor) => {
      const source = fixture();
      const etag = await validator(eventIcs(source.row, APP_URL));
      const visitor =
        actor === "guest"
          ? undefined
          : await source.session(
              actor !== "member",
              actor === "expired moderator",
              actor === "forged moderator"
                ? "different-test-signing-secret-at-least-32-bytes"
                : SECRET,
            );
      const response = await source.request(visitor?.cookie, etag);
      await expectForbidden(response);
      if (actor !== "member") expect(response.headers.get("set-cookie")).toBeNull();
      if (actor === "forged moderator")
        expect(await source.store.get(visitor!.tokenHash)).toMatchObject({ moderator: true });
    },
  );

  it.each([PATH, "/events.ics", "/events.rss"])(
    "keeps public 200/304 sessionless with or without a signed cookie at %s",
    async (path) => {
      const source = fixture("published");
      const moderator = await source.session();
      const body =
        path === "/events.rss"
          ? eventsRss([source.row], APP_URL, source.row.updatedAt)
          : path === "/events.ics"
            ? eventsIcsCollection([source.row], APP_URL)
            : eventIcs(source.row, APP_URL);
      const etag = await validator(body);
      for (const cookie of [undefined, moderator.cookie]) {
        const first = await source.request(cookie, undefined, path);
        expect(first.status).toBe(200);
        expect(await first.text()).toBe(body);
        expect(first.headers.get("etag")).toBe(etag);
        expect(first.headers.get("content-type")).toBe(
          path === "/events.rss"
            ? "application/rss+xml; charset=utf-8"
            : "text/calendar; charset=utf-8",
        );
        expect(first.headers.get("cache-control")).toBe(
          `max-age=300, ${path === PATH ? "private" : "public"}`,
        );
        expect(first.headers.get("set-cookie")).toBeNull();
        const unchanged = await source.request(cookie, etag, path);
        expect(unchanged.status).toBe(304);
        expect(await unchanged.text()).toBe("");
        expect(unchanged.headers.get("etag")).toBe(etag);
        expect(unchanged.headers.get("cache-control")).toBe(first.headers.get("cache-control"));
        expect(unchanged.headers.get("set-cookie")).toBeNull();
        expect(await source.store.get(moderator.tokenHash)).toMatchObject({ moderator: true });
      }
    },
  );
});
