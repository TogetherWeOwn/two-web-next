// route-inventory: GET /hotzones
// route-inventory: GET /hotzones/:signal
// Acceptance (test files only) for the gatherings listed behind the hotzone
// count.
//
// Contract lock-in (Test Author). The Builder implements against this file;
// nothing here may change to make an implementation pass.
//
// Today the hotzone index and the joins signal page render "{eventCount}
// scheduled gatherings" as plain text (src/hotzones/pages.tsx, Kit
// web/src/routes/hotzones/+page.svelte and [signal]/+page.svelte); no `/e/`
// link exists in either hotzone renderer. The count query lives in
// src/hotzones/aggregates.ts loadJoinsGrid: published events whose startsAt
// falls in the season window. This file pins the bounded list behind that
// count:
//
// - WHERE: the index (`/hotzones`) and the joins signal view
//   (`/hotzones/joins`) list the gatherings — the two pages that render the
//   count. Voice/games have no count, so they render as today (no list).
// - WHAT: each item carries the title, a when (`<time datetime>` with the
//   startsAt ISO instant), and an `/e/:key` link. Shared testids on Hono and
//   Kit: `hotzone-gatherings` on the section, `hotzone-gathering-link` on
//   each anchor. Order is startsAt ascending (soonest first, matching the
//   calendar's `events_status_starts_at_idx` question); ties break by
//   event_key ascending.
// - BOUND: at most HOTZONE_GATHERINGS_LIMIT = 5 items. More than that renders
//   exactly `showing 5 of M scheduled gatherings`; M is the full count. Five
//   or fewer renders no truncation copy. Zero renders as today: the count
//   line stays, no section, no copy.
// - FILTER: the same published-only, in-window filter as the count.
//   Draft/cancelled rows never list; count and list always agree.
// - READS: one bounded extra read at most — no per-row queries. Proved by
//   counting events-table SELECTs through the postgres `debug` hook at two
//   collection sizes (the test/event-bounded-reads.test.ts pattern).
// - SAFETY: hostile titles escape; anonymous GETs keep working; cache policy
//   is unchanged (200s stay `public, max-age=300` + `vary: Cookie`, the 400
//   season grammar stays `no-store, private`).
//
// How this fails before the Builder lands: every list/truncation/filter/
// escape/order/Kit-data assertion fails — Hono renders no section, the Kit
// loader returns no gatherings, and the svelte shells carry no testids. The
// guards (zero-as-today, voice/games unchanged, cache headers, read bound)
// already pass and must keep passing.
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "./app";
import { boardViewLogs, events } from "../src/db/admin-schema";
import { adminSchema, schema, type Db } from "../src/db/index";
import type { Env } from "../src/env";
import { loadHotzoneSignalData, loadHotzonesIndexData } from "../src/kit-hotzones";
import { createMemorySessionStore } from "../src/sessions";
import { testDatabaseUrl } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shell = (path: string) => resolve(root, path);

// Pinned contract values (see the header): the Builder renders exactly these.
const GATHERINGS_TESTID = "hotzone-gatherings";
const GATHERING_LINK_TESTID = "hotzone-gathering-link";
const GATHERINGS_LIMIT = 5;
const showingCopy = (shown: number, total: number) =>
  `showing ${shown} of ${total} scheduled gatherings`;

// Synthetic probe identities: no real member data, never a live lookup.
const PROBE_PREFIX = "zxq-gather-list";

// ULID-shaped keys (Crockford alphabet: no I, L, O or U), 26 chars.
const eventKey = (n: number) => `01J9Z3NDEKTSV4RRFFQ69G5FA${String(n).padStart(2, "0")}`;

// The Kit loaders expose the list under `gatherings`. The key does not exist
// on main, so the tests read it through a cast: undefined there (RED), the
// pinned rows after the Builder lands. No static import of a new export.
type GatheringsCarrier = {
  gatherings?: Array<{ eventKey: string; title: string; startsAt: Date }>;
};
const gatheringsOf = (data: unknown): GatheringsCarrier["gatherings"] =>
  (data as unknown as GatheringsCarrier).gatherings;

const countLinks = (html: string): number =>
  html.match(new RegExp(`data-testid="${GATHERING_LINK_TESTID}"`, "g"))?.length ?? 0;

const countLine = (html: string): number[] =>
  [...html.matchAll(/(\d+) scheduled gatherings/g)].map((m) => Number(m[1]));

describe("hotzone gatherings list: zero and cache behavior (no DB)", () => {
  it("renders zero gatherings as today: count line, no section, no copy", async () => {
    const res = await app.request("/hotzones", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("0 scheduled gatherings");
    expect(html).not.toContain(GATHERINGS_TESTID);
    expect(html).not.toContain("/e/");
    expect(html).not.toContain("showing ");
  });

  it("renders the joins signal with no section at zero", async () => {
    const res = await app.request("/hotzones/joins", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("0 scheduled gatherings");
    expect(html).not.toContain(GATHERINGS_TESTID);
  });

  it.each(["voice", "games"])("renders %s with no gathering list", async (signal) => {
    const res = await app.request(`/hotzones/${signal}`, {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(GATHERINGS_TESTID);
    expect(html).not.toContain("/e/");
  });

  it("keeps the public cache policy on the index and the joins view", async () => {
    for (const path of ["/hotzones", "/hotzones/joins"]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=300");
      expect(res.headers.get("vary")).toContain("Cookie");
    }
  });

  it("keeps no-store/private on the season-grammar 400", async () => {
    for (const path of ["/hotzones?season=nope", "/hotzones/joins?season=nope"]) {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
    }
  });

  it("keeps no-store on the Kit bad-season throw", async () => {
    const headers: Record<string, string>[] = [];
    await expect(
      loadHotzonesIndexData({
        env,
        seasonParam: "nope",
        setHeaders: (h) => void headers.push(h),
        dbForFn: async () => null,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(headers).toEqual([{ "cache-control": "private, no-store" }]);
  });
});

describe("hotzone gatherings list: Kit shells carry the shared contract (no DB)", () => {
  it("renders the shared testids and truncation copy on the index shell", () => {
    const path = shell("web/src/routes/hotzones/+page.svelte");
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source).toContain(GATHERINGS_TESTID);
    expect(source).toContain(GATHERING_LINK_TESTID);
    expect(source).toContain("<time");
    expect(source).toContain("showing ");
  });

  it("renders the shared testids and truncation copy on the signal shell", () => {
    const path = shell("web/src/routes/hotzones/[signal]/+page.svelte");
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source).toContain(GATHERINGS_TESTID);
    expect(source).toContain(GATHERING_LINK_TESTID);
    expect(source).toContain("<time");
    expect(source).toContain("showing ");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("hotzone gatherings list (agent-testdb)", () => {
  // Owned disposable schema with the postgres-js `debug` hook wired as the
  // round-trip counter (the test/event-bounded-reads.test.ts pattern): one
  // entry per statement the driver sends, so filtering for the events table
  // proves the single-extra-read bound at the wire level.
  let admin: ReturnType<typeof postgres>;
  let client: ReturnType<typeof postgres>;
  let db: Db;
  let schemaName: string;
  let created = false;
  let roundTrips: string[] = [];
  let live: Env;

  beforeAll(async () => {
    const url = testDatabaseUrl(process.env.DATABASE_URL!);
    schemaName = `w15_${randomUUID().replaceAll("-", "")}`;
    const base = {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      onnotice: () => {},
    };
    admin = postgres(url.href, base);
    client = postgres(url.href, {
      ...base,
      connection: { search_path: schemaName },
      debug: (_id: unknown, query: string) => void roundTrips.push(query),
    });
    db = drizzle(client, { schema: { ...schema, ...adminSchema } });
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url).href),
    });
    for (const migration of migrations) {
      await client.begin(async (tx) => {
        for (const statement of migration.sql) {
          if (statement.trim())
            await tx.unsafe(statement.replaceAll('"public".', `"${schemaName}".`));
        }
      });
    }
    const store = createMemorySessionStore();
    live = {
      ...env,
      get ADMIN_DB() {
        return db;
      },
      SESSION_STORE: store,
      DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
    } as unknown as Env;
  });

  afterAll(async () => {
    try {
      await client?.end();
      if (created) await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    } finally {
      await admin?.end();
    }
  });

  let keySeq = 0;

  const reset = async () => {
    await db.delete(boardViewLogs);
    await db.delete(events);
    keySeq = 0;
    roundTrips = [];
  };

  const seedPublished = async (
    n: number,
    opts: { tag?: string; month?: string; hourStep?: number } = {},
  ): Promise<{ key: string; title: string; startsAt: Date }[]> => {
    const tag = opts.tag ?? "sept";
    const month = opts.month ?? "2026-09-07";
    const out: { key: string; title: string; startsAt: Date }[] = [];
    for (let i = 0; i < n; i++) {
      const startsAt = new Date(
        `${month}T${String(10 + i * (opts.hourStep ?? 1)).padStart(2, "0")}:00:00Z`,
      );
      const row = {
        eventKey: eventKey(keySeq++),
        title: `${PROBE_PREFIX} ${tag} ${i}`,
        status: "published",
        startsAt,
        endsAt: new Date(startsAt.getTime() + 2 * 3600000),
      };
      await db.insert(events).values(row);
      out.push({ key: row.eventKey, title: row.title, startsAt });
    }
    return out;
  };

  const eventsSelects = () =>
    roundTrips.filter((q) => /^\s*select\b/i.test(q) && /from\s+"events"/i.test(q));

  it("lists the gatherings behind the count on the index", async () => {
    await reset();
    const seeded = await seedPublished(3);
    const res = await app.request("/hotzones?season=2026-09", {}, live);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`data-testid="${GATHERINGS_TESTID}"`);
    expect(countLinks(html)).toBe(3);
    for (const row of seeded) {
      expect(html).toContain(row.title);
      expect(html).toContain(`href="/e/${row.key}"`);
      expect(html).toContain(`<time datetime="${row.startsAt.toISOString()}"`);
    }
  });

  it("lists the same gatherings on the joins signal view", async () => {
    await reset();
    const seeded = await seedPublished(3);
    const res = await app.request("/hotzones/joins?season=2026-09", {}, live);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`data-testid="${GATHERINGS_TESTID}"`);
    expect(countLinks(html)).toBe(3);
    for (const row of seeded) {
      expect(html).toContain(`href="/e/${row.key}"`);
      expect(html).toContain(`<time datetime="${row.startsAt.toISOString()}"`);
    }
  });

  it("truncates at the pinned limit with showing-N-of-M copy on the index", async () => {
    await reset();
    const seeded = await seedPublished(7);
    const res = await app.request("/hotzones?season=2026-09", {}, live);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(countLinks(html)).toBe(GATHERINGS_LIMIT);
    expect(html).toContain(showingCopy(GATHERINGS_LIMIT, seeded.length));
    // Soonest first: the five earliest list, the two latest do not.
    for (const row of seeded.slice(0, GATHERINGS_LIMIT)) {
      expect(html).toContain(`href="/e/${row.key}"`);
    }
    for (const row of seeded.slice(GATHERINGS_LIMIT)) {
      expect(html).not.toContain(`href="/e/${row.key}"`);
    }
  });

  it("truncates with the same copy on the joins signal view", async () => {
    await reset();
    await seedPublished(7);
    const res = await app.request("/hotzones/joins?season=2026-09", {}, live);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(countLinks(html)).toBe(GATHERINGS_LIMIT);
    expect(html).toContain(showingCopy(GATHERINGS_LIMIT, 7));
  });

  it("renders no truncation copy when the list fits", async () => {
    await reset();
    await seedPublished(3);
    for (const path of ["/hotzones?season=2026-09", "/hotzones/joins?season=2026-09"]) {
      const html = await (await app.request(path, {}, live)).text();
      expect(html).not.toContain("showing ");
    }
  });

  it("keeps count and list in agreement", async () => {
    await reset();
    await seedPublished(3);
    const html = await (await app.request("/hotzones?season=2026-09", {}, live)).text();
    expect(countLine(html)).toEqual([3]);
    expect(countLinks(html)).toBe(3);
  });

  it("keeps the truncated count and the M in agreement", async () => {
    await reset();
    await seedPublished(7);
    const html = await (await app.request("/hotzones?season=2026-09", {}, live)).text();
    expect(countLine(html)).toEqual([7, 7]);
    expect(html).toContain(showingCopy(5, 7));
  });

  it("never lists draft or cancelled gatherings", async () => {
    await reset();
    await seedPublished(2);
    const startsAt = new Date("2026-09-08T10:00:00Z");
    await db.insert(events).values({
      eventKey: eventKey(90),
      title: `${PROBE_PREFIX} draft`,
      status: "draft",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3600000),
    });
    await db.insert(events).values({
      eventKey: eventKey(91),
      title: `${PROBE_PREFIX} cancelled`,
      status: "cancelled",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3600000),
    });
    const html = await (await app.request("/hotzones?season=2026-09", {}, live)).text();
    expect(countLine(html)).toEqual([2]);
    expect(countLinks(html)).toBe(2);
    expect(html).not.toContain(`${PROBE_PREFIX} draft`);
    expect(html).not.toContain(`${PROBE_PREFIX} cancelled`);
    expect(html).not.toContain("/e/01J9Z3NDEKTSV4RRFFQ69G5FA90");
  });

  it("filters the list by the same season window as the count", async () => {
    await reset();
    await seedPublished(2, { tag: "sept" });
    const janStarts = new Date("2025-01-06T10:00:00Z");
    await db.insert(events).values({
      eventKey: eventKey(80),
      title: `${PROBE_PREFIX} jan`,
      status: "published",
      startsAt: janStarts,
      endsAt: new Date(janStarts.getTime() + 3600000),
    });
    const sept = await (await app.request("/hotzones?season=2026-09", {}, live)).text();
    expect(countLine(sept)).toEqual([2]);
    expect(countLinks(sept)).toBe(2);
    expect(sept).not.toContain(`${PROBE_PREFIX} jan`);
    const jan = await (await app.request("/hotzones?season=2025-01", {}, live)).text();
    expect(countLine(jan)).toEqual([1]);
    expect(countLinks(jan)).toBe(1);
    expect(jan).toContain(`${PROBE_PREFIX} jan`);
  });

  it("escapes hostile gathering titles", async () => {
    await reset();
    const payload = `<script>alert("hotzone")</script>`;
    const startsAt = new Date("2026-09-08T10:00:00Z");
    await db.insert(events).values({
      eventKey: eventKey(70),
      title: `${PROBE_PREFIX} ${payload}`,
      status: "published",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3600000),
    });
    const html = await (await app.request("/hotzones?season=2026-09", {}, live)).text();
    expect(countLinks(html)).toBe(1);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain(payload);
  });

  it("orders the list soonest first", async () => {
    await reset();
    await seedPublished(3);
    const html = await (await app.request("/hotzones?season=2026-09", {}, live)).text();
    const positions = [0, 1, 2].map((i) => html.indexOf(`href="/e/${eventKey(i)}"`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it.each(["voice", "games"])("keeps %s free of the gathering list", async (signal) => {
    await reset();
    await seedPublished(3);
    const res = await app.request(`/hotzones/${signal}?season=2026-09`, {}, live);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(GATHERINGS_TESTID);
    expect(html).not.toContain("/e/");
    expect(html).not.toContain("showing ");
  });

  it("renders zero gatherings as today against the database", async () => {
    await reset();
    const html = await (await app.request("/hotzones?season=2026-09", {}, live)).text();
    expect(countLine(html)).toEqual([0]);
    expect(html).not.toContain(GATHERINGS_TESTID);
    expect(html).not.toContain("showing ");
  });

  it("adds at most one events read, with no per-row queries", async () => {
    await reset();
    await seedPublished(7);
    roundTrips = [];
    const html = await (await app.request("/hotzones?season=2026-09", {}, live)).text();
    expect(countLinks(html)).toBe(GATHERINGS_LIMIT);
    const firstPass = eventsSelects();
    // The count plus the bounded list: never one query per gathering.
    expect(firstPass.length).toBeLessThanOrEqual(2);
    // Growing the collection changes nothing: growth is bounded.
    await seedPublished(5, { tag: "more" });
    roundTrips = [];
    await app.request("/hotzones?season=2026-09", {}, live);
    expect(eventsSelects().length).toBe(firstPass.length);
  });

  it("exposes the bounded gatherings on the Kit index loader", async () => {
    await reset();
    await seedPublished(7);
    const data = await loadHotzonesIndexData({
      env: live,
      seasonParam: "2026-09",
      setHeaders: () => {},
      dbForFn: async () => db,
      recordBoardViewFn: async () => {},
    });
    const gatherings = gatheringsOf(data);
    expect(gatherings).toBeDefined();
    expect(gatherings).toHaveLength(GATHERINGS_LIMIT);
    expect(gatherings![0]).toMatchObject({ eventKey: eventKey(0) });
    // Soonest first, ISO instants the shell renders into <time datetime>.
    const instants = gatherings!.map((g) => new Date(g.startsAt).getTime());
    expect([...instants].sort((a, b) => a - b)).toEqual(instants);
    expect(data.joins.eventCount).toBe(7);
  });

  it("exposes the same filter on the Kit joins loader", async () => {
    await reset();
    await seedPublished(2);
    const startsAt = new Date("2026-09-08T10:00:00Z");
    await db.insert(events).values({
      eventKey: eventKey(90),
      title: `${PROBE_PREFIX} draft`,
      status: "draft",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3600000),
    });
    const data = await loadHotzoneSignalData({
      env: live,
      seasonParam: "2026-09",
      signalParam: "joins",
      setHeaders: () => {},
      dbForFn: async () => db,
      recordBoardViewFn: async () => {},
    });
    const gatherings = gatheringsOf(data);
    expect(gatherings).toHaveLength(2);
    expect(gatherings!.every((g) => !g.title.includes("draft"))).toBe(true);
    expect(data.eventCount).toBe(2);
  });

  it("exposes no gatherings on the Kit estimate loaders", async () => {
    await reset();
    await seedPublished(3);
    for (const signal of ["voice", "games"]) {
      const data = await loadHotzoneSignalData({
        env: live,
        seasonParam: "2026-09",
        signalParam: signal,
        setHeaders: () => {},
        dbForFn: async () => db,
        recordBoardViewFn: async () => {},
      });
      expect(gatheringsOf(data) ?? []).toEqual([]);
    }
  });

  it("bounds the Kit loader to one extra events read", async () => {
    await reset();
    await seedPublished(7);
    roundTrips = [];
    const data = await loadHotzonesIndexData({
      env: live,
      seasonParam: "2026-09",
      setHeaders: () => {},
      dbForFn: async () => db,
      recordBoardViewFn: async () => {},
    });
    expect(gatheringsOf(data)).toHaveLength(GATHERINGS_LIMIT);
    expect(eventsSelects().length).toBeLessThanOrEqual(2);
  });
});
