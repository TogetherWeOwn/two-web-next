// Behavior-preserving shared helpers: date stamps, month names, the Kit events
// guard alias, and the anonymous-cache response read/settle pair. Hermetic: no
// database, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateStamp } from "../src/date-stamp";
import type { Env } from "../src/env";
import {
  ANON_EVENTS_TTL_MS,
  ANON_PAST_TTL_MS,
  __resetAnonEventCacheForTests,
  anonCacheGeneration,
  readAnonCacheResponse,
  retireAnonEventCaches,
  settleAnonCacheResponse,
  type AnonCacheSource,
} from "../src/events/anon-cache";
import { faqLastReviewed } from "../src/faq-last-reviewed";
import { dispatchEventsRequest, kitEventsGuard } from "../src/kit-events";
import { dispatchPastArchiveRequest, kitPublicReadGuard } from "../src/kit-past-events";
import { rulesLastUpdated } from "../src/rules-last-updated";
import { MONTH_NAMES } from "../src/seo";

describe("dateStamp and its named wrappers", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("formats a valid date and trims whitespace", () => {
    expect(dateStamp(" 2026-02-09 ", "w")).toEqual({
      iso: "2026-02-09",
      label: "9 February 2026",
    });
    expect(faqLastReviewed("2026-12-31")).toEqual({
      iso: "2026-12-31",
      label: "31 December 2026",
    });
    expect(rulesLastUpdated("2026-01-01")).toEqual({
      iso: "2026-01-01",
      label: "1 January 2026",
    });
  });

  it("hides blank and unset input silently", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(dateStamp(raw, "w")).toBeNull();
      expect(faqLastReviewed(raw)).toBeNull();
      expect(rulesLastUpdated(raw)).toBeNull();
    }
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("applies Gregorian leap rules across centuries", () => {
    for (const year of ["2000", "2024", "0400"]) {
      expect(dateStamp(`${year}-02-29`, "w")?.iso).toBe(`${year}-02-29`);
    }
    for (const year of ["1900", "2100", "2023", "0100"]) {
      expect(dateStamp(`${year}-02-29`, "w")).toBeNull();
    }
  });

  it("accepts year 0000 as a leap year and keeps the padded label", () => {
    expect(dateStamp("0000-02-29", "w")).toEqual({ iso: "0000-02-29", label: "29 February 0000" });
  });

  it("rejects impossible shapes and ranges, warning once with the given text", () => {
    const bad = [
      "2026-13-01",
      "2026-00-10",
      "2026-04-31",
      "2026-01-00",
      "2026-1-01",
      "26-01-01",
      "x",
    ];
    for (const raw of bad) {
      vi.mocked(console.warn).mockClear();
      expect(dateStamp(raw, "custom warning")).toBeNull();
      expect(console.warn).toHaveBeenCalledExactlyOnceWith("custom warning");
    }
  });

  it("keeps each wrapper's exact warning", () => {
    expect(faqLastReviewed("nope")).toBeNull();
    expect(console.warn).toHaveBeenLastCalledWith(
      "Invalid community.faq_last_reviewed — hiding /faq stamp",
    );
    expect(rulesLastUpdated("nope")).toBeNull();
    expect(console.warn).toHaveBeenLastCalledWith(
      "Invalid community.rules_last_updated — hiding /rules stamp",
    );
  });

  it("exports the twelve full English month names", () => {
    expect(MONTH_NAMES).toEqual([
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ]);
  });
});

describe("kitEventsGuard", () => {
  it("is the same function object as the past-events guard", () => {
    expect(kitEventsGuard).toBe(kitPublicReadGuard);
  });
});

describe("anonymous cache response helpers", () => {
  const source: AnonCacheSource = { db: {}, discord: {}, appUrl: "https://a.test" };
  const other: AnonCacheSource = { db: {}, discord: {}, appUrl: "https://b.test" };
  const EVENTS_CC = "public, max-age=60";
  const PAST_CC = "public, max-age=300";
  const html = (body: string, cc: string | null, vary: string | null = "Cookie") => {
    const h = new Headers({ "content-type": "text/html; charset=UTF-8" });
    if (cc) h.set("cache-control", cc);
    if (vary) h.set("vary", vary);
    return new Response(body, { status: 200, headers: h });
  };
  const settle = (key: string, res: Response, gen = anonCacheGeneration(), now = 1_000_000) =>
    settleAnonCacheResponse(key, source, res, gen, ANON_EVENTS_TTL_MS, EVENTS_CC, now);

  beforeEach(() => __resetAnonEventCacheForTests());

  it("returns null on a miss", () => {
    expect(readAnonCacheResponse("k", source)).toBeNull();
  });

  it("serves a hit as exact HTML with status, body, vary and remaining TTL", async () => {
    await settle("k", html("<p>hi</p>", EVENTS_CC));
    const hit = readAnonCacheResponse("k", source, 1_000_000 + 45_500);
    expect(hit?.status).toBe(200);
    expect(hit?.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    expect(hit?.headers.get("cache-control")).toBe("public, max-age=15");
    expect(hit?.headers.get("vary")).toBe("Cookie");
    expect(await hit?.text()).toBe("<p>hi</p>");
    expect(readAnonCacheResponse("k", source, 1_000_000 + ANON_EVENTS_TTL_MS)).toBeNull();
  });

  it("omits vary when the settled response had none", async () => {
    await settle("k", html("x", EVENTS_CC, null));
    const hit = readAnonCacheResponse("k", source, 1_000_000);
    expect(hit?.headers.has("vary")).toBe(false);
  });

  it("uses the route's fallback cache-control only when the response has none", async () => {
    const gen = anonCacheGeneration();
    const now = 5_000;
    await settle("e", html("e", null), gen, now);
    await settleAnonCacheResponse(
      "p",
      source,
      html("p", null),
      gen,
      ANON_PAST_TTL_MS,
      PAST_CC,
      now,
    );
    await settle("c", html("c", "public, max-age=30, s-maxage=30"), gen, now);
    expect(readAnonCacheResponse("e", source, now)?.headers.get("cache-control")).toBe(EVENTS_CC);
    expect(readAnonCacheResponse("p", source, now)?.headers.get("cache-control")).toBe(PAST_CC);
    expect(readAnonCacheResponse("c", source, now)?.headers.get("cache-control")).toBe(
      "public, max-age=60, s-maxage=30",
    );
  });

  it("isolates sources and clears on retire", async () => {
    await settle("k", html("x", EVENTS_CC));
    expect(readAnonCacheResponse("k", other, 1_000_000)).toBeNull();
    expect(readAnonCacheResponse("k", source, 1_000_000)).not.toBeNull();
    retireAnonEventCaches();
    expect(readAnonCacheResponse("k", source, 1_000_000)).toBeNull();
  });

  it("drops bytes when a retire lands during body buffering, leaving the original readable", async () => {
    const response = html("stale", EVENTS_CC);
    const settling = settle("k", response);
    retireAnonEventCaches(); // before the clone's text() resolves
    await settling;
    expect(readAnonCacheResponse("k", source, 1_000_000)).toBeNull();
    expect(await response.text()).toBe("stale");
  });

  it("does not consume the original response on a successful settle", async () => {
    const response = html("fresh", EVENTS_CC);
    await settle("k", response);
    expect(await response.text()).toBe("fresh");
    expect(await readAnonCacheResponse("k", source, 1_000_000)?.text()).toBe("fresh");
  });

  it.each(["events", "past"] as const)(
    "%s dispatch keeps its fallback, injected clock, TTL and cache marker private",
    async (route) => {
      const past = route === "past";
      const ttl = past ? ANON_PAST_TTL_MS : ANON_EVENTS_TTL_MS;
      const marker = past ? "x-two-past-cacheable" : "x-two-events-cacheable";
      const request = new Request(`https://example.test/events${past ? "/past" : ""}`);
      const env = { APP_URL: "https://example.test" } as Env;
      const guard = vi.fn(async () => null);
      const resolve = vi.fn(async () => new Response("html", { headers: { [marker]: "true" } }));
      const dispatch = (now: number) =>
        past
          ? dispatchPastArchiveRequest(request, env, resolve, guard, now)
          : dispatchEventsRequest(request, env, resolve, { guard, now });
      const first = await dispatch(1000);
      const hit = await dispatch(2000);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(hit.headers.get("cache-control")).toBe(`public, max-age=${ttl / 1000 - 1}`);
      expect(hit.headers.get("content-type")).toBe("text/html; charset=UTF-8");
      expect(first.headers.has(marker)).toBe(false);
      expect(hit.headers.has(marker)).toBe(false);
      expect(await first.text()).toBe("html");
      expect(await hit.text()).toBe("html");
      await dispatch(1000 + ttl);
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(guard).toHaveBeenCalledTimes(3);
    },
  );

  it("propagates a body stream error and stores no entry", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("body failed"));
      },
    });
    const response = new Response(body, { headers: { "cache-control": EVENTS_CC } });
    await expect(settle("k", response)).rejects.toThrow("body failed");
    expect(readAnonCacheResponse("k", source, 1_000_000)).toBeNull();
  });
});
