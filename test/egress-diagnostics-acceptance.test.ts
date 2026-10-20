// Acceptance-owned: the builder consumes this file unchanged.
//
// Operational contract (fixed messages/fields, no per-row identities):
// - Sitemap route: "Sitemap events read." with outcome no_binding,
//   acquire_failed, query_failed or ok; failures carry exception: ReadFailure,
//   success carries returned (including zero). Failed reads never claim zero
//   eligible events. The static-only 200/cache policy is unchanged.
// - Either SQL read at 1000 rows: "Event egress read reached capacity." with
//   { surface: sitemap|feed, limit: 1000, returned: 1000 }. This is evidence of
//   saturation, NOT proof of truncation or an omitted count; 999 is silent.
// - listFeed: "listFeed skipped unrenderable rows." with { skipped }, once
//   per nonzero omission. The existing sitemap skip warning stays singular.
//
// Breaks caught: silent/misclassified fallback, raw exception/row leakage,
// off-by-one/post-filter saturation, weakened scopes/caps, unstable tied
// membership, and silent/miscounted window omission. Real Hono handlers and
// Drizzle query generation run over a local pg-proxy transport. The fixture
// honors the emitted scope/order/LIMIT; it is not a PostgreSQL integration
// proof. No ICS builder is invoked: timestamp validation is a separate slice.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbFor } from "../src/admin/db";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { listFeed, sitemapEvents } from "../src/events/reads";
import { registerSeoLeaves } from "../src/seo-leaves";

vi.mock("../src/admin/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/admin/db")>();
  return { ...original, dbFor: vi.fn(original.dbFor) };
});

const NOW = new Date("2030-01-10T20:00:00Z");
const APP_URL = "https://next.example.test";
const READ = "Sitemap events read.";
const CAPACITY = "Event egress read reached capacity.";
const FEED_SKIP = "listFeed skipped unrenderable rows.";
const SITEMAP_SKIP = "sitemapEvents skipped unrenderable rows.";
const PRIVATE_TEXT = "private-member-egress-canary";
const DRIVER_TEXT = `select member_email from private_members; ${PRIVATE_TEXT}; postgres://fixture:egress-canary@db.invalid/fixture`;
const key = (id: number) => String(2000 - id).padStart(26, "0");
const ids = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

type Row = typeof events.$inferSelect;
type Query = { sql: string; params: unknown[] };
type Surface = "sitemap" | "feed";
let logs: unknown[][];

const row = (id: number, over: Partial<Row> = {}): Row => ({
  id,
  icsSequence: 1n,
  eventKey: key(id),
  title: `${PRIVATE_TEXT} title ${id}`,
  game: null,
  ...{ purpose: null },
  description: `${PRIVATE_TEXT} description`,
  startsAt: new Date(NOW.getTime() + id * 60_000),
  endsAt: new Date(NOW.getTime() + id * 60_000 + 3_600_000),
  timezone: "UTC",
  location: PRIVATE_TEXT,
  capacity: null,
  status: "published",
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  createdBy: PRIVATE_TEXT,
  rsvpOpen: true,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  createdAt: NOW,
  updatedAt: NOW,
  syncRevision: 1,
  syncedRevision: 0,
  ...over,
});

function sqlText(query: Query) {
  return query.sql.replaceAll('"events".', "").replaceAll('"', "");
}

function limitOf(query: Query): number | undefined {
  const match = /\blimit\s+(?:\$(\d+)|(\d+))/i.exec(sqlText(query));
  if (!match) return undefined;
  return match[2] === undefined ? Number(query.params[Number(match[1]) - 1]) : Number(match[2]);
}

// Model only the clauses this read owns, using the actual emitted SQL/binds.
// A finite PostgreSQL year 280000 becomes an invalid JS Date on decoding;
// it still passes the database's isfinite/upcoming predicate. Do not call
// toISOString on that fixture before the real mapper/guard sees it.
function fixture(input: Row[], failure?: { error: unknown }) {
  const seen: Query[] = [];
  const columns = Object.keys(getTableColumns(events)) as (keyof Row)[];
  const encode = (event: Row) =>
    columns.map((column) => {
      const value = event[column];
      return value instanceof Date
        ? Number.isFinite(value.getTime())
          ? value.toISOString()
          : "280000-01-01 00:00:00+00"
        : value;
    });
  const db = drizzle(async (sql, params) => {
    if (/^set\s/i.test(sql)) return { rows: [] };
    const query = { sql, params: [...params] };
    seen.push(query);
    if (failure) throw failure.error;
    const text = sqlText(query);
    if (!/^select\b/.test(text) || !/\bfrom events\b/.test(text))
      throw new Error("Unexpected local egress fixture query");
    const statusClause = /\bstatus\s+(?:=\s*(\$\d+)|in\s*\(([^)]+)\))/.exec(text);
    const statuses = [...(statusClause?.[1] ?? statusClause?.[2] ?? "").matchAll(/\$(\d+)/g)].map(
      (match) => params[Number(match[1]) - 1],
    );
    let output = input.filter((event) => statuses.includes(event.status));
    const upcoming = /\bends_at\s*>=\s*\$(\d+)/.exec(text);
    if (upcoming) {
      const now = new Date(String(params[Number(upcoming[1]) - 1])).getTime();
      output = output.filter(
        (event) => !Number.isFinite(event.endsAt.getTime()) || event.endsAt.getTime() >= now,
      );
    }
    const order = /\border by\s+(.+?)(?:\s+limit\s|$)/.exec(text)?.[1];
    if (order) {
      const terms = order.split(",").map((term) => term.trim());
      output = [...output].sort((a, b) => {
        for (const term of terms) {
          const value = (event: Row) => (term === "id asc" ? event.id : event.startsAt.getTime());
          const av = Number.isFinite(value(a)) ? value(a) : Infinity;
          const bv = Number.isFinite(value(b)) ? value(b) : Infinity;
          const delta = av - bv;
          if (delta && !Number.isNaN(delta)) return delta;
        }
        return 0;
      });
    }
    const limit = limitOf(query);
    if (limit !== undefined) output = output.slice(0, limit);
    return { rows: output.map(encode) };
  });
  Object.assign(db, {
    transaction: async (run: (tx: Db) => Promise<unknown>) => run(db as unknown as Db),
  });
  return { db: db as unknown as Db, seen };
}

function expectQuery(seen: Query[], surface: Surface, statuses = ["published"]) {
  expect(seen, "exactly one read, no sentinel/count query").toHaveLength(1);
  const query = seen[0]!;
  const text = sqlText(query);
  expect(limitOf(query), "keep the SQL cap at 1000, not 1001").toBe(1000);
  expect(text).toMatch(/\bwhere\b.*\bstatus\s+(?:=|in)/);
  expect(
    query.params.filter((value) =>
      ["published", "cancelled", "draft", "past"].includes(String(value)),
    ),
  ).toEqual(statuses);
  expect(text).toMatch(/order by starts_at asc/);
  if (surface === "sitemap") {
    expect(text, "sitemap remains status-only, including ended published rows").not.toMatch(
      /\bends_at\s*(?:>=|>|<|<=)/,
    );
  } else {
    expect(text).toMatch(/\bends_at\s*>=\s*\$\d+/);
    expect(query.params).toContain(NOW.toISOString());
    expect(text).toMatch(/isfinite\([^)]*starts_at\)/);
    expect(text).toMatch(/isfinite\([^)]*ends_at\)/);
    expect(text).toMatch(/order by starts_at asc, id asc/);
  }
}

async function read(surface: Surface, db: Db) {
  return surface === "sitemap"
    ? (await sitemapEvents(db)).map((entry) => entry.key)
    : (await listFeed(db, ["published", "cancelled"], NOW)).map((entry) => entry.eventKey);
}

function env(db?: Db): Env {
  return { APP_URL, ...(db ? { ADMIN_DB: db } : {}) } as unknown as Env;
}

function request(bindings: Env) {
  const app = new Hono<{ Bindings: Env }>();
  registerSeoLeaves(app);
  return app.request(`${APP_URL}/sitemap_index.xml`, {}, bindings);
}

async function expectSitemap(response: Response, eventKeys: string[] = []) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  expect(response.headers.get("content-type")).toBe("application/xml; charset=UTF-8");
  const xml = await response.text();
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  expect(locs).toEqual([
    `${APP_URL}/`,
    `${APP_URL}/join`,
    `${APP_URL}/events`,
    `${APP_URL}/about`,
    `${APP_URL}/faq`,
    `${APP_URL}/rules`,
    `${APP_URL}/privacy`,
    ...eventKeys.map((eventKey) => `${APP_URL}/e/${eventKey}`),
  ]);
  expect(xml).not.toContain(PRIVATE_TEXT);
  return xml;
}

function expectPrivateFree() {
  const serialized = JSON.stringify(logs);
  for (const value of [
    PRIVATE_TEXT,
    "postgres://",
    "egress-canary",
    "member_email",
    "private_members",
    "db.invalid",
  ]) {
    expect(serialized).not.toContain(value);
  }
}

beforeEach(async () => {
  logs = [];
  for (const level of ["warn", "error", "info", "log", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => logs.push(args));
  }
  const original = await vi.importActual<typeof import("../src/admin/db")>("../src/admin/db");
  vi.mocked(dbFor).mockReset().mockImplementation(original.dbFor);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Egress acceptance must stay local");
    }),
  );
});

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
    expectPrivateFree();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

describe("sitemap fallback outcomes without status/cache drift", () => {
  it("keeps static XML/cache identical for no binding, acquisition/query failure and empty success", async () => {
    const absent = await expectSitemap(await request(env()));
    vi.mocked(dbFor).mockRejectedValueOnce(new Error(DRIVER_TEXT));
    const acquisition = await expectSitemap(await request(env(fixture([]).db)));
    const broken = fixture([], { error: new Error(DRIVER_TEXT) });
    const query = await expectSitemap(await request(env(broken.db)));
    const empty = fixture([]);
    const success = await expectSitemap(await request(env(empty.db)));
    expect([acquisition, query, success]).toEqual([absent, absent, absent]);
    expectQuery(empty.seen, "sitemap");
    expect(broken.seen).toHaveLength(1);
  });

  it("classifies no configured binding instead of calling it an empty read", async () => {
    await expectSitemap(await request(env()));
    expect(logs).toEqual([[READ, { outcome: "no_binding" }]]);
  });

  it.each([
    ["Error", () => new Error(DRIVER_TEXT)],
    ["hostile error name", () => Object.assign(new Error(DRIVER_TEXT), { name: PRIVATE_TEXT })],
    ["non-Error rejection", () => ({ message: DRIVER_TEXT, name: PRIVATE_TEXT })],
  ])("classifies acquisition failure safely: %s", async (_name, error) => {
    vi.mocked(dbFor).mockRejectedValueOnce(error());
    await expectSitemap(await request(env(fixture([]).db)));
    expect(logs).toEqual([[READ, { outcome: "acquire_failed", exception: "ReadFailure" }]]);
  });

  it.each([
    ["Error", () => new Error(DRIVER_TEXT)],
    ["non-Error rejection", () => ({ message: DRIVER_TEXT, name: PRIVATE_TEXT })],
  ])("classifies query failure separately and safely: %s", async (_name, error) => {
    const broken = fixture([], { error: error() });
    await expectSitemap(await request(env(broken.db)));
    expect(broken.seen).toHaveLength(1);
    expect(logs).toEqual([[READ, { outcome: "query_failed", exception: "ReadFailure" }]]);
  });

  it("records a genuinely successful empty read, not fallback", async () => {
    const empty = fixture([]);
    await expectSitemap(await request(env(empty.db)));
    expectQuery(empty.seen, "sitemap");
    expect(logs).toEqual([[READ, { outcome: "ok", returned: 0 }]]);
  });

  it("healthy control preserves published entries and excludes hidden statuses", async () => {
    const healthy = fixture([
      row(2),
      row(1),
      row(3, { status: "draft" }),
      row(4, { status: "cancelled" }),
    ]);
    const xml = await expectSitemap(await request(env(healthy.db)), [key(1), key(2)]);
    expect(xml).toContain("<lastmod>2030-01-10T20:00:00.000Z</lastmod>");
    expectQuery(healthy.seen, "sitemap");
  });

  it("records successful nonempty reads without logging event data", async () => {
    const healthy = fixture([row(1), row(2)]);
    await expectSitemap(await request(env(healthy.db)), [key(1), key(2)]);
    expect(logs).toEqual([[READ, { outcome: "ok", returned: 2 }]]);
  });
});

describe.each(["sitemap", "feed"] as const)("%s read capacity", (surface) => {
  it.each([999, 1000])(
    "reports saturation only when the SQL read returns %i rows",
    async (count) => {
      const source = fixture(
        ids(count)
          .reverse()
          .map((id) => row(id)),
      );
      expect(await read(surface, source.db)).toEqual(ids(count).map(key));
      expectQuery(
        source.seen,
        surface,
        surface === "feed" ? ["published", "cancelled"] : ["published"],
      );
      expect(logs).toEqual(
        count === 999 ? [] : [[CAPACITY, { surface, limit: 1000, returned: 1000 }]],
      );
    },
  );

  it("retains exactly the first 1000 eligible rows without a sentinel query or omitted-count claim", async () => {
    const source = fixture(
      ids(1003)
        .reverse()
        .map((id) => row(id)),
    );
    expect(await read(surface, source.db)).toEqual(ids(1000).map(key));
    expectQuery(
      source.seen,
      surface,
      surface === "feed" ? ["published", "cancelled"] : ["published"],
    );
    expect(logs).toEqual([[CAPACITY, { surface, limit: 1000, returned: 1000 }]]);
  });
});

describe("unchanged egress scopes and deterministic sitemap membership", () => {
  const input = () => [
    row(6, { status: "past" }),
    row(5, { status: "draft" }),
    row(4, { status: "cancelled" }),
    row(3, { endsAt: new Date(NOW.getTime() - 1) }),
    row(2, { endsAt: NOW }),
    row(1),
  ];

  it.each([
    [["published"] as const, [key(1), key(2)]],
    [["published", "cancelled"] as const, [key(1), key(2), key(4)]],
  ])(
    "feed control keeps requested statuses %j and the inclusive upcoming boundary",
    async (statuses, expected) => {
      const source = fixture(input());
      expect(
        (await listFeed(source.db, [...statuses], NOW)).map((entry) => entry.eventKey),
      ).toEqual(expected);
      expectQuery(source.seen, "feed", [...statuses]);
      expect(logs).toEqual([]);
    },
  );

  it("sitemap control remains published-only and includes ended published rows", async () => {
    const source = fixture(input());
    expect(await read("sitemap", source.db)).toEqual([key(1), key(2), key(3)]);
    expectQuery(source.seen, "sitemap");
    expect(logs).toEqual([]);
  });

  it("emits starts_at then immutable id ordering in the actual sitemap query", async () => {
    const source = fixture([]);
    await sitemapEvents(source.db);
    expectQuery(source.seen, "sitemap");
    expect(sqlText(source.seen[0]!)).toMatch(/order by starts_at asc, id asc(?: limit .+)?$/);
  });

  it("keeps the same capped tied membership/order under two physical fixture layouts", async () => {
    const tied = ids(1002).map((id) => row(id, { startsAt: NOW }));
    const reversed = fixture([...tied].reverse());
    const rotated = fixture([...tied.slice(731), ...tied.slice(0, 731)]);
    const a = await read("sitemap", reversed.db);
    const b = await read("sitemap", rotated.db);
    expectQuery(reversed.seen, "sitemap");
    expectQuery(rotated.seen, "sitemap");
    for (const keys of [a, b]) {
      expect(keys).toHaveLength(1000);
      expect(
        keys.findIndex((eventKey, index) => eventKey !== key(index + 1)),
        "first slot violating ascending immutable-id membership (-1 means none)",
      ).toBe(-1);
    }
  });
});

describe("window omission diagnostics are independent of builder timestamp/SEQUENCE validation", () => {
  it("preserves good rows and counts each omitted feed row once, not each invalid field", async () => {
    const source = fixture([
      row(1, { startsAt: new Date(NaN) }),
      row(2),
      row(3, { endsAt: new Date(NaN) }),
      row(4, { startsAt: new Date(NaN), endsAt: new Date(NaN) }),
      row(5),
    ]);
    const output = await listFeed(source.db, ["published", "cancelled"], NOW);
    expect(output.map((entry) => entry.eventKey)).toEqual([key(2), key(5)]);
    const columns = getTableColumns(events);
    expect(output).toEqual(
      [row(2), row(5)].map((event) =>
        Object.fromEntries(Object.entries(event).filter(([key]) => Object.hasOwn(columns, key))),
      ),
    );
    expectQuery(source.seen, "feed", ["published", "cancelled"]);
    expect(logs).toEqual([[FEED_SKIP, { skipped: 3 }]]);
  });

  it("reports all omitted windows even when the feed becomes empty", async () => {
    const source = fixture([
      row(1, { startsAt: new Date(NaN) }),
      row(2, { endsAt: new Date(NaN) }),
    ]);
    expect(await read("feed", source.db)).toEqual([]);
    expect(logs).toEqual([[FEED_SKIP, { skipped: 2 }]]);
  });

  it("reports capacity before filtering windows, without inventing an omitted-row total", async () => {
    const source = fixture(
      ids(1000).map((id) => row(id, id <= 3 ? { endsAt: new Date(NaN) } : {})),
    );
    expect(await read("feed", source.db)).toEqual(ids(997).map((id) => key(id + 3)));
    expectQuery(source.seen, "feed", ["published", "cancelled"]);
    expect(logs).toHaveLength(2);
    expect(logs).toEqual(
      expect.arrayContaining([
        [CAPACITY, { surface: "feed", limit: 1000, returned: 1000 }],
        [FEED_SKIP, { skipped: 3 }],
      ]),
    );
  });

  it("does not duplicate the existing sitemap poison-row warning at capacity", async () => {
    const source = fixture(
      ids(1000).map((id) => row(id, id <= 2 ? { updatedAt: new Date(NaN) } : {})),
    );
    expect(await read("sitemap", source.db)).toEqual(ids(998).map((id) => key(id + 2)));
    expect(logs).toHaveLength(2);
    expect(logs).toEqual(
      expect.arrayContaining([
        [CAPACITY, { surface: "sitemap", limit: 1000, returned: 1000 }],
        [SITEMAP_SKIP, { skipped: 2 }],
      ]),
    );
  });

  it("keeps exactly one existing sitemap omission warning below capacity", async () => {
    const source = fixture([row(1), row(2, { updatedAt: new Date(NaN) }), row(3)]);
    expect(await read("sitemap", source.db)).toEqual([key(1), key(3)]);
    expect(logs).toEqual([[SITEMAP_SKIP, { skipped: 1 }]]);
  });

  it("healthy/empty feed controls never emit a skip warning", async () => {
    expect(await read("feed", fixture([]).db)).toEqual([]);
    const healthy = fixture([row(1), row(2)]);
    expect(await read("feed", healthy.db)).toEqual([key(1), key(2)]);
    expect(logs).toEqual([]);
  });

  it("does not silently consume SEQUENCE or updatedAt poison owned by the builders", async () => {
    const source = fixture([row(1, { icsSequence: -1n }), row(2, { updatedAt: new Date(NaN) })]);
    const output = await listFeed(source.db, ["published", "cancelled"], NOW);
    expect(output.map((entry) => entry.eventKey)).toEqual([key(1), key(2)]);
    expect(output[0]!.icsSequence).toBe(-1n);
    expect(output[1]!.updatedAt.getTime()).toBeNaN();
    expect(logs).toEqual([]);
  });

  it.each(["sitemap", "feed"] as const)(
    "%s query failure still rejects at the read API",
    async (surface) => {
      const source = fixture([], { error: new Error(DRIVER_TEXT) });
      await expect(read(surface, source.db)).rejects.toThrow();
      expect(source.seen).toHaveLength(1);
      expect(logs).toEqual([]);
    },
  );
});
