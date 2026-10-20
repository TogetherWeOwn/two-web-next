// Acceptance matrix: a session-rotation *error* is an outage, never a
// silent sign-out. When rotation throws for a reason that is not already
// classified as a database outage, the home page must render its
// session-unavailable treatment and a gated route must answer 503.
// A legitimately absent session (revoked, expired, or a rotation that
// cleanly reports "no live row to rotate") keeps the ordinary guest
// treatment: the Discord join CTA at home and the gated route's refusal.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken } from "../src/sessions";
import app from "./app";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";

const DRAFT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const DRAFT_PATH = `/events/${DRAFT_KEY}.ics`;
const EVENTS_PATH = "/events";
const DRAFT_TITLE = "Private draft chess night";
const PRIVATE_DETAIL = "private rotation detail";

// Hermetic draft-event read: the only query the gated ICS route needs
// before it checks the session is the single event row by key.
function draftDb() {
  const row: typeof events.$inferSelect = {
    id: 1,
    eventKey: DRAFT_KEY,
    title: DRAFT_TITLE,
    game: "Chess",
    description: "Moderator-only planning details",
    purpose: null,
    startsAt: new Date("2099-01-10T20:00:00Z"),
    endsAt: new Date("2099-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "Private voice channel",
    capacity: 10,
    status: "draft",
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
  return drizzle(async (sql, params) => {
    if (sql.includes('from "events"') && sql.includes('"event_key" =')) {
      return { rows: params[0] === DRAFT_KEY ? [values] : [] };
    }
    throw new Error(`Unexpected fixture query: ${sql}`);
  }) as unknown as Db;
}

async function fixture(actor: typeof MEMBER) {
  const store = createMemorySessionStore();
  const cookie = await cookieFor(store, actor);
  const bindings = { ...env, SESSION_STORE: store, ADMIN_DB: draftDb() } as Env;
  return { store, cookie, bindings };
}

// Hermetic calendar read: the /events collection renders from empty rows, so a
// guest render after rotate resolves false reaches 200 without a real database.
// Search analytics uses a transaction; the pg-proxy fixture has no real SQL.
function calendarDb() {
  const db = drizzle(async () => ({ rows: [] })) as unknown as Db;
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<void>) =>
      fn({
        execute: async () => {},
        insert: () => ({ values: async () => {} }),
      } as unknown as Db),
  });
  return db;
}

async function eventsFixture(actor: typeof MEMBER) {
  const store = createMemorySessionStore();
  const cookie = await cookieFor(store, actor);
  const bindings = { ...env, SESSION_STORE: store, ADMIN_DB: calendarDb() } as Env;
  return { store, cookie, bindings };
}

const pgError = (code: string) =>
  Object.assign(new Error(PRIVATE_DETAIL), { name: "PostgresError", code });
const refused = () => Object.assign(new Error(PRIVATE_DETAIL), { code: "ECONNREFUSED" });

// Rotation failures that are NOT classified database outages today.
const GENERIC_ROTATE_ERRORS: [string, () => Error][] = [
  ["a plain Error", () => new Error(PRIVATE_DETAIL)],
  ["a TypeError", () => new TypeError(PRIVATE_DETAIL)],
  ["a Postgres unique-violation (23505)", () => pgError("23505")],
  ["a Postgres permission failure (42501)", () => pgError("42501")],
];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("External HTTP is disabled"));
});
afterEach(() => vi.restoreAllMocks());

describe("rotation errors map to the outage treatment", () => {
  it.each(GENERIC_ROTATE_ERRORS)(
    "home renders session-unavailable (not silent guest) when rotate throws %s",
    async (_label, makeError) => {
      const { store, cookie, bindings } = await fixture(MEMBER);
      const rotate = vi.spyOn(store, "rotate").mockRejectedValue(makeError());
      const res = await app.request("/", { headers: { cookie } }, bindings);
      expect(rotate).toHaveBeenCalledOnce();
      expect(res.status).toBe(200);
      const body = await res.text();
      // The unavailable primary CTA replaces the guest Discord join CTA.
      expect(body).toContain('class="btn" href="/discord" data-testid="discord-join"');
      expect(body).not.toContain('data-testid="join"');
      expect(body).not.toContain(MEMBER.username);
      expect(body).not.toContain(PRIVATE_DETAIL);
      expect(res.headers.getSetCookie()).toEqual([]);
    },
  );

  it.each(GENERIC_ROTATE_ERRORS)(
    "a gated route answers 503 (not the guest refusal) when rotate throws %s",
    async (_label, makeError) => {
      const { store, cookie, bindings } = await fixture(MODERATOR);
      const rotate = vi.spyOn(store, "rotate").mockRejectedValue(makeError());
      const res = await app.request(DRAFT_PATH, { headers: { cookie } }, bindings);
      expect(rotate).toHaveBeenCalledOnce();
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).not.toContain(DRAFT_TITLE);
      expect(body).not.toContain(PRIVATE_DETAIL);
      expect(res.headers.getSetCookie()).toEqual([]);
    },
  );

  it.each(GENERIC_ROTATE_ERRORS)(
    "/events answers 503 (not a 500 or guest render) when rotate throws %s",
    async (_label, makeError) => {
      // The 503 returns before any calendar read, so the draft-only fixture
      // is sufficient: reaching the calendar reads would throw, not 503.
      const { store, cookie, bindings } = await fixture(MEMBER);
      const rotate = vi.spyOn(store, "rotate").mockRejectedValue(makeError());
      const res = await app.request(EVENTS_PATH, { headers: { cookie } }, bindings);
      expect(rotate).toHaveBeenCalledOnce();
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).not.toContain(PRIVATE_DETAIL);
      expect(body).not.toContain(MEMBER.username);
      expect(res.headers.getSetCookie()).toEqual([]);
    },
  );

  it("keeps the existing outage treatment for a classified database failure during rotation", async () => {
    const home = await fixture(MEMBER);
    vi.spyOn(home.store, "rotate").mockRejectedValue(refused());
    const homeRes = await app.request("/", { headers: { cookie: home.cookie } }, home.bindings);
    expect(homeRes.status).toBe(200);
    const homeBody = await homeRes.text();
    expect(homeBody).toContain('class="btn" href="/discord" data-testid="discord-join"');
    expect(homeBody).not.toContain('data-testid="join"');

    const gated = await fixture(MODERATOR);
    vi.spyOn(gated.store, "rotate").mockRejectedValue(refused());
    const gatedRes = await app.request(
      DRAFT_PATH,
      { headers: { cookie: gated.cookie } },
      gated.bindings,
    );
    expect(gatedRes.status).toBe(503);
    expect(await gatedRes.text()).not.toContain(DRAFT_TITLE);
  });
});

describe("legitimately absent sessions keep the guest treatment", () => {
  it.each(["revoked", "expired"] as const)(
    "home answers guest for a %s session, without attempting rotation",
    async (state) => {
      const store = createMemorySessionStore();
      const cookie = await cookieFor(store, MEMBER);
      if (state === "revoked") {
        const token = cookieToken(cookie);
        await store.revoke(await hashToken(token));
      } else {
        const token = cookieToken(cookie);
        await expireOnlyRow(store, await hashToken(token), MEMBER);
      }
      const rotate = vi.spyOn(store, "rotate");
      const bindings = { ...env, SESSION_STORE: store, ADMIN_DB: draftDb() } as Env;
      const res = await app.request("/", { headers: { cookie } }, bindings);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('data-testid="join"');
      expect(body).not.toContain(MEMBER.username);
      expect(rotate).not.toHaveBeenCalled();
      expect(res.headers.getSetCookie()).toEqual([]);
    },
  );

  it.each(["revoked", "expired"] as const)(
    "a gated route refuses a %s session as a guest, without attempting rotation",
    async (state) => {
      const store = createMemorySessionStore();
      const cookie = await cookieFor(store, MODERATOR);
      const token = cookieToken(cookie);
      if (state === "revoked") await store.revoke(await hashToken(token));
      else await expireOnlyRow(store, await hashToken(token), MODERATOR);
      const rotate = vi.spyOn(store, "rotate");
      const bindings = { ...env, SESSION_STORE: store, ADMIN_DB: draftDb() } as Env;
      const res = await app.request(DRAFT_PATH, { headers: { cookie } }, bindings);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain(DRAFT_TITLE);
      expect(rotate).not.toHaveBeenCalled();
      expect(res.headers.getSetCookie()).toEqual([]);
    },
  );

  it("a rotation that cleanly finds no live row stays guest, not an outage", async () => {
    // The row vanished between the session read and rotation (revoked or
    // expired mid-request): rotate resolves false instead of throwing.
    const home = await fixture(MEMBER);
    vi.spyOn(home.store, "rotate").mockResolvedValue(false);
    const homeRes = await app.request("/", { headers: { cookie: home.cookie } }, home.bindings);
    expect(homeRes.status).toBe(200);
    const homeBody = await homeRes.text();
    expect(homeBody).toContain('data-testid="join"');
    expect(homeBody).not.toContain(MEMBER.username);
    expect(homeRes.headers.getSetCookie()).toEqual([]);

    const gated = await fixture(MODERATOR);
    vi.spyOn(gated.store, "rotate").mockResolvedValue(false);
    const gatedRes = await app.request(
      DRAFT_PATH,
      { headers: { cookie: gated.cookie } },
      gated.bindings,
    );
    expect(gatedRes.status).toBe(403);
    expect(await gatedRes.text()).not.toContain(DRAFT_TITLE);
  });

  it("/events stays a 200 guest (not an outage) when rotation finds no live row", async () => {
    const { store, cookie, bindings } = await eventsFixture(MEMBER);
    const rotate = vi.spyOn(store, "rotate").mockResolvedValue(false);
    const res = await app.request(EVENTS_PATH, { headers: { cookie } }, bindings);
    expect(rotate).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(PRIVATE_DETAIL);
    expect(body).not.toContain(MEMBER.username);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("positive controls", () => {
  it("an active session still rotates and renders as the member at home", async () => {
    const { store, cookie, bindings } = await fixture(MEMBER);
    const rotate = vi.spyOn(store, "rotate");
    const res = await app.request("/", { headers: { cookie } }, bindings);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(MEMBER.username);
    expect(rotate).toHaveBeenCalledOnce();
    expect(res.headers.getSetCookie().join(";")).toContain("__Host-two_session=");
  });

  it("an active moderator still receives the gated draft download", async () => {
    const { cookie, bindings } = await fixture(MODERATOR);
    const res = await app.request(DRAFT_PATH, { headers: { cookie } }, bindings);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(DRAFT_TITLE);
  });
});

// cookieFor returns the `name=value` pair; the bearer is the signed value's
// token segment before the signature dot.
function cookieToken(cookie: string): string {
  const value = decodeURIComponent(cookie.split("=")[1]!);
  return value.split(".")[0]!;
}

// Recreate the cookie's row as already-expired: revoke the live row and
// insert an expired one under the same token hash.
async function expireOnlyRow(
  store: ReturnType<typeof createMemorySessionStore>,
  tokenHash: string,
  actor: typeof MEMBER,
): Promise<void> {
  await store.revoke(tokenHash);
  await store.create({
    tokenHash,
    userId: actor.userId,
    username: actor.username,
    avatar: null,
    member: actor.member,
    moderator: actor.moderator,
    expiresAt: new Date(Date.now() - 1000),
  });
}
