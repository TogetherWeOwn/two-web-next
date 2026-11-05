// route-inventory: GET /events.ics
// route-inventory: GET /events/:file{.+\.ics}
// Acceptance-owned: real app/read admission/builders, injected pg-proxy and
// memory sessions only. No timestamp writes, database, Discord or network.
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import app from "./app";
import {
  APP_URL,
  KEY,
  OTHER_KEY,
  type CalendarRow,
  calendarBytes,
  calendarRow,
  healthyVevent,
} from "./helpers/ics-wire-fixture";
import { projectEventRowValues } from "./helpers/pg-proxy-event-projection";

const PATH = `/events/${KEY}.ics`;
const SECRET = "test-session-secret-at-least-32-bytes-long";
type Actor = "guest" | "member" | "moderator";

function fixture(initial = [calendarRow()]) {
  const rows = initial;
  // Model driver decoding of a non-finite PostgreSQL timestamp via the
  // projection helper's default ("infinity"); never serialize an invalid
  // Date with toISOString (that would test the fake).
  const wire = (sql: string, params: unknown[], row: CalendarRow) =>
    projectEventRowValues(sql, params, row);
  const db = drizzle(async (sql, params) => {
    if (sql.includes('from "events"') && sql.includes('"event_key" ='))
      return {
        rows: rows.filter((row) => row.eventKey === params[0]).map((row) => wire(sql, params, row)),
      };
    if (sql.includes('from "events"') && sql.includes('"status" in')) {
      // LIMIT is also a bound parameter; do not mistake it for the clock.
      const clock = params.find(
        (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value),
      );
      if (typeof clock !== "string") throw new Error("Fixture expected a feed cutoff instant");
      const now = new Date(clock);
      return {
        rows: rows
          .filter((row) => params.includes(row.status) && row.endsAt >= now)
          .map((row) => wire(sql, params, row)),
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
    rows,
    async request(actor: Actor = "guest", validator?: string, path = PATH) {
      const headers = new Headers();
      if (validator) headers.set("if-none-match", validator);
      if (actor !== "guest") {
        const token = newSessionToken();
        await store.create({
          tokenHash: await hashToken(token),
          userId: actor,
          username: "fixture",
          avatar: null,
          member: true,
          moderator: actor === "moderator",
          expiresAt: new Date(Date.now() + 3600_000),
        });
        headers.set(
          "cookie",
          (
            await serializeSigned("__Host-two_session", token, SECRET, {
              path: "/",
              secure: true,
              httpOnly: true,
              sameSite: "Lax",
            })
          ).split(";")[0]!,
        );
      }
      return app.request(path, { headers }, env);
    },
  };
}

async function expectUnavailable(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("etag")).toBeNull();
  expect(response.headers.get("content-disposition")).toBeNull();
  expect(response.headers.get("content-type")).not.toContain("text/calendar");
  const body = await response.text();
  expect(body).not.toContain("BEGIN:VCALENDAR");
  expect(body).not.toContain(KEY);
  expect(body).not.toContain("Friday night Helldivers");
  expect(body).not.toMatch(/NaN|infinity|010000|-000001/);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-15T19:00:00Z"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const exportPoison: { label: string; overrides: Partial<CalendarRow> }[] = [
  { label: "invalid DTSTAMP", overrides: { updatedAt: new Date(NaN) } },
  { label: "expanded DTSTAMP", overrides: { updatedAt: new Date("+010000-01-01T00:00:00Z") } },
  { label: "negative DTSTAMP", overrides: { updatedAt: new Date("-000001-01-01T00:00:00Z") } },
  {
    label: "expanded DTSTART",
    overrides: {
      startsAt: new Date("+010000-01-01T00:00:00Z"),
      endsAt: new Date("+010000-01-02T00:00:00Z"),
    },
  },
  { label: "expanded DTEND", overrides: { endsAt: new Date("+010000-01-02T00:00:00Z") } },
  { label: "negative DTSTART", overrides: { startsAt: new Date("-000001-01-01T00:00:00Z") } },
  {
    label: "negative DTEND",
    overrides: {
      startsAt: new Date("-000002-01-01T00:00:00Z"),
      endsAt: new Date("-000001-01-01T00:00:00Z"),
    },
  },
];

describe("single ICS timestamp poison uses the export failure, not a cacheable calendar", () => {
  it.each(exportPoison)(
    "returns no-store 503 for $label even with a prior validator or wildcard",
    async ({ overrides }) => {
      const source = fixture();
      const healthy = await source.request();
      expect(healthy.status).toBe(200);
      const validator = healthy.headers.get("etag");
      expect(validator).toMatch(/^"[a-f0-9]{64}"$/);
      expect(await healthy.text()).toBe(calendarBytes(healthyVevent()));
      Object.assign(source.rows[0]!, overrides);
      for (const conditional of [undefined, validator!, "*"])
        await expectUnavailable(await source.request("guest", conditional));
    },
  );

  it.each(["member", "moderator"] as const)(
    "returns the same timestamp failure to an authorized %s reader",
    async (actor) => {
      // Only moderators may see drafts; a normal member uses a published row.
      const source = fixture([
        calendarRow({
          status: actor === "moderator" ? "draft" : "published",
          updatedAt: new Date(NaN),
        }),
      ]);
      await expectUnavailable(await source.request(actor, "*"));
    },
  );

  it.each(["startsAt", "endsAt"] as const)(
    "preserves 404 read refusal for an already-ineligible %s",
    async (field) => {
      const source = fixture([calendarRow({ [field]: new Date(NaN) })]);
      const response = await source.request("guest", "*");
      expect(response.status).toBe(404);
      expect(response.headers.get("etag")).toBeNull();
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.text()).not.toContain("BEGIN:VCALENDAR");
    },
  );

  it.each([-1n, 2147483648n])(
    "preserves the existing sequence-exhaustion 503 for %s",
    async (icsSequence) => {
      const source = fixture([calendarRow({ icsSequence })]);
      const response = await source.request("guest", "*");
      await expectUnavailable(response);
    },
  );

  it("does not reclassify an unrelated builder TypeError as timestamp poison", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const source = fixture([calendarRow({ title: 42 as unknown as string })]);
    const response = await source.request("guest", "*");
    expect(response.status).toBe(500);
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("content-disposition")).toBeNull();
    expect(await response.text()).not.toContain("BEGIN:VCALENDAR");
  });
});

describe("healthy ICS and authorization precede conditional export", () => {
  it.each([
    ["guest", "published"],
    ["member", "published"],
    ["moderator", "draft"],
  ] as const)("preserves healthy 200/304 and exact bytes for %s / %s", async (actor, status) => {
    const source = fixture([calendarRow({ status })]);
    const first = await source.request(actor);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(first.headers.get("content-disposition")).toBe(`attachment; filename="${KEY}.ics"`);
    expect(first.headers.get("cache-control")).toBe("max-age=300, private");
    const expected = calendarBytes(healthyVevent()).replace(
      "STATUS:CONFIRMED",
      status === "draft" ? "STATUS:TENTATIVE" : "STATUS:CONFIRMED",
    );
    expect(await first.text()).toBe(expected);
    const validator = first.headers.get("etag");
    expect(validator).toMatch(/^"[a-f0-9]{64}"$/);
    const unchanged = await source.request(actor, validator!);
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe(validator);
    expect(unchanged.headers.get("cache-control")).toBe("max-age=300, private");
    expect(await unchanged.text()).toBe("");
  });

  it.each(["guest", "member"] as const)(
    "refuses %s access to a draft before matching validators or timestamp classification",
    async (actor) => {
      const source = fixture([calendarRow({ status: "draft" })]);
      const allowed = await source.request("moderator");
      expect(allowed.status).toBe(200);
      const validator = allowed.headers.get("etag")!;
      for (const poison of [false, true]) {
        if (poison) source.rows[0]!.updatedAt = new Date(NaN);
        for (const conditional of [validator, "*"]) {
          const denied = await source.request(actor, conditional);
          expect(denied.status).toBe(403);
          expect(denied.headers.get("etag")).toBeNull();
          expect(denied.headers.get("content-disposition")).toBeNull();
          expect(await denied.text()).toBe("Forbidden");
        }
      }
    },
  );

  it("preserves last-second collection eligibility, clock-only ETag expiry and historical single downloads", async () => {
    const source = fixture();
    vi.setSystemTime(new Date("2026-07-15T20:00:00Z"));
    const live = await source.request("guest", undefined, "/events.ics");
    expect(live.status).toBe(200);
    expect(await live.text()).toBe(calendarBytes(healthyVevent()));
    const validator = live.headers.get("etag")!;
    vi.setSystemTime(new Date("2026-07-15T20:00:00.001Z"));
    const ended = await source.request("guest", validator, "/events.ics");
    expect(ended.status).toBe(200);
    expect(await ended.text()).toBe(calendarBytes());
    expect(ended.headers.get("etag")).not.toBe(validator);
    const single = await source.request();
    expect(single.status).toBe(200);
    expect(await single.text()).toBe(calendarBytes(healthyVevent()));
  });
});

describe("collection response keeps healthy subscribers intact", () => {
  it("serves only healthy bytes with stable conditional responses around timestamp and sequence poison", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const source = fixture([
      calendarRow(),
      calendarRow({ id: 2, updatedAt: new Date(NaN) }),
      calendarRow({ id: 3, updatedAt: new Date("+010000-01-01T00:00:00Z") }),
      calendarRow({
        id: 4,
        startsAt: new Date("+010000-01-01T00:00:00Z"),
        endsAt: new Date("+010000-01-02T00:00:00Z"),
      }),
      calendarRow({ id: 5, startsAt: new Date("-000001-01-01T00:00:00Z") }),
      calendarRow({ id: 6, icsSequence: 2147483648n }),
      calendarRow({ id: 7, eventKey: OTHER_KEY, status: "cancelled" }),
    ]);
    const expected = calendarBytes(
      healthyVevent(),
      healthyVevent(OTHER_KEY).replace("STATUS:CONFIRMED", "STATUS:CANCELLED"),
    );
    const first = await source.request("guest", undefined, "/events.ics");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(first.headers.get("cache-control")).toBe("max-age=300, public");
    expect(first.headers.get("content-disposition")).toBe('inline; filename="events.ics"');
    expect(first.headers.get("set-cookie")).toBeNull();
    expect(await first.text()).toBe(expected);
    const validator = first.headers.get("etag")!;
    expect(validator).toMatch(/^"[a-f0-9]{64}"$/);
    const unchanged = await source.request("guest", validator, "/events.ics");
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");
    source.rows.splice(1, 5);
    const withoutPoison = await source.request("guest", undefined, "/events.ics");
    expect(await withoutPoison.text()).toBe(expected);
    expect(withoutPoison.headers.get("etag")).toBe(validator);
  });
});
