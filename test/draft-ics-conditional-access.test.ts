import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { projectEventRowValues } from "./helpers/pg-proxy-event-projection";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/events/${KEY}.ics`;
const SECRET = "test-session-secret-at-least-32-bytes-long";
const COOKIE = "__Host-two_session";

// Real app, Drizzle reads, signed cookies and session rotation; no external I/O.
function fixture(status: "draft" | "published" = "draft", clock: () => number = Date.now) {
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
  // Positional pg-proxy mapping follows the emitted projection: the keyed
  // read selects the stored row, the collection read its egress fields.
  const values = (sql: string, params: unknown[]) => projectEventRowValues(sql, params, row);
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "events"') && sql.includes('"event_key" =')) {
      return { rows: params[0] === KEY ? [values(sql, params)] : [] };
    }
    if (sql.includes('from "events"') && sql.includes('"status" in')) {
      const cutoff = params.find(
        (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value),
      );
      const now = new Date(cutoff as string);
      return {
        rows: params.includes(row.status) && row.endsAt >= now ? [values(sql, params)] : [],
      };
    }
    throw new Error(`Unexpected fixture query: ${sql}`);
  });
  const store = createMemorySessionStore(clock);
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

async function draftValidator(source: ReturnType<typeof fixture>, cookie: string): Promise<string> {
  const response = await source.request(cookie);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
  const body = await response.text();
  expect(body).toContain("BEGIN:VCALENDAR");
  expect(body).toContain(source.row.title);
  expect(body).toContain(source.row.description);
  const etag = response.headers.get("etag");
  expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
  return etag!;
}

async function expectForbidden(response: Response, row: typeof events.$inferSelect) {
  expect(response.status).toBe(403);
  expect(response.headers.get("etag")).toBeNull();
  expect(response.headers.get("content-type")).not.toContain("text/calendar");
  const body = await response.text();
  expect(body).toBe("Forbidden");
  expect(body).not.toContain("BEGIN:VCALENDAR");
  expect(body).not.toContain(row.title);
  expect(body).not.toContain(row.description);
}

describe("draft ICS conditional authorization (fixture-only)", () => {
  it.each(["guest", "member", "expired moderator", "forged moderator"] as const)(
    "refuses a moderator's matching validator for a %s",
    async (actor) => {
      const source = fixture();
      const moderator = await source.session();
      const etag = await draftValidator(source, moderator.cookie);
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
      if (actor === "member")
        expect(await source.store.get(visitor!.tokenHash)).toMatchObject({
          moderator: false,
          member: true,
        });
      // A forged signature must fail even though its token names a live moderator.
      if (actor === "forged moderator")
        expect(await source.store.get(visitor!.tokenHash)).toMatchObject({ moderator: true });
      const response = await source.request(visitor?.cookie, etag);
      await expectForbidden(response, source.row);
      if (actor === "expired moderator")
        expect(await source.store.get(visitor!.tokenHash)).toBeNull();
      if (actor !== "member") expect(response.headers.get("set-cookie")).toBeNull();
      if (actor === "forged moderator")
        expect(await source.store.get(visitor!.tokenHash)).toMatchObject({ moderator: true });
    },
  );

  it("returns 304 during predecessor grace and refuses replay at its deadline", async () => {
    let now = Date.now();
    const source = fixture("draft", () => now);
    const moderator = await source.session();
    const first = await source.request(moderator.cookie);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(first.headers.get("content-disposition")).toBe(`attachment; filename="${KEY}.ics"`);
    expect(first.headers.get("cache-control")).toBe("max-age=300, private");
    const body = await first.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain(source.row.title);
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    // Keep independent logins for the conditional authorization boundary;
    // replacement-cookie delivery is covered by the companion suite.
    expect(await source.store.get(moderator.tokenHash)).toMatchObject({ moderator: true });
    expect(await source.store.statusHash(moderator.tokenHash)).toBeNull();
    const current = await source.session();
    expect(current.cookie).not.toBe(moderator.cookie);
    expect(await source.store.get(current.tokenHash)).toMatchObject({
      userId: "moderator",
      moderator: true,
    });

    const unchanged = await source.request(current.cookie, etag!);
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    expect(unchanged.headers.get("etag")).toBe(etag);
    expect(unchanged.headers.get("cache-control")).toBe("max-age=300, private");
    expect(await source.store.get(current.tokenHash)).toMatchObject({ moderator: true });
    for (const predecessor of [moderator, current]) {
      const replay = await source.request(predecessor.cookie, etag!);
      expect(replay.status).toBe(304);
      expect(await replay.text()).toBe("");
      expect(replay.headers.get("etag")).toBe(etag);
      expect(replay.headers.get("set-cookie")).toBeNull();
    }
    now += 10_000;
    expect(await source.store.get(moderator.tokenHash)).toBeNull();
    expect(await source.store.get(current.tokenHash)).toBeNull();
    await expectForbidden(await source.request(moderator.cookie, etag!), source.row);
    await expectForbidden(await source.request(current.cookie, etag!), source.row);

    const latest = await source.session();
    const changedValidator = await source.request(latest.cookie, '"nonmatching-validator"');
    expect(changedValidator.status).toBe(200);
    expect(await changedValidator.text()).toBe(body);
    expect(changedValidator.headers.get("etag")).toBe(etag);
  });

  it.each([PATH, "/events.ics"])(
    "keeps published ICS conditional responses working without a session at %s",
    async (path) => {
      const source = fixture("published");
      const first = await source.request(undefined, undefined, path);
      expect(first.status).toBe(200);
      expect(first.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
      expect(first.headers.get("set-cookie")).toBeNull();
      const body = await first.text();
      expect(body).toContain("BEGIN:VCALENDAR");
      expect(body).toContain(source.row.title);
      const etag = first.headers.get("etag");
      expect(etag).toMatch(/^"[a-f0-9]{64}"$/);

      const unchanged = await source.request(undefined, etag!, path);
      expect(unchanged.status).toBe(304);
      expect(await unchanged.text()).toBe("");
      expect(unchanged.headers.get("etag")).toBe(etag);
      expect(unchanged.headers.get("cache-control")).toBe(first.headers.get("cache-control"));
      expect(unchanged.headers.get("set-cookie")).toBeNull();
    },
  );
});
