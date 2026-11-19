import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureOrigin, fixtureRequest } from "../src/fixture-origin";
import { EventPage } from "../src/events/pages-detail";
import type { PublicEvent } from "../src/events/reads";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import { loadPastArchivePage, dispatchPastArchiveRequest } from "../src/kit-past-events";
import type { Db } from "../src/db";
import type { Env } from "../src/env";
import * as shipped from "../src/render-clock";

type Clock = typeof shipped;
const APP_URL = "http://127.0.0.1:8788";
const env = { APP_URL, SSR_CAPTURE_FIXTURE: "true" } as Env;
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const request = (path = `/e/${KEY}`, init?: RequestInit) => new Request(APP_URL + path, init);

async function buildClock(local: boolean): Promise<Clock> {
  const bundle = buildSync({
    entryPoints: ["src/render-clock.ts"],
    bundle: true,
    write: false,
    format: "esm",
    ...(local ? { define: { __TWO_LOCAL_CAPTURE__: "true" } } : {}),
  }).outputFiles[0]!.text;
  return import(`data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`);
}
const clock = await buildClock(true);

afterEach(() => vi.useRealTimers());

describe("fixed SSR display clock eligibility", () => {
  it("cannot activate in a shipped build even with forged local configuration", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-11-05T12:00:00Z"));
    for (const deployed of [shipped, await buildClock(false)]) {
      expect(deployed.captureRequest(request(), env)).toBe(false);
      expect(deployed.renderDate(request(), env).getTime()).toBe(Date.now());
      expect(deployed.captureRefusal(request("/"), env)).toBeUndefined();
    }
    for (const path of ["wrangler.jsonc", "web/wrangler.staging.jsonc", "web/wrangler.jsonc"]) {
      expect(readFileSync(path, "utf8")).not.toContain("__TWO_LOCAL_CAPTURE__");
      expect(readFileSync(path, "utf8")).not.toContain("SSR_CAPTURE_FIXTURE");
    }
  });

  it("requires the exact fixture opt-in and a canonical HTTP loopback origin", () => {
    for (const origin of [APP_URL, "http://localhost:8788", "http://[::1]:8788"]) {
      expect(
        clock.captureRequest(new Request(origin + "/about"), { ...env, APP_URL: origin }),
      ).toBe(true);
    }
    for (const flag of [undefined, "false", "1", "TRUE", " true "]) {
      expect(clock.captureRequest(request(), { ...env, SSR_CAPTURE_FIXTURE: flag })).toBe(false);
    }
    for (const APP_URL of [
      undefined,
      "",
      "garbage",
      "https://127.0.0.1:8788",
      "https://localhost:8788",
      "https://[::1]:8788",
      "https://example.workers.dev",
      "http://example.test",
      "http://192.0.2.1",
      "http://localhost.example.test",
      "http://127.0.0.1@evil.test",
      "http://user@localhost:8788",
      "http://127.0.0.1:8788/path",
      "http://127.0.0.1:8788/?clock=fixed",
      "http://127.0.0.1:8788/#fixed",
      " http://127.0.0.1:8788",
      "http://2130706433:8788",
      "http://127.1:8788",
    ]) {
      expect(fixtureOrigin(APP_URL), String(APP_URL)).toBeUndefined();
      expect(clock.captureRequest(request(), { ...env, APP_URL }), String(APP_URL)).toBe(false);
    }
  });

  it("uses the request URL, never a spoofed Host, forwarded header, cookie or query", () => {
    const headers = {
      host: "127.0.0.1:8788",
      origin: APP_URL,
      forwarded: "host=127.0.0.1:8788;proto=http",
      "x-forwarded-host": "127.0.0.1:8788",
      "x-forwarded-proto": "http",
      "x-two-ssr-clock": shipped.SSR_CAPTURE_INSTANT,
      cookie: "SSR_CAPTURE_FIXTURE=true; clock=2098-12-31T20:00:00Z",
    };
    for (const origin of [
      "https://example.workers.dev",
      "http://example.test",
      "https://127.0.0.1:8788",
      "http://127.0.0.1:9999",
    ]) {
      const remote = new Request(origin + "/about?SSR_CAPTURE_FIXTURE=true", { headers });
      expect(fixtureRequest(remote, APP_URL)).toBe(false);
      expect(clock.captureRequest(remote, env)).toBe(false);
    }
    expect(
      clock.captureRequest(request("/about", { headers: { host: "example.test" } }), env),
    ).toBe(false);
    expect(
      clock.captureRequest(request("/about?SSR_CAPTURE_FIXTURE=true", { headers }), { APP_URL }),
    ).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect(clock.captureRequest(request("/about", { method }), env)).toBe(false);
    }
  });

  it("keeps concurrent default requests live and never shares a mutable Date", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const dates = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        await Promise.resolve();
        return clock.renderDate(request(), i % 2 ? env : { APP_URL });
      }),
    );
    for (const [i, date] of dates.entries()) {
      expect(date.toISOString()).toBe(
        i % 2 ? "2098-12-31T20:00:00.000Z" : "2030-01-01T00:00:00.000Z",
      );
    }
    dates[1]!.setUTCFullYear(2001);
    expect(dates[3]!.toISOString()).toBe("2098-12-31T20:00:00.000Z");
    expect(Date.now()).toBe(new Date("2030-01-01T00:00:00Z").getTime());
    expect(env).not.toHaveProperty("now");
  });
});

const event: PublicEvent = {
  id: 1,
  eventKey: KEY,
  title: "Capture fixture",
  game: "Chess",
  description: "Synthetic fixture",
  startsAt: new Date("2098-12-31T19:00:00Z"),
  endsAt: new Date("2098-12-31T21:00:00Z"),
  timezone: "UTC",
  location: "Fixture room",
  capacity: 10,
  goingCount: 0,
  status: "published",
  rsvpOpen: true,
  createdBy: null,
  discordEventId: null,
} as PublicEvent;
function store(): KitEventDetailStore {
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => event,
    neighborsFn: vi.fn(async () => ({ previous: null, next: null })),
    relatedFn: vi.fn(async () => []),
    seriesFn: async () => null,
    attendeesFn: async () => [],
    viewerRsvpFn: async () => null,
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
}

describe("frozen SSR display state", () => {
  it("repeats Hono HTML and Kit models at different wall times with the same display state", async () => {
    const hono: string[] = [];
    const kit: unknown[] = [];
    for (const wall of ["2026-11-05T12:00:00Z", "2110-06-01T09:00:00Z"]) {
      vi.useFakeTimers().setSystemTime(new Date(wall));
      const now = clock.renderDate(request(), env);
      hono.push(
        String(
          await EventPage({
            e: event,
            neighbors: { previous: null, next: null },
            related: [],
            appUrl: APP_URL,
            jsonLd: "{}",
            now,
          }),
        ),
      );
      const reads = store();
      const outcome = await resolveKitEventDetail({
        key: KEY,
        path: `/e/${KEY}`,
        search: "",
        env,
        session: { status: "guest", session: null },
        joinResult: null,
        setHeaders: () => {},
        store: reads,
        now,
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") throw new Error("missing render model");
      expect(outcome.model.isOngoing).toBe(true);
      expect(outcome.model.rsvpClosed).toBeNull();
      expect(reads.neighborsFn).toHaveBeenCalledWith(expect.anything(), event, now);
      expect(reads.relatedFn).toHaveBeenCalledWith(expect.anything(), event, now);
      kit.push(outcome.model);
      expect(Date.now()).toBe(new Date(wall).getTime());
    }
    expect(hono[0]).toContain("Happening now");
    expect(hono[0]).toBe(hono[1]);
    expect(kit[0]).toEqual(kit[1]);
  });

  it("passes the snapshot to both searched and ordinary archive reads", async () => {
    for (const queryParam of [null, "Chess"]) {
      const listPastFn = vi.fn(async (_db: Db, _page: number, _now?: Date, _q?: string | null) => ({
        rows: [],
        hasMore: false,
        totalPages: 0,
      }));
      const now = clock.renderDate(request("/events/past"), env);
      await loadPastArchivePage({
        env,
        pageParam: null,
        queryParam,
        now,
        setHeaders: () => {},
        dbForFn: async () => ({}) as Db,
        listPastFn,
      });
      expect(listPastFn.mock.calls[0]?.[2]).toEqual(now);
    }
  });

  it("fails qualification for every uncovered frozen row and every non-HTML or failed outcome", () => {
    for (const path of [
      "/",
      "/events",
      "/join",
      "/profile",
      "/members/fixture",
      "/leaderboards/members",
      "/hotzones",
      "/hotzones/joins",
      "/voice",
      "/games",
      "/admin",
      "/admin/events",
      "/admin/events/new",
      "/admin/events/fixture",
      "/admin/featured",
      "/admin/featured/new",
      "/admin/featured/1",
      "/admin/activity-log",
      "/admin/join-attempts",
      "/admin/join-attempts/1",
      "/unknown-capture-path",
    ]) {
      expect(clock.captureRefusal(request(path), env)?.status, path).toBe(412);
      expect(
        clock
          .captureResponse(
            request(path),
            env,
            new Response("<main>live</main>", { headers: { "content-type": "text/html" } }),
          )
          .headers.has(shipped.SSR_CAPTURE_HEADER),
      ).toBe(false);
    }
    for (const path of [
      "/about",
      "/faq",
      "/rules",
      "/privacy",
      "/auth/recover",
      "/events/past",
      `/e/${KEY}`,
    ]) {
      expect(clock.captureRefusal(request(path), env)).toBeUndefined();
      const response = clock.captureResponse(
        request(path),
        env,
        new Response("<main>fixture</main>", { headers: { "content-type": "text/html" } }),
      );
      expect(response.headers.get(shipped.SSR_CAPTURE_HEADER)).toBe(shipped.SSR_CAPTURE_INSTANT);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    for (const status of [301, 403, 404, 422, 500, 503]) {
      expect(
        clock
          .captureResponse(
            request(),
            env,
            new Response("failure", { status, headers: { "content-type": "text/html" } }),
          )
          .headers.has(shipped.SSR_CAPTURE_HEADER),
      ).toBe(false);
    }
    expect(
      clock
        .captureResponse(request(), env, Response.json({}))
        .headers.has(shipped.SSR_CAPTURE_HEADER),
    ).toBe(false);
  });

  it("leaves the archive read guard and real-time cache clock intact", async () => {
    const guard = vi.fn(async () => new Response("limited", { status: 429 }));
    const resolve = vi.fn(async () => new Response("fixture"));
    const response = await dispatchPastArchiveRequest(request("/events/past"), env, resolve, guard);
    expect(response.status).toBe(429);
    expect(resolve).not.toHaveBeenCalled();
  });
});
