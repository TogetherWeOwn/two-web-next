// Calendar month-empty past suppression (Builder-owned proof for review findings).
//
// The month-empty block must only claim a definitive absence when the read is
// complete for that month. The month grid reads upcoming rows only, and the
// past drawer is the 20 most recent ended rows globally — so a past month
// beyond the drawer cap, or a current month with the drawer closed, may look
// empty while holding past events. These cases pin the suppression without
// touching the Test Author acceptance file.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Db } from "../src/db/index";
import { events } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import type { DiscordEventsSource } from "../src/events/discord-transients";
import { calendarMonthLabel } from "../src/islands/contracts";
import { loadEventsPage } from "../src/kit-events";
import { renderEventsHtml } from "../src/kit-events-html";

const APP_URL = "https://calendar.example.test";
const INVITE = "https://discord.gg/example";
const MONTH_EMPTY_TESTID = "calendar-month-empty";

const baseEnv = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: INVITE,
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
} as unknown as Env;

let eventSeq = 1000;
function eventRow(over: Partial<typeof events.$inferSelect> = {}): typeof events.$inferSelect {
  const n = ++eventSeq;
  const start = over.startsAt ?? new Date(Date.UTC(2026, 11, 15, 20));
  const end = over.endsAt ?? new Date(start.getTime() + 7200_000);
  return {
    id: n,
    icsSequence: 1n,
    eventKey: `ev-${n}`,
    title: `Game night ${n}`,
    game: null,
    description: null,
    startsAt: start,
    endsAt: end,
    timezone: "UTC",
    location: null,
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
    createdAt: start,
    updatedAt: start,
    ...over,
  };
}

function discordSource(
  rows: Awaited<ReturnType<DiscordEventsSource["upcoming"]>> = [],
  failed = false,
): DiscordEventsSource {
  return { upcoming: async () => rows, lastReadFailed: () => failed };
}

function calendarFixture(args: {
  upcoming?: (typeof events.$inferSelect)[];
  monthRows?: (typeof events.$inferSelect)[];
  past?: (typeof events.$inferSelect)[];
  source?: DiscordEventsSource;
}) {
  const upcoming = args.upcoming ?? [];
  const monthRows = args.monthRows ?? [];
  const past = args.past ?? [];
  const source = args.source ?? discordSource();
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const encode = (row: typeof events.$inferSelect) =>
    columns.map((k) => {
      const v = row[k];
      if (v instanceof Date) {
        // PostgreSQL infinity timestamps arrive as Invalid Dates via the
        // pg-proxy wire; encode them as the "infinity" string so drizzle
        // decodes them back to Invalid Date (like real PG infinity).
        // PG-finite/JS-overflow rows (marked __pgFiniteOverflow) encode their
        // invalid starts_at as a far-future timestamp string: real PG returns
        // a finite timestamp beyond the JS Date range, which the driver also
        // decodes to Invalid Date.
        if (Number.isFinite(v.getTime())) return v.toISOString();
        if (
          (row as unknown as Record<string, unknown>).__pgFiniteOverflow === true &&
          k === "startsAt"
        ) {
          return "280000-06-01T18:00:00Z";
        }
        return "infinity";
      }
      return v;
    });
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.startsWith('select "discord_event_id" from "events"')) {
      return {
        rows: [...upcoming, ...past]
          .filter((r) => params.includes(r.discordEventId))
          .map((r) => [r.discordEventId]),
      };
    }
    // The month-grid read is the only one with a bound starts_at upper bound
    // (`starts_at < $n`): rank counts compare against a subquery instead.
    if (sql.includes('"starts_at" < $')) return { rows: monthRows.map(encode) };
    let rows = /"ends_at" </.test(sql) ? past : upcoming;
    // Simulate the PostgreSQL isfinite() guard: when the query carries it,
    // true infinity rows never occupy SQL limit slots. Filter before the
    // limit slice, like real PG. PG-finite/JS-overflow rows (__pgFiniteOverflow)
    // pass real SQL isfinite() and occupy a slot, decoding to Invalid Date in
    // JS — so the simulation keeps them here and the JS filter drops them.
    if (sql.includes("isfinite")) {
      rows = rows.filter(
        (r) =>
          (r as unknown as Record<string, unknown>).__pgFiniteOverflow === true ||
          (Number.isFinite(r.startsAt.getTime()) && Number.isFinite(r.endsAt.getTime())),
      );
    }
    if (/^select count/i.test(sql)) return { rows: [[rows.length]] };
    if (sql.includes("limit")) rows = rows.slice(0, Number(params.at(-1)));
    return { rows: rows.map(encode) };
  });
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<void>) =>
      fn({ execute: async () => {} } as unknown as Db),
  });
  const adminDb = db as unknown as Db;
  const env = {
    ...baseEnv,
    ADMIN_DB: adminDb,
    DISCORD_EVENTS: source,
  } as unknown as Env;
  return {
    db: adminDb,
    env,
    request: (path: string, init?: RequestInit) => app.request(path, init, env),
  };
}

function blockFor(html: string, testid: string): string | null {
  return (
    new RegExp(`<div\\b[^>]*data-testid="${testid}"[^>]*>([\\s\\S]*?)</div>`).exec(html)?.[0] ??
    null
  );
}

function decKeep(): typeof events.$inferSelect {
  return eventRow({
    eventKey: "dec-keep",
    title: "December raid",
    startsAt: new Date("2026-12-15T20:00:00Z"),
    endsAt: new Date("2026-12-15T22:00:00Z"),
    timezone: "UTC",
  });
}

beforeEach(() => __resetAnonEventCacheForTests());
afterEach(() => vi.useRealTimers());

describe("month-empty past completeness", () => {
  it("suppresses the claim when the drawer-closed current month held a past event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    const octPast = eventRow({
      eventKey: "oct-past",
      title: "October past raid",
      startsAt: new Date("2026-10-15T20:00:00Z"),
      endsAt: new Date("2026-10-15T22:00:00Z"),
      timezone: "UTC",
    });
    const src = calendarFixture({ upcoming: [decKeep()], monthRows: [], past: [octPast] });
    const response = await src.request("/events?view=calendar&month=2026-10");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain(`data-testid="${MONTH_EMPTY_TESTID}"`);
  });

  it("suppresses the claim for a past month beyond the 20-row drawer cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    const past = Array.from({ length: 20 }, (_, i) =>
      eventRow({
        eventKey: `sep-${i + 1}`,
        title: `September raid ${i + 1}`,
        startsAt: new Date(Date.UTC(2026, 8, i + 1, 20)),
        endsAt: new Date(Date.UTC(2026, 8, i + 1, 22)),
        timezone: "UTC",
      }),
    );
    const src = calendarFixture({ upcoming: [decKeep()], monthRows: [], past });
    const response = await src.request("/events?view=calendar&month=2026-08&past=1");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain(`data-testid="${MONTH_EMPTY_TESTID}"`);
  });

  it("keeps the claim for a completely read past month that is truly empty", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T23:30:00Z"));
    const zoneRow = eventRow({
      eventKey: "zone-keep",
      title: "Zone fixture",
      startsAt: new Date("2026-09-15T20:00:00Z"),
      endsAt: new Date("2026-09-15T22:00:00Z"),
      timezone: "Etc/GMT-1",
    });
    const src = calendarFixture({ upcoming: [decKeep()], past: [zoneRow] });
    const response = await src.request("/events?view=calendar&month=2026-10");
    expect(response.status).toBe(200);
    const block = blockFor(await response.text(), MONTH_EMPTY_TESTID);
    expect(block).not.toBeNull();
    expect(block!).toContain(calendarMonthLabel("2026-10"));
  });

  it("keeps the claim for a future month even when the past drawer is truncated", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T12:00:00Z"));
    const past = Array.from({ length: 20 }, (_, i) =>
      eventRow({
        eventKey: `aug-${i + 1}`,
        title: `August raid ${i + 1}`,
        startsAt: new Date(Date.UTC(2026, 7, i + 1, 20)),
        endsAt: new Date(Date.UTC(2026, 7, i + 1, 22)),
        timezone: "UTC",
      }),
    );
    const src = calendarFixture({ upcoming: [decKeep()], monthRows: [], past });
    const response = await src.request("/events?view=calendar&month=2026-10");
    expect(response.status).toBe(200);
    const block = blockFor(await response.text(), MONTH_EMPTY_TESTID);
    expect(block).not.toBeNull();
    expect(block!).toContain(calendarMonthLabel("2026-10"));
  });

  it("keeps the claim for a completely read current month that is truly empty", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const sepPast = eventRow({
      eventKey: "sep-past",
      title: "September raid",
      startsAt: new Date("2026-09-15T20:00:00Z"),
      endsAt: new Date("2026-09-15T22:00:00Z"),
      timezone: "UTC",
    });
    const src = calendarFixture({ upcoming: [decKeep()], monthRows: [], past: [sepPast] });
    const response = await src.request("/events?view=calendar&month=2026-10");
    expect(response.status).toBe(200);
    const block = blockFor(await response.text(), MONTH_EMPTY_TESTID);
    expect(block).not.toBeNull();
    expect(block!).toContain(calendarMonthLabel("2026-10"));
  });

  it("suppresses the claim when an infinity import row would consume a drawer slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    // 21 ended rows: one infinity-start import (ends in the past, sorts
    // first in SQL), 19 September rows, and one August row holding the
    // selected month. Without the SQL finite guard the infinity row
    // occupies a limit slot, is dropped in JS, and the drawer returns 19
    // rows — looking complete while the August row sits unread.
    const infinityRow = eventRow({
      eventKey: "inf-import",
      title: "Infinity import",
      startsAt: new Date(NaN),
      endsAt: new Date("2020-01-01T20:00:00Z"),
      timezone: "UTC",
    });
    const sepRows = Array.from({ length: 19 }, (_, i) =>
      eventRow({
        eventKey: `sep-inf-${i + 1}`,
        title: `September raid ${i + 1}`,
        startsAt: new Date(Date.UTC(2026, 8, i + 1, 20)),
        endsAt: new Date(Date.UTC(2026, 8, i + 1, 22)),
        timezone: "UTC",
      }),
    );
    const augHold = eventRow({
      eventKey: "aug-hold",
      title: "August raid",
      startsAt: new Date("2026-08-15T20:00:00Z"),
      endsAt: new Date("2026-08-15T22:00:00Z"),
      timezone: "UTC",
    });
    const src = calendarFixture({
      upcoming: [decKeep()],
      monthRows: [],
      past: [infinityRow, ...sepRows, augHold],
    });
    const response = await src.request("/events?view=calendar&month=2026-08&past=1");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain(`data-testid="${MONTH_EMPTY_TESTID}"`);
  });

  it("suppresses the claim when a PG-finite JS-overflow row would consume a drawer slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    // 21 ended rows: one PG-finite/JS-overflow import (starts beyond the JS
    // Date range, ends in the past, sorts first in SQL), 19 September rows,
    // and one August row holding the selected month. SQL isfinite() passes
    // the overflow row so it occupies a limit slot, is dropped in JS, and a
    // post-filter length would misread the drawer as complete.
    const overflowRow = eventRow({
      eventKey: "overflow-import",
      title: "Overflow import",
      startsAt: new Date(NaN),
      endsAt: new Date("2020-01-01T20:00:00Z"),
      timezone: "UTC",
    });
    (overflowRow as unknown as Record<string, unknown>).__pgFiniteOverflow = true;
    const sepRows = Array.from({ length: 19 }, (_, i) =>
      eventRow({
        eventKey: `sep-ovf-${i + 1}`,
        title: `September raid ${i + 1}`,
        startsAt: new Date(Date.UTC(2026, 8, i + 1, 20)),
        endsAt: new Date(Date.UTC(2026, 8, i + 1, 22)),
        timezone: "UTC",
      }),
    );
    const augHold = eventRow({
      eventKey: "aug-hold-ovf",
      title: "August raid",
      startsAt: new Date("2026-08-15T20:00:00Z"),
      endsAt: new Date("2026-08-15T22:00:00Z"),
      timezone: "UTC",
    });
    const src = calendarFixture({
      upcoming: [decKeep()],
      monthRows: [],
      past: [overflowRow, ...sepRows, augHold],
    });
    const response = await src.request("/events?view=calendar&month=2026-08&past=1");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain(`data-testid="${MONTH_EMPTY_TESTID}"`);
  });

  it("suppresses the claim on the Kit render when a PG-finite JS-overflow row would consume a drawer slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
    // Same 21-row overflow shape as the Hono case, fed through the Kit
    // load+render: the overflow row passes SQL isfinite(), occupies a limit
    // slot, and drops in JS — so only the threaded pre-filter flag (never
    // the post-filter past.length fallback) may judge completeness here.
    const overflowRow = eventRow({
      eventKey: "overflow-import-kit",
      title: "Overflow import",
      startsAt: new Date(NaN),
      endsAt: new Date("2020-01-01T20:00:00Z"),
      timezone: "UTC",
    });
    (overflowRow as unknown as Record<string, unknown>).__pgFiniteOverflow = true;
    const sepRows = Array.from({ length: 19 }, (_, i) =>
      eventRow({
        eventKey: `sep-kit-${i + 1}`,
        title: `September raid ${i + 1}`,
        startsAt: new Date(Date.UTC(2026, 8, i + 1, 20)),
        endsAt: new Date(Date.UTC(2026, 8, i + 1, 22)),
        timezone: "UTC",
      }),
    );
    const augHold = eventRow({
      eventKey: "aug-hold-kit",
      title: "August raid",
      startsAt: new Date("2026-08-15T20:00:00Z"),
      endsAt: new Date("2026-08-15T22:00:00Z"),
      timezone: "UTC",
    });
    const src = calendarFixture({
      upcoming: [decKeep()],
      monthRows: [],
      past: [overflowRow, ...sepRows, augHold],
    });
    const collected: Record<string, string> = {};
    const url = new URL("/events?view=calendar&month=2026-08&past=1", APP_URL);
    const data = await loadEventsPage({
      env: { APP_URL, DISCORD_INVITE_URL: INVITE } as never,
      url,
      method: "GET",
      island: false,
      request: new Request(url),
      setHeaders: (headers) => Object.assign(collected, headers),
      deleteJoinCookie: () => {},
      dbForFn: async () => src.db,
      sessionForFn: async () => null,
      journeyForFn: async () => null,
      discordForFn: () => discordSource(),
      now: new Date("2026-10-31T12:00:00Z"),
    });
    const rendered = await renderEventsHtml(data as never, collected);
    expect(rendered.status).toBe(200);
    expect(rendered.body).not.toContain(`data-testid="${MONTH_EMPTY_TESTID}"`);
  });
});
