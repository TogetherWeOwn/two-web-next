// TOG-11766: dedicated parity pins for the past archive's canonical +
// no-RSVP-controls half.
//
// The PastEvents island (TOG-9841), the archive canonical origins (TOG-11558)
// and the themed restyle (TOG-11169) each own their slice; this file pins,
// through the real route, that every past-page state emits its canonical
// link, never indexes, and renders zero RSVP controls or islands.
// Test-only: a failure names a leak in PastEventsPage, it never edits pages.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import app from "./app";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  PAST_EVENTS_COPY,
  PAST_EVENTS_EMPTY_TESTID,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  pastEventsOutOfRangeCopy,
} from "../src/islands/contracts";

const APP_URL = "https://next.example.test";
const binder = readFileSync(new NodeURL("../public/islands/past-events.js", import.meta.url), "utf8");

function eventRow(n: number): typeof events.$inferSelect {
  const date = new Date(Date.UTC(2020, 0, n + 1));
  return {
    id: n, icsSequence: 1n, eventKey: `archive-${n}`, title: `Past game ${n}`, game: "Chess", description: null,
    startsAt: date, endsAt: date, timezone: "UTC", location: null, capacity: 10, status: "past",
    discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
    createdBy: null, rsvpOpen: true, recurrenceFrequency: null,
    recurrenceCount: null, recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null,
    createdAt: date, updatedAt: date,
  };
}

// Execute the real Drizzle selects and Hono route, but never connect to a database.
function archive(total: number) {
  const rows = Array.from({ length: total }, (_, i) => eventRow(total - i));
  const db = drizzle(async (sql, params) => {
    if (sql.startsWith('select count(*) from "events"')) return { rows: [[total]] };
    if (sql.includes('from "rsvps"')) return { rows: [] };
    const hasOffset = sql.includes(" offset ");
    const offset = hasOffset ? Number(params.at(-1)) : 0;
    const limit = Number(params.at(hasOffset ? -2 : -1));
    const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
    return { rows: rows.slice(offset, offset + limit).map((row) => columns.map((k) => {
      const value = row[k];
      return value instanceof Date ? value.toISOString() : value;
    })) };
  });
  const env = { APP_URL, ADMIN_DB: db as unknown as Db } as unknown as Env;
  return { request: (path: string) => app.request(path, {}, env) };
}

const canonicals = (html: string) =>
  [...html.matchAll(/<link rel="canonical" href="([^"]+)"/g)].map((m) => m[1]);
const ogUrls = (html: string) =>
  [...html.matchAll(/<meta property="og:url" content="([^"]+)"/g)].map((m) => m[1]);
const robots = (html: string) =>
  [...html.matchAll(/<meta name="robots" content="([^"]+)"/g)].map((m) => m[1]);
const islands = (html: string) =>
  [...html.matchAll(/data-island="([^"]+)"/g)].map((m) => m[1]);
const scripts = (html: string) =>
  [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
const keys = (html: string) =>
  [...html.matchAll(/data-event-key="([^"]+)"/g)].map((m) => m[1]);

// Extract the archive island section so forbidden-control checks ignore
// themed header/footer chrome: SiteHeader/SiteFooter legitimately carry
// auth/search links, buttons and forms outside the archive section.
function archiveSection(html: string): string {
  const match = html.match(/<section[^>]*data-island="past-events"[\s\S]*?<\/section>/);
  expect(match).not.toBeNull();
  return match![0];
}

// The parity triple every past-page state must hold: its canonical (mirrored
// by og:url, exactly one tag), never index, zero RSVP surface.
function expectArchiveSeo(html: string, canonical: string) {
  expect(canonicals(html)).toEqual([canonical]);
  expect(ogUrls(html)).toEqual([canonical]);
  expect(robots(html)).toEqual(["noindex, follow"]);
  const mounted = islands(html);
  expect(mounted.length).toBeGreaterThan(0);
  for (const name of mounted) expect(name).toBe("past-events");
  expect(html).not.toMatch(/data-testid="(?:rsvp-|waitlist-|event-going-count)/);
  expect(html).not.toContain("/rsvp");
  // Header/footer chrome is tolerated outside the archive section; the
  // section itself must carry zero RSVP surface and zero controls.
  const section = archiveSection(html);
  expect(section).not.toMatch(/data-testid="(?:rsvp-|waitlist-|event-going-count)/);
  expect(section).not.toContain("/rsvp");
  expect(section).not.toMatch(/<button|<form/);
  expect(scripts(html)).toEqual(["/islands/past-events.js"]);
}

describe("past-events canonical + no-RSVP-controls (TOG-11766)", () => {
  it("page one emits the bare canonical, never indexes, no RSVP surface", async () => {
    const res = await archive(25).request("/events/past");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await res.text();
    expect(keys(html)).toHaveLength(20);
    expectArchiveSeo(html, `${APP_URL}/events/past`);
  });

  it("page two emits the page-N canonical, never indexes, no RSVP surface", async () => {
    const res = await archive(25).request("/events/past?page=2");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(keys(html)).toEqual(["archive-5", "archive-4", "archive-3", "archive-2", "archive-1"]);
    expectArchiveSeo(html, `${APP_URL}/events/past?page=2`);
  });

  it("the never-run archive keeps the bare canonical and the join pitch, no RSVP surface", async () => {
    const html = await (await archive(0).request("/events/past")).text();
    expect(html).toContain(`data-testid="${PAST_EVENTS_EMPTY_TESTID}"`);
    expect(html).toContain(PAST_EVENTS_COPY.empty);
    expect(keys(html)).toEqual([]);
    expectArchiveSeo(html, `${APP_URL}/events/past`);
  });

  it("out-of-range pages name the requested page canonical, never index, no RSVP surface", async () => {
    const html = await (await archive(25).request("/events/past?page=9")).text();
    expect(html).toContain(`data-testid="${PAST_EVENTS_OUT_OF_RANGE_TESTID}"`);
    expect(html).toContain(pastEventsOutOfRangeCopy(9, 2));
    expect(keys(html)).toEqual([]);
    expectArchiveSeo(html, `${APP_URL}/events/past?page=9`);
  });

  it("invalid page input falls back to the page-one canonical, no RSVP surface", async () => {
    const html = await (await archive(25).request("/events/past?page=invalid")).text();
    expect(keys(html)).toHaveLength(20);
    expectArchiveSeo(html, `${APP_URL}/events/past`);
  });

  it("the shipped binder never touches RSVP endpoints", () => {
    expect(binder.toLowerCase()).not.toContain("rsvp");
    expect(binder).toContain('link[rel="canonical"]');
  });
});
