import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { beforeAll, describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import { scheduleCases } from "./fixtures/event-scheduled-range";
import { timeFromNowIds as ids, timeFromNowWindow as window } from "./fixtures/event-time-from-now";
import { timeFromNowServerTime as serverTime } from "./fixtures/event-time-from-now";
import {
  compileScheduleKit,
  renderScheduledPage,
  scheduledEvent,
  scheduleOrigin,
  schedulePath,
  type KitRenderer,
} from "./helpers/event-scheduled-range";

// Behavioral browser matrix (including shipped minified bytes) is a separate
// node:test suite: node --import tsx --test ci/event-time-from-now.test.mjs.
// Keeping Chromium out of the root unit runner preserves its existing contract.
// Builder must wire that command to the existing browser-capable CI job.
let kit: KitRenderer;
beforeAll(async () => {
  kit = await compileScheduleKit();
});

function row(status = "published") {
  return scheduledEvent(scheduleCases[0], {
    startsAt: new Date(window.startsAt),
    endsAt: new Date(window.endsAt),
    timezone: window.timezone,
    status,
  });
}
function tag(html: string, id: string) {
  return html.match(new RegExp(`<[^>]+data-testid="${id}"[^>]*>`))?.[0] ?? "";
}

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin} time-from-now server acceptance`, () => {
    for (const viewer of ["guest", "member"] as const) {
      it(`U2.1/U2.2 ${viewer}: one hidden explicit action, empty polite result`, async () => {
        const { status, html } = await renderScheduledPage(twin, row(), viewer, kit, serverTime);
        expect(status).toBe(200);
        expect(
          html.match(new RegExp(`data-testid="${ids.button}"`, "g"))?.length ?? 0,
          "U2_ACTION_MISSING: mount one informational action on the real detail",
        ).toBe(1);
        expect(tag(html, ids.button)).toMatch(/^<button\b/);
        expect(tag(html, ids.button)).toContain('type="button"');
        expect(tag(html, ids.button)).toMatch(/\bhidden(?:[\s=>])/);
        expect(tag(html, ids.status)).toContain('role="status"');
        expect(tag(html, ids.status)).toContain('aria-live="polite"');
        expect(html).toMatch(
          new RegExp(`data-testid="${ids.status}"[^>]*>\\s*(?:<!--[^]*?-->\\s*)*</`),
        );
      });
      it(`CONTROL U2.6 ${viewer}: absolute schedule and device-zone actions remain authoritative`, async () => {
        const { html } = await renderScheduledPage(twin, row(), viewer, kit, serverTime);
        for (const instant of [window.startsAt, window.endsAt]) {
          expect(html).toContain(`<time datetime="${instant}">`);
        }
        for (const endpoint of ["starts", "ends"]) {
          expect(tag(html, `event-device-timezone-${endpoint}-button`)).toMatch(/^<button\b/);
        }
        expect(html).toContain(`rel="canonical" href="${scheduleOrigin}${schedulePath}"`);
        expect(html).toContain('data-testid="event-jsonld"');
        expect(html).not.toMatch(/(?:starts?|ends?) in \d+ (?:minute|hour|day)/i);
        expect(html.includes('data-testid="rsvp-going"')).toBe(viewer === "member");
      });
    }
    it("CONTROL U2.7 cancelled stays 410 without a timing invitation", async () => {
      const { status, html } = await renderScheduledPage(
        twin,
        row("cancelled"),
        "guest",
        kit,
        serverTime,
      );
      expect(status).toBe(410);
      expect(tag(html, ids.button)).toBe("");
      expect(html).toMatch(/cancelled/i);
    });
    it("CONTROL U2.7 draft stays forbidden to guests", async () => {
      const { status, html } = await renderScheduledPage(
        twin,
        row("draft"),
        "guest",
        kit,
        serverTime,
      );
      expect(status).toBe(403);
      expect(tag(html, ids.button)).toBe("");
    });
    it("CONTROL U2.7 moderator draft is closed, noindex and not an upcoming invitation", async () => {
      const { status, html } = await renderScheduledPage(
        twin,
        row("draft"),
        "moderator",
        kit,
        serverTime,
      );
      expect(status).toBe(200);
      expect(html).toContain('data-testid="event-draft"');
      expect(html).toContain('name="robots" content="noindex, nofollow"');
      expect(html).not.toContain('data-testid="rsvp-going"');
      const action = tag(html, ids.button);
      expect(!action || /\b(?:hidden|disabled)(?:[\s=>])/.test(action)).toBe(true);
    });
  });
}

it("CONTROL U2.4/U2.6 Hono: no added server reads, writes, network or cache-varying clock input", async () => {
  const fixture = row();
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof fixture)[];
  const statements: string[] = [];
  const db = drizzle(async (sql) => {
    statements.push(sql);
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (sql.includes('"event_key" =')) {
      return {
        rows: [
          columns.map((key) =>
            fixture[key] instanceof Date ? fixture[key].toISOString() : fixture[key],
          ),
        ],
      };
    }
    return { rows: [] };
  });
  const env = {
    APP_URL: scheduleOrigin,
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    SESSION_STORE: createMemorySessionStore(),
    ADMIN_DB: db as unknown as Db,
  } as unknown as Env;
  const response = await app.request(schedulePath, {}, env);
  expect(response.status).toBe(200);
  // Guest detail: event + going aggregates + two neighbors + related.
  // Main pins 6 (two aggregates); optimized withGoing merges them to 5.
  expect([5, 6]).toContain(statements.length);
  expect(statements.every((sql) => /^select\b/i.test(sql))).toBe(true);
  expect(statements.every((sql) => !/member_id/i.test(sql))).toBe(true);
  const aggregates = statements.filter((sql) => sql.includes('from "rsvps"'));
  if (statements.length === 6) {
    // Legacy: named (inner join + username bound) + occupancy (no join).
    expect(aggregates).toHaveLength(2);
    for (const sql of aggregates) {
      expect(sql).toContain('group by "rsvps"."event_id"');
      expect(sql).toMatch(/\bcount\(/i);
    }
    const named = aggregates.filter((sql) => sql.includes('inner join "users"'));
    const occupancy = aggregates.filter((sql) => !sql.includes('join "users"'));
    expect(named).toHaveLength(1);
    expect(occupancy).toHaveLength(1);
    expect(named[0]).toContain('"users"."username" <>');
  } else {
    // Optimized: one combined LEFT JOIN aggregate, named conditional + all-seat.
    expect(aggregates).toHaveLength(1);
    const [combined] = aggregates;
    expect(combined).toContain('group by "rsvps"."event_id"');
    expect(combined).toContain('left join "users"');
    expect(combined).not.toContain('inner join "users"');
    expect(combined).toContain("count(case when");
    expect(combined).toContain('"users"."username" <>');
    expect(combined).toMatch(/\bcount\(\*\)/i);
  }
  expect(response.headers.get("vary")).toMatch(/cookie/i);
  expect(response.headers.get("cache-control")).toMatch(/no-store/i);
});

it("CONTROL U2.4 Kit: timing has zero extra store reads and no new response headers", async () => {
  const calls: string[] = [];
  const read =
    <T>(name: string, value: T) =>
    async () => {
      calls.push(name);
      return value;
    };
  const store: KitEventDetailStore = {
    dbForFn: read("db", {} as Db),
    getEventFn: read("event", { ...row(), goingCount: 0, goingOccupancy: 0 }),
    neighborsFn: read("neighbors", { previous: null, next: null }),
    relatedFn: read("related", []),
    seriesFn: read("series", null),
    attendeesFn: read("attendees", []),
    viewerRsvpFn: read("rsvp", null),
    waitlistFn: read("waitlist", null),
    suggestionsFn: read("suggestions", []),
  };
  const headers: Record<string, string>[] = [];
  const outcome = await resolveKitEventDetail({
    key: schedulePath.slice(3),
    search: "",
    path: schedulePath,
    env: { APP_URL: scheduleOrigin } as Env,
    session: { status: "guest", session: null },
    joinResult: null,
    setHeaders: (value) => {
      headers.push(value);
    },
    store,
  });
  expect(outcome.kind).toBe("ok");
  expect(calls.sort()).toEqual(["db", "event", "neighbors", "related", "series"]);
  expect(headers).toHaveLength(1);
  expect(headers[0]?.["cache-control"]).toBe("private, no-store");
  expect(headers[0]?.vary).toBe("Cookie");
});
