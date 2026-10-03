// TOG-11464: `listFeed` ordered by `startsAt` only, so tied events fell
// back to physical row order and subscription bytes/ETags could shift without
// a content change. It now orders by `(startsAt, id)` like `listUpcoming`
// already does (TOG-12440). Equal-start seed asserts stable id order plus
// byte/ETag stability across a heap rewrite, with projection, visibility and
// (uncapped) shape unchanged. Isolated test DB only.
import { createHash } from "node:crypto";
import { asc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { listFeed } from "../src/events/reads";
import { registerEventRoutes } from "../src/events/routes";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const raw = process.env.DATABASE_URL;
const url = raw ? testDatabaseUrl(raw).href : undefined;

const NOW = new Date("2030-01-10T20:00:00Z");
const TIED_ENDS = new Date("2030-01-10T22:00:00Z");
// 26-char zero-padded ids: long enough for the /e/:key KEY_RE gate, and the
// reversed key order keeps keys/titles opposed to id order so only the
// (startsAt, id) tiebreak can produce ascending ids.
const key = (id: number) => String(1000 - id).padStart(26, "0");
type EventRow = typeof events.$inferSelect;
const row = (
  id: number,
  over: Partial<Pick<EventRow, "startsAt" | "endsAt" | "status">> = {},
): Partial<EventRow> & { eventKey: string; title: string; startsAt: Date; endsAt: Date } => ({
  id,
  eventKey: key(id),
  title: `Event ${1000 - id}`,
  startsAt: NOW,
  endsAt: TIED_ENDS,
  status: "published",
  updatedAt: NOW,
  ...over,
});
const ids = (rows: Pick<EventRow, "id">[]) => rows.map((event) => event.id);
const etagFor = (body: string) => `"${createHash("sha256").update(body).digest("hex")}"`;
const feedKeys = (path: string, body: string) =>
  path.endsWith(".ics")
    ? [...body.matchAll(/\r\nUID:([^@]+)@/g)].map((match) => match[1])
    : [...body.matchAll(/<guid isPermaLink="true">[^<]+\/e\/([^<]+)<\/guid>/g)].map(
        (match) => match[1],
      );

it("requests an explicit total order in SQL, with starts_at before the immutable unique id", async () => {
  const queries: string[] = [];
  const db = drizzle(async (query) => {
    queries.push(query);
    return { rows: [] };
  }) as unknown as Db;
  await listFeed(db, ["published"], NOW);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toMatch(/order by "events"\."starts_at" asc, "events"\."id" asc$/);
});

describe.skipIf(!url)("equal-start subscription feeds (isolated test DB)", () => {
  let fixture: MemberDataFixture;
  let env: Env;
  const readSession = vi.fn(async () => null);
  const app = new Hono<{ Bindings: Env }>();
  registerEventRoutes(app, readSession, readSession);
  const request = (path: string, validator?: string) =>
    app.request(
      path,
      { headers: validator === undefined ? {} : { "if-none-match": validator } },
      env,
    );

  beforeAll(async () => {
    fixture = await createMemberDataFixture(url!, { max: 2 });
    // CLUSTER rewrites only this schema's heap; it does not edit event values.
    await fixture.client`create index feed_order_ascending on events (id asc)`;
    await fixture.client`create index feed_order_descending on events (id desc)`;
    env = {
      APP_URL: "https://next.example.test",
      DISCORD_CLIENT_ID: "fixture",
      DISCORD_CLIENT_SECRET: "fixture",
      DISCORD_GUILD_ID: "fixture",
      DISCORD_INVITE_URL: "https://discord.gg/fixture",
      DISCORD_BOT_TOKEN: "fixture",
      SESSION_SECRET: "fixture",
      ADMIN_DB: fixture.db,
    } as unknown as Env;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    readSession.mockClear();
    await fixture.reset();
    // Non-key insertion order, and keys/titles intentionally oppose id order.
    await fixture.db.insert(events).values([
      row(30),
      row(10),
      row(20),
      row(99, { startsAt: new Date("2030-01-09T20:00:00Z") }),
      row(1, {
        startsAt: new Date("2030-01-11T20:00:00Z"),
        endsAt: new Date("2030-01-11T22:00:00Z"),
      }),
      row(5, { status: "cancelled" }),
      row(6, { status: "draft" }),
      row(7, { endsAt: new Date(NOW.getTime() - 1) }),
      row(8, { status: "past" }),
      row(9, { endsAt: NOW }),
    ]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("orders out-of-order ties by id, keeps chronology primary, and preserves eligibility", async () => {
    expect(ids(await listFeed(fixture.db, ["published"], NOW))).toEqual([99, 9, 10, 20, 30, 1]);
    expect(ids(await listFeed(fixture.db, ["published", "cancelled"], NOW))).toEqual([
      99, 5, 9, 10, 20, 30, 1,
    ]);
  });

  it.each(["/events.ics", "/events.rss"])(
    "keeps %s bytes, ETags and conditional responses stable across heap reordering",
    async (path) => {
      await fixture.client`cluster events using feed_order_descending`;
      const storedBefore = await fixture.db.select().from(events).orderBy(asc(events.id));
      const heapBefore = await fixture.client`select id from events order by ctid`;
      const before = await request(path);
      const beforeBody = await before.text();
      expect(before.status).toBe(200);
      const expectedIds = path.endsWith(".ics")
        ? [99, 5, 9, 10, 20, 30, 1]
        : [99, 9, 10, 20, 30, 1];
      expect.soft(feedKeys(path, beforeBody)).toEqual(expectedIds.map((id) => key(id)));
      expect(before.headers.get("etag")).toBe(etagFor(beforeBody));

      await fixture.client`cluster events using feed_order_ascending`;
      const heapAfter = await fixture.client`select id from events order by ctid`;
      expect(heapAfter).not.toEqual(heapBefore);
      expect(await fixture.db.select().from(events).orderBy(asc(events.id))).toEqual(storedBefore);
      const after = await request(path);
      const afterBody = await after.text();
      expect(after.status).toBe(200);
      expect.soft(afterBody === beforeBody, "feed bytes unchanged after heap rewrite").toBe(true);
      expect.soft(after.headers.get("etag")).toBe(before.headers.get("etag"));
      expect(after.headers.get("etag")).toBe(etagFor(afterBody));
      expect(after.headers.get("content-type")).toBe(
        path.endsWith(".ics")
          ? "text/calendar; charset=utf-8"
          : "application/rss+xml; charset=utf-8",
      );
      expect(after.headers.get("cache-control")).toBe("max-age=300, public");
      expect(after.headers.get("set-cookie")).toBeNull();

      const conditional = await request(path, `"other", W/${before.headers.get("etag")}`);
      expect(conditional.status).toBe(304);
      expect(await conditional.text()).toBe("");
      expect(conditional.headers.get("etag")).toBe(before.headers.get("etag"));
      expect(conditional.headers.get("cache-control")).toBe("max-age=300, public");
      expect(conditional.headers.get("set-cookie")).toBeNull();
      expect(readSession).not.toHaveBeenCalled();
    },
  );

  it("preserves the uncapped subscription collection beyond the JSON paging maximum", async () => {
    await fixture.reset();
    const tiedIds = Array.from({ length: 101 }, (_, index) => index + 10);
    await fixture.db.insert(events).values([
      ...[...tiedIds].reverse().map((id) => row(id)),
      row(200, { startsAt: new Date("2030-01-09T20:00:00Z") }),
      row(1, {
        startsAt: new Date("2030-01-11T20:00:00Z"),
        endsAt: new Date("2030-01-11T22:00:00Z"),
      }),
    ]);
    const expected = [200, ...tiedIds, 1];
    expect(ids(await listFeed(fixture.db, ["published"], NOW))).toEqual(expected);
    for (const path of ["/events.ics", "/events.rss"]) {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(feedKeys(path, await response.text())).toEqual(expected.map((id) => key(id)));
    }
  });
});
