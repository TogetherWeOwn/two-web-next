// Kit home guest-cache acceptance: the Kit homepage load serves its merged
// upcoming events plus visible featured rows through the shared isolate-local
// guest cache, the same module the Hono homepage handler uses — same TTL,
// same in-flight-retire guard, same never-store rules for outages, empty
// bases and Discord-degraded reads, and the same validated cf-ray correlation.
//
// Hermetic and test-only: the real route load is bundled with esbuild (the
// same harness as the Kit admin load suites) together with the real shared
// cache module, so the retire this file drives is the same export the
// committed featured/event mutations call. Only the Worker env binding is
// stubbed; the database and Discord seams are the production ADMIN_DB and
// DISCORD_EVENTS injection points backed by counting pg-proxy fakes.
//
// Failing-first: the memory-hit, stale-without-retire, in-flight, TTL and
// sourcing pins run red against the current direct-read load; the
// correlation, DTO and retire-caller pins are guards that must stay green
// through the move. Acceptance-owned fixtures: the paired build works on this
// branch and never edits this file — corrections come back to the test author
// through the tracker, and the paired build updates the Kit home reader pins
// that still name the direct readers.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { listVisibleFeatured } from "../src/featured";
import { loadHomeUpcomingMerged } from "../src/events/reads";
import type { DiscordTransient } from "../src/islands/contracts-calendar";

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    throw new Error("database unavailable");
  }),
}));

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const routePath = join(root, "web/src/routes/+page.server.ts");
const homeCachePath = join(root, "src/home-cache.ts");

const ENV_KEY = "__kitHomeGuestCacheEnv";

type KitHomeLoadArgs = {
  url: URL;
  request: Request;
  locals: { status?: string; session?: unknown; joinResult?: unknown };
  cookies: { delete: (name: string, options: Record<string, unknown>) => void };
  setHeaders: (headers: Record<string, string>) => void;
};

type KitHomeLoadData = {
  upcomingEvents: Array<
    { title: string; startsAt: Date; source: string } & Record<string, unknown>
  >;
  eventsUnavailable: boolean;
  featured: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

type KitHomeLoad = (args: KitHomeLoadArgs) => Promise<KitHomeLoadData>;

let load: KitHomeLoad;
let retireHomeGuestCache: () => Promise<void>;
let resetHomeGuestCache: () => void;
let cacheTtlMs: number;
let scratch = "";

function sharedEnv(): Record<string, unknown> {
  return (globalThis as Record<string, unknown>)[ENV_KEY] as Record<string, unknown>;
}

function setSharedEnv(next: Env): void {
  const current = sharedEnv();
  for (const key of Object.keys(current)) delete current[key];
  Object.assign(current, next);
}

function read(p: string): string {
  return readFileSync(p, "utf8");
}

beforeAll(async () => {
  // The stubbed Worker env is one mutable object: the bundle captures its
  // identity at import time, so every case mutates it in place instead of
  // replacing it.
  (globalThis as Record<string, unknown>)[ENV_KEY] = {};
  scratch = mkdtempSync(join(tmpdir(), "kit-home-guest-cache-"));
  const outfile = join(scratch, "kit-home-load-bundle.mjs");
  await build({
    stdin: {
      contents: [
        `export { load } from ${JSON.stringify(routePath)};`,
        `export {`,
        `  retireHomeGuestCache,`,
        `  __resetHomeGuestCacheForTests as resetHomeGuestCache,`,
        `  HOME_GUEST_CACHE_TTL_MS as cacheTtlMs,`,
        `} from ${JSON.stringify(homeCachePath)};`,
        ``,
      ].join("\n"),
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "warning",
    absWorkingDir: root,
    nodePaths: [join(root, "node_modules")],
    plugins: [
      {
        name: "kit-home-guest-cache-acceptance-env",
        setup(plugin) {
          plugin.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "kit-home-guest-cache-env",
            namespace: "kit-home-guest-cache-acceptance",
          }));
          plugin.onLoad({ filter: /.*/, namespace: "kit-home-guest-cache-acceptance" }, () => ({
            contents: `export const env = globalThis[${JSON.stringify(ENV_KEY)}];`,
            loader: "js",
          }));
        },
      },
    ],
  });
  const mod = (await import(pathToFileURL(outfile).href)) as unknown as {
    load: KitHomeLoad;
    retireHomeGuestCache: () => Promise<void>;
    resetHomeGuestCache: () => void;
    cacheTtlMs: number;
  };
  load = mod.load;
  retireHomeGuestCache = mod.retireHomeGuestCache;
  resetHomeGuestCache = mod.resetHomeGuestCache;
  cacheTtlMs = mod.cacheTtlMs;
}, 60000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  delete (globalThis as Record<string, unknown>)[ENV_KEY];
});

afterEach(() => {
  resetHomeGuestCache();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const NOW = new Date("2030-07-04T18:00:00Z");
// Synthetic 16-hex cf-ray (matches the request-log RAY_ID shape, low entropy
// so secret scanners stay quiet) plus a hostile header the reader must drop.
const CF_RAY = "0123456789abcdef";
const MALFORMED_RAY = "not-a-ray!!";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

function eventRow(id: number): typeof events.$inferSelect {
  const startsAt = new Date(NOW.getTime() + id * 3600_000);
  return {
    id,
    icsSequence: 1n,
    eventKey: `event-${id}`,
    title: `Game night ${id}`,
    game: null,
    description: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 7200_000),
    timezone: "Europe/London",
    location: "Voice lobby",
    capacity: null,
    status: "published",
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

type FeaturedBounds = { startsAt?: string | null; endsAt?: string | null };

// Positional projection: id, title, body, url, imageUrl, imageAlt, startsAt,
// endsAt. Null bounds stay visible at every instant.
function featuredRow(id: number, title = `Featured slot ${id}`, bounds: FeaturedBounds = {}) {
  return [
    id,
    title,
    `Featured body ${id}`,
    null,
    null,
    null,
    bounds.startsAt ?? null,
    bounds.endsAt ?? null,
  ];
}

function discordTransient(id: string, startOffsetHours: number): DiscordTransient {
  const startsAt = new Date(NOW.getTime() + startOffsetHours * 3600_000);
  return {
    discordId: id,
    status: "scheduled",
    title: `Discord game night ${id}`,
    description: "Discord public description",
    location: "Lobby voice room",
    startsAt,
    endsAt: new Date(startsAt.getTime() + 2 * 3600_000),
  };
}

type EventRows = (typeof events.$inferSelect)[];

function fixture(
  opts: {
    events?: EventRows;
    featured?: unknown[][];
    discordRows?: DiscordTransient[];
    discordFailed?: boolean;
  } = {},
) {
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const toRows = (list: EventRows) =>
    list.map((row) =>
      columns.map((key) => {
        const value = row[key];
        return value instanceof Date ? value.toISOString() : value;
      }),
    );
  let eventRows = opts.events ?? [eventRow(1)];
  let featuredRows = opts.featured ?? [featuredRow(1)];
  let discordRows = opts.discordRows ?? [];
  let discordFailed = opts.discordFailed ?? false;
  let down = false;
  let eventQueries = 0;
  let featuredQueries = 0;
  let discordCalls = 0;
  // In-flight gate for the canonical events select only: the auxiliary reads
  // (past zones, persisted Discord ids, RSVP aggregates) stay ungated.
  let holdEvents = false;
  let eventsEntered = false;
  let latched: unknown[][] | null = null;
  let releaseEvents: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  const rearm = () => {
    gate = new Promise<void>((resolve) => {
      releaseEvents = resolve;
    });
  };
  rearm();
  const db = drizzle(async (sql: string) => {
    if (down) throw new Error("database unavailable");
    if (sql.includes('from "featured_contents"')) {
      featuredQueries += 1;
      // The visible read selects the six display columns with the window in
      // SQL; the published-base read selects all eight and filters per
      // request. Distinguish the legs by the SELECT list — both queries
      // mention the bounds elsewhere — and emulate the SQL-side window ONLY
      // for the direct leg. The base leg returns the raw published base so
      // production's per-request currentlyVisible is what excludes rows.
      const projection = sql.slice(0, sql.indexOf('from "featured_contents"'));
      const sixColumn = !projection.includes('"starts_at"');
      if (!sixColumn) return { rows: featuredRows };
      // The SQL-side filter cannot run against a pg-proxy fake, so the direct
      // leg removes scheduled/expired rows here (start inclusive, end
      // exclusive, like currentlyVisible). ISO instants compare
      // lexicographically, so string bounds work.
      const nowIso = new Date().toISOString();
      const inWindow = featuredRows.filter((row) => {
        const startsAt = row[6] as string | null;
        const endsAt = row[7] as string | null;
        return (startsAt === null || startsAt <= nowIso) && (endsAt === null || endsAt > nowIso);
      });
      return { rows: inWindow.map((row) => row.slice(0, 6)) };
    }
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('"timezone"') && !sql.includes('"title"')) return { rows: [] };
    if (sql.includes("discord_event_id") && !sql.includes('"title"')) return { rows: [] };
    if (sql.includes('from "rsvps"')) {
      eventQueries += 1;
      return { rows: [] };
    }
    if (sql.includes('from "events"')) {
      eventQueries += 1;
      if (holdEvents) {
        latched ??= toRows(eventRows);
        eventsEntered = true;
        await gate;
        return { rows: latched };
      }
      return { rows: toRows(eventRows) };
    }
    return { rows: [] };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  const discord = {
    upcoming: async () => {
      discordCalls += 1;
      return [...discordRows];
    },
    lastReadFailed: () => discordFailed,
  };
  const env = { ...baseEnv, ADMIN_DB: db, DISCORD_EVENTS: discord } as Env;
  return {
    db,
    env,
    discord,
    counts: () => ({ eventQueries, featuredQueries, discordCalls }),
    setEvents: (rows: EventRows) => {
      eventRows = rows;
    },
    setFeatured: (rows: unknown[][]) => {
      featuredRows = rows;
    },
    setDiscordRows: (rows: DiscordTransient[]) => {
      discordRows = rows;
    },
    setDiscordFailed: (failed: boolean) => {
      discordFailed = failed;
    },
    setDown: (value: boolean) => {
      down = value;
    },
    hold: () => {
      holdEvents = true;
      eventsEntered = false;
      latched = null;
      rearm();
    },
    release: () => {
      holdEvents = false;
      releaseEvents();
    },
    entered: () => eventsEntered,
    use: () => setSharedEnv(env),
  };
}

type Fixture = ReturnType<typeof fixture>;

function loadArgs(opts: { cfRay?: string; notice?: string; method?: string } = {}) {
  const headers: Record<string, string> = {};
  const deleted: Array<{ name: string; options: Record<string, unknown> }> = [];
  const url = new URL(`https://example.test/${opts.notice ? `?n=${opts.notice}` : ""}`);
  const reqHeaders = new Headers();
  if (opts.cfRay !== undefined) reqHeaders.set("cf-ray", opts.cfRay);
  const request = new Request(url, { method: opts.method ?? "GET", headers: reqHeaders });
  const args: KitHomeLoadArgs = {
    url,
    request,
    locals: { status: "guest" },
    cookies: {
      delete: (name: string, options: Record<string, unknown>) => deleted.push({ name, options }),
    },
    setHeaders: (values: Record<string, string>) => Object.assign(headers, values),
  };
  return { args, headers, deleted };
}

async function waitForEntered(f: Fixture, what: string): Promise<void> {
  for (let i = 0; i < 100 && !f.entered(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!f.entered()) {
    f.release();
    throw new Error(`${what} never reached the driver`);
  }
}

describe("Kit home guest cache: same-isolate memory", () => {
  it("serves the second load from memory with no new DB or Discord reads", async () => {
    const f = fixture();
    f.use();
    const firstArgs = loadArgs();
    const first = await load(firstArgs.args);
    expect(first.eventsUnavailable).toBe(false);
    expect(first.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1"]);
    expect(first.featured.map((row) => row.title)).toEqual(["Featured slot 1"]);
    expect(firstArgs.headers).toEqual({ "cache-control": "private, no-store" });
    const afterFirst = f.counts();
    expect(afterFirst.eventQueries).toBeGreaterThan(0);
    expect(afterFirst.featuredQueries).toBeGreaterThan(0);
    expect(afterFirst.discordCalls).toBe(1);

    const second = await load(loadArgs().args);
    expect(second.eventsUnavailable).toBe(false);
    expect(second.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1"]);
    expect(second.featured).toEqual(first.featured);
    // Memory preserves value types: the cached teaser still carries Dates.
    const firstStart = first.upcomingEvents[0]!.startsAt;
    const secondStart = second.upcomingEvents[0]!.startsAt;
    expect(firstStart).toBeInstanceOf(Date);
    expect(secondStart).toBeInstanceOf(Date);
    expect(secondStart.getTime()).toBe(firstStart.getTime());
    // No new reads on the hit.
    expect(f.counts()).toEqual(afterFirst);
  });

  it("holds retired rows stale until the shared retire, then re-reads", async () => {
    const f = fixture();
    f.use();
    const first = await load(loadArgs().args);
    expect(first.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1"]);
    const afterFirst = f.counts();

    // Rows change without a retire: the cached load keeps serving Old.
    f.setEvents([eventRow(2)]);
    f.setFeatured([featuredRow(2, "Featured slot 2")]);
    const stale = await load(loadArgs().args);
    expect(stale.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1"]);
    expect(stale.featured.map((row) => row.title)).toEqual(["Featured slot 1"]);
    expect(f.counts()).toEqual(afterFirst);

    // The shared retire converges the Kit load: the next read re-queries.
    await retireHomeGuestCache();
    const fresh = await load(loadArgs().args);
    expect(fresh.upcomingEvents.map((row) => row.title)).toEqual(["Game night 2"]);
    expect(fresh.featured.map((row) => row.title)).toEqual(["Featured slot 2"]);
    const afterFresh = f.counts();
    expect(afterFresh.eventQueries).toBeGreaterThan(afterFirst.eventQueries);
    expect(afterFresh.featuredQueries).toBeGreaterThan(afterFirst.featuredQueries);
  });

  it("settles an in-flight read into memory but drops it when a retire lands first", async () => {
    const f = fixture();
    f.use();
    // Phase one, no retire: the gated Old read settles into memory.
    f.hold();
    const pending = load(loadArgs().args);
    await waitForEntered(f, "upcoming read");
    f.setEvents([eventRow(2)]);
    f.release();
    const settled = await pending;
    expect(settled.eventsUnavailable).toBe(false);
    expect(settled.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1"]);
    expect(settled.featured.map((row) => row.title)).toEqual(["Featured slot 1"]);
    const afterSettled = f.counts();
    const hit = await load(loadArgs().args);
    expect(hit.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1"]);
    expect(f.counts()).toEqual(afterSettled);

    // Phase two, retire while in flight: the pre-write value never settles,
    // so the next load re-queries instead of serving retired rows.
    resetHomeGuestCache();
    const beforeSecond = f.counts();
    f.hold();
    const pending2 = load(loadArgs().args);
    await waitForEntered(f, "second upcoming read");
    f.setEvents([eventRow(3)]);
    await retireHomeGuestCache();
    f.release();
    const settled2 = await pending2;
    expect(settled2.upcomingEvents.map((row) => row.title)).toEqual(["Game night 2"]);
    const next = await load(loadArgs().args);
    expect(next.upcomingEvents.map((row) => row.title)).toEqual(["Game night 3"]);
    expect(f.counts().eventQueries).toBeGreaterThan(beforeSecond.eventQueries);
  });
});

describe("Kit home guest cache: never-store rules", () => {
  it("never stores an outage, so recovery shows without a retire", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    f.use();
    f.setDown(true);
    const down = await load(loadArgs().args);
    expect(down.eventsUnavailable).toBe(true);
    expect(down.upcomingEvents).toEqual([]);
    expect(down.featured).toEqual([]);

    // Same injected database object, so the same cache key: a stored outage
    // would hide this recovery behind the TTL.
    f.setDown(false);
    const up = await load(loadArgs().args);
    expect(up.eventsUnavailable).toBe(false);
    expect(up.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1"]);
    expect(up.featured.map((row) => row.title)).toEqual(["Featured slot 1"]);
    const afterUp = f.counts();
    expect(afterUp.eventQueries).toBeGreaterThan(0);

    // Healthy reads do store: the immediate repeat is a memory hit.
    const hit = await load(loadArgs().args);
    expect(hit.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1"]);
    expect(f.counts()).toEqual(afterUp);
  });

  it("retires a cached empty featured base after a write", async () => {
    const f = fixture({ featured: [] });
    f.use();
    const empty = await load(loadArgs().args);
    expect(empty.featured).toEqual([]);
    expect(empty.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1"]);
    const afterEmpty = f.counts();

    f.setFeatured([featuredRow(9, "Late slot")]);
    await retireHomeGuestCache();
    const seen = await load(loadArgs().args);
    expect(seen.featured.map((row) => row.title)).toEqual(["Late slot"]);
    // The shared retire invalidates both the featured and upcoming entries.
    expect(f.counts().eventQueries).toBeGreaterThan(afterEmpty.eventQueries);
    expect(f.counts().featuredQueries).toBeGreaterThan(afterEmpty.featuredQueries);

    const afterSeen = f.counts();
    const hit = await load(loadArgs().args);
    expect(hit.featured.map((row) => row.title)).toEqual(["Late slot"]);
    expect(f.counts()).toEqual(afterSeen);
  });

  it("never stores a Discord-degraded upcoming read", async () => {
    const f = fixture({ discordFailed: true });
    f.use();
    const degraded = await load(loadArgs().args);
    expect(degraded.eventsUnavailable).toBe(false);
    expect(degraded.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1"]);

    // Discord recovers with a transient row: visible with no retire, because
    // the degraded list never seeded the cache.
    f.setDiscordFailed(false);
    f.setDiscordRows([discordTransient("d-1", 5)]);
    const recovered = await load(loadArgs().args);
    expect(recovered.eventsUnavailable).toBe(false);
    const titles = recovered.upcomingEvents.map((row) => row.title);
    expect(titles).toContain("Game night 1");
    expect(titles).toContain("Discord game night d-1");

    const afterRecovered = f.counts();
    const hit = await load(loadArgs().args);
    expect(hit.upcomingEvents.map((row) => row.title).sort()).toEqual([...titles].sort());
    expect(f.counts()).toEqual(afterRecovered);
  });
});

describe("Kit home guest cache: correlation and DTOs", () => {
  it("passes the validated cf-ray through to the home read fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture();
    f.use();
    f.setDown(true);

    await load(loadArgs({ cfRay: CF_RAY }).args);
    // A full outage warns once per leg, exactly like Hono: the featured leg
    // settles first, then the events leg.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toBe("Home featured unavailable; serving the fallback.");
    expect(warn.mock.calls[1]?.[0]).toBe("Home events unavailable; serving the fallback.");
    for (const call of warn.mock.calls) {
      const fields = call[1] as { request_id?: unknown; exception?: unknown };
      expect(fields.request_id).toBe(CF_RAY);
      expect(fields.exception).toBe("ReadFailure");
    }

    // An outage is never stored, so the hostile ray also reaches the reader —
    // and both legs drop it instead of logging raw caller text.
    await load(loadArgs({ cfRay: MALFORMED_RAY }).args);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn.mock.calls[2]?.[0]).toBe("Home featured unavailable; serving the fallback.");
    expect(warn.mock.calls[3]?.[0]).toBe("Home events unavailable; serving the fallback.");
    for (const call of warn.mock.calls.slice(2)) {
      const fields = call[1] as { request_id?: unknown; exception?: unknown };
      expect(fields.request_id).toBeUndefined();
      expect(fields.exception).toBe("ReadFailure");
    }
    expect(JSON.stringify(warn.mock.calls)).not.toContain(MALFORMED_RAY);
  });

  it("keeps healthy and degraded DTOs identical to the direct readers", async () => {
    const now = new Date();
    const day = 86_400_000;
    const visible = featuredRow(1, "Always visible");
    const scheduled = featuredRow(2, "Scheduled slot", {
      startsAt: new Date(now.getTime() + day).toISOString(),
    });
    const expired = featuredRow(3, "Expired slot", {
      endsAt: new Date(now.getTime() - day).toISOString(),
    });
    const f = fixture({
      events: [eventRow(1), eventRow(2)],
      featured: [visible, scheduled, expired],
    });
    f.use();

    const data = await load(loadArgs().args);
    // Window filtering matches the direct visible read exactly, key for key:
    // the cached path projects the published base back to VisibleFeatured,
    // so the pin is exact equality plus the six-key shape — neither
    // renderer may drift the rendered contract.
    const directFeatured = await listVisibleFeatured(f.db);
    expect(data.featured).toEqual(directFeatured);
    for (const row of data.featured) {
      expect(Object.keys(row).sort()).toEqual([
        "body",
        "id",
        "imageAlt",
        "imageUrl",
        "title",
        "url",
      ]);
    }
    expect(data.featured.map((row) => row.title)).toEqual(["Always visible"]);
    const directUpcoming = await loadHomeUpcomingMerged(
      async () => f.db,
      () => f.discord,
      now,
    );
    expect(data.upcomingEvents).toEqual(directUpcoming.items);
    expect(data.eventsUnavailable).toBe(directUpcoming.unavailable);
    expect(data.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1", "Game night 2"]);
    // The load contract keeps its fields: nothing dropped, nothing added.
    expect(Object.keys(data).sort()).toEqual([
      "appUrl",
      "counts",
      "eventsUnavailable",
      "featured",
      "homeCopy",
      "imageHosts",
      "inviteUrl",
      "joinResult",
      "notice",
      "session",
      "sessionUnavailable",
      "upcomingEvents",
    ]);

    // Degraded but non-empty stays served, exactly like the direct read.
    resetHomeGuestCache();
    f.setDiscordFailed(true);
    const degraded = await load(loadArgs().args);
    const directDegraded = await loadHomeUpcomingMerged(
      async () => f.db,
      () => f.discord,
      now,
    );
    expect(degraded.eventsUnavailable).toBe(false);
    expect(degraded.eventsUnavailable).toBe(directDegraded.unavailable);
    expect(degraded.upcomingEvents).toEqual(directDegraded.items);
  });
});

describe("Kit home guest cache: TTL", () => {
  it("hits before the shared TTL and re-reads exactly at expiry", async () => {
    expect(cacheTtlMs).toBe(60_000);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const f = fixture();
    f.use();
    const first = await load(loadArgs().args);
    expect(first.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1"]);
    const afterFirst = f.counts();

    // An intervening hit never extends the entry: still a hit at TTL-1ms.
    vi.setSystemTime(new Date(NOW.getTime() + cacheTtlMs - 1));
    const hit = await load(loadArgs().args);
    expect(hit.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1"]);
    expect(hit.featured.map((row) => row.title)).toEqual(["Featured slot 1"]);
    expect(f.counts()).toEqual(afterFirst);

    // Exactly at TTL the entry lapses and the load re-reads.
    vi.setSystemTime(new Date(NOW.getTime() + cacheTtlMs));
    const fresh = await load(loadArgs().args);
    expect(fresh.upcomingEvents.map((row) => row.title)).toEqual(["Game night 1"]);
    expect(f.counts().eventQueries).toBeGreaterThan(afterFirst.eventQueries);
    expect(f.counts().featuredQueries).toBeGreaterThan(afterFirst.featuredQueries);
  });
});

describe("Kit home guest cache: shared sourcing, no duplicate retire path", () => {
  const ROUTE = join(root, "web/src/routes/+page.server.ts");
  const MANIFEST = join(root, "src/route-ownership.ts");
  const RETIRE_CALLERS = [
    "src/admin/store-featured.ts",
    "src/admin/store-event-writes.ts",
    "src/events/rsvp.ts",
    "src/agent-events/ingress.ts",
  ];

  it("routes the Kit home load through the shared guest cache", () => {
    const server = read(ROUTE);
    expect(server).toContain("cachedHomeUpcoming");
    expect(server).toContain("cachedFeatured");
    expect(server).toContain("cachedHomeUpcoming(");
    expect(server).toContain("cachedFeatured(");
    // The direct per-request reads are gone: every Kit home hit would
    // otherwise pay full DB plus Discord reads again.
    expect(server).not.toContain("loadHomeUpcomingMerged(");
    expect(server).not.toContain("listVisibleFeatured(");
    // Hono-equivalent inputs survive the move: env-backed factories, the
    // Discord source and the validated cf-ray correlation.
    expect(server).toContain("dbFor");
    expect(server).toContain("discordEventsSource");
    expect(server).toContain('request.headers.get("cf-ray")');
  });

  it("adds no Kit-side duplicate retire path", () => {
    const server = read(ROUTE);
    // Retirement stays the shared module's job (called by the committed
    // featured/event mutations below): the load only reads through it.
    expect(server).not.toContain("retireHomeGuestCache");
    expect(server).not.toContain("__resetHomeGuestCacheForTests");
    expect(server).not.toContain("new Map(");
    expect(server).not.toContain("expiresAt");
  });

  it("keeps the existing shared retire callers converging the Kit load", () => {
    // Every committed featured/event mutation retires through the one shared
    // function — the same export the behavioral retire tests above drive —
    // so no caller migration and no second retire path can drift the Kit load.
    for (const rel of RETIRE_CALLERS) {
      const source = read(join(root, rel));
      expect(source).toContain("retireHomeGuestCache");
      expect(source).toContain('from "../home-cache"');
    }
  });

  it("leaves GET / ownership on Hono", () => {
    // Cache sourcing lands before the flip; the flip itself is out of scope.
    expect(read(MANIFEST)).toMatch(/method:\s*"GET",\s*path:\s*"\/",\s*enabled:\s*false/);
  });
});
