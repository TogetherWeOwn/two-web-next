import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import { fetchKitFeed, type FeedRead } from "../src/events/kit-feed-fetch";
import { getEventRow, listFeed } from "../src/events/reads";
import { checkJoinThrottle } from "../src/join/service";
import { SESSION_COOKIE } from "../src/session-cookie";
import { createMemorySessionStore } from "../src/sessions";
import { fetchApp } from "./helpers/fetch-app";
import { calendarRow, KEY, OTHER_KEY } from "./helpers/ics-wire-fixture";
import { cookieFor, env as baseEnv, MEMBER, MODERATOR } from "./helpers/member-data";

vi.mock("../src/events/reads", async (original) => ({
  ...(await original<typeof import("../src/events/reads")>()),
  getEventRow: vi.fn(),
  listFeed: vi.fn(),
}));
vi.mock("../src/join/service", async (original) => ({
  ...(await original<typeof import("../src/join/service")>()),
  checkJoinThrottle: vi.fn(),
}));

const NOW = new Date("2026-07-15T19:00:00Z");
const IP = "192.0.2.44";
const REQUEST_ID = "0123456789abcdef-IAD";
const GAME = "Échecs & co.";
const row = calendarRow({ title: "Chess ♟ & friends", game: GAME });
const draft = calendarRow({ title: "Unannounced chess night", status: "draft" });
const rss = { kind: "rss" } satisfies FeedRead;
const calendar = { kind: "calendar" } satisfies FeedRead;
const detail = { kind: "event-calendar", key: KEY } satisfies FeedRead;
const detailPath = `/events/${KEY}.ics`;
const results = [
  { path: "/events.rss", feed: rss, marker: "Chess ♟ &amp; friends", cache: "public" },
  {
    path: "/events.ics?game=%20%C3%89checs+%26+co.%20",
    feed: calendar,
    marker: `SUMMARY:${row.title}\r\n`,
    cache: "public",
  },
  { path: detailPath, feed: detail, marker: `SUMMARY:${row.title}\r\n`, cache: "private" },
] as const;

type Actor = typeof MEMBER | "renewed";
type ReadOptions = { method?: "GET" | "HEAD"; actor?: Actor; validator?: string };

function fixture() {
  const sides = (["mounted", "candidate"] as const).map((side) => {
    const store = createMemorySessionStore();
    const get = vi.spyOn(store, "get");
    const rotate = vi.spyOn(store, "rotate");
    const env = {
      ...baseEnv,
      SESSION_STORE: store,
      ADMIN_DB: {} as Db,
      THROTTLE_STORE: async () => null,
    };
    return { side, env, store, get, rotate, renewal: "" };
  });

  async function compare(
    path: string,
    feed: FeedRead,
    { method = "GET", actor, validator }: ReadOptions = {},
  ) {
    const snapshots = [];
    for (const fixtureSide of sides) {
      const { side, env, store, renewal } = fixtureSide;
      const headers = new Headers({
        accept: "application/json",
        "cf-connecting-ip": IP,
        "cf-ray": REQUEST_ID,
      });
      if (actor === "renewed") {
        if (!renewal) throw new Error(`${side} did not issue a renewal`);
        headers.set("cookie", renewal);
      } else if (actor) headers.set("cookie", await cookieFor(store, actor));
      if (validator !== undefined) headers.set("if-none-match", validator);
      const request = new Request(new URL(path, env.APP_URL), { method, headers });
      const admit = vi.mocked(checkJoinThrottle).mockClear();
      const response =
        side === "mounted"
          ? await fetchApp(request, env)
          : await fetchKitFeed(request, env, feed, REQUEST_ID);
      if (!response) throw new Error(`${side} declined a matched feed request`);
      expect(admit).toHaveBeenCalledExactlyOnceWith(null, `events-read:${IP}`, 60);
      // Stores mint independent opaque renewal values.
      const setCookies = response.headers.getSetCookie();
      fixtureSide.renewal =
        setCookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))?.split(";", 1)[0] ??
        "";
      const cookies = setCookies.map((cookie) => cookie.replace(/=[^;]+/, "=<opaque>"));
      snapshots.push({
        status: response.status,
        headers: response.headers,
        cookies,
        bytes: Buffer.from(await response.arrayBuffer()),
      });
    }
    const [mounted, candidate] = snapshots;
    if (!mounted || !candidate) throw new Error("Missing parity fixture response");
    expect(candidate.status).toBe(mounted.status);
    expect(candidate.bytes).toEqual(mounted.bytes);
    expect(candidate.cookies).toEqual(mounted.cookies);
    for (const name of [
      "content-type",
      "content-disposition",
      "etag",
      "cache-control",
      "location",
      "retry-after",
      "vary",
      "x-robots-tag",
      "access-control-allow-origin",
    ])
      expect(candidate.headers.get(name), name).toBe(mounted.headers.get(name));
    return candidate;
  }

  return { compare, sides };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(checkJoinThrottle).mockResolvedValue({ limited: false });
  vi.mocked(getEventRow).mockResolvedValue(row);
  vi.mocked(listFeed).mockResolvedValue([
    row,
    calendarRow({ id: 2, eventKey: OTHER_KEY, title: "Cancelled game", status: "cancelled" }),
  ]);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected outbound request")));
});

afterEach(() => {
  vi.useRealTimers();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(results)(
  "$path keeps GET bytes, HEAD and conditional headers",
  async ({ path, feed, marker, cache }) => {
    const { compare, sides } = fixture();
    const get = await compare(path, feed, { actor: MODERATOR });
    expect(get.status).toBe(200);
    expect(get.bytes.toString()).toContain(marker);
    expect(get.cookies).toEqual([]);
    const etag = `"${createHash("sha256").update(get.bytes).digest("hex")}"`;
    expect(get.headers.get("etag")).toBe(etag);
    expect(get.headers.get("cache-control")).toBe(`max-age=300, ${cache}`);
    const head = await compare(path, feed, { method: "HEAD", actor: MODERATOR });
    expect(head.status).toBe(200);
    expect(head.bytes).toHaveLength(0);
    for (const name of ["content-type", "content-disposition", "etag", "cache-control"])
      expect(head.headers.get(name)).toBe(get.headers.get(name));

    for (const response of [
      await compare(path, feed, { validator: etag }),
      await compare(path, feed, { method: "HEAD", validator: `"stale", W/${etag}` }),
    ]) {
      expect(response.status).toBe(304);
      expect(response.bytes).toHaveLength(0);
      expect(response.headers.get("etag")).toBe(etag);
      expect(response.headers.get("cache-control")).toBe(get.headers.get("cache-control"));
      expect(response.headers.get("content-type")).toBeNull();
      expect(response.cookies).toEqual([]);
    }
    for (const { get } of sides) expect(get).not.toHaveBeenCalled();
    if (feed.kind !== "event-calendar") {
      expect(get.bytes.toString()).toContain("Cancelled game");
      const scope = feed.kind === "calendar" ? [NOW, GAME] : [];
      expect(listFeed).toHaveBeenCalledWith(
        expect.anything(),
        ["published", "cancelled"],
        ...scope,
      );
    }
  },
);

it("checks draft visibility before a matching conditional and delivers renewals", async () => {
  vi.mocked(getEventRow).mockResolvedValue(draft);
  const { compare, sides } = fixture();
  const get = await compare(detailPath, detail, { actor: MODERATOR });
  expect(get.status).toBe(200);
  expect(get.bytes.toString()).toContain(draft.title);
  const validator = get.headers.get("etag")!;
  const head = await compare(detailPath, detail, { method: "HEAD", actor: "renewed", validator });
  expect(head.status).toBe(304);
  expect(head.bytes).toHaveLength(0);
  expect((await compare(detailPath, detail, { actor: "renewed" })).status).toBe(200);
  for (const { cookies } of [get, head]) {
    expect(cookies.map((cookie) => cookie.split("=")[0])).toEqual([
      "__Host-two_session_status",
      "__Host-two_session",
    ]);
  }
  for (const { get, rotate } of sides) {
    expect(get).toHaveBeenCalledTimes(3);
    expect(rotate).toHaveBeenCalledTimes(3);
  }
  for (const actor of [undefined, MEMBER]) {
    const refused = await compare(detailPath, detail, { actor, validator });
    expect(refused.status).toBe(403);
    expect(refused.headers.get("etag")).toBeNull();
    expect(refused.bytes.toString()).toBe("Forbidden");
  }
});

it("refuses invalid scope and admits each matching feed once before any lookup", async () => {
  const { compare, sides } = fixture();
  const path = "/events.ics?game=%00";
  const invalid = await compare(path, calendar, { validator: "*" });
  expect(invalid.status).toBe(400);
  expect(invalid.bytes.toString()).toBe("Invalid game filter.");
  vi.mocked(checkJoinThrottle).mockResolvedValue({ limited: true, retryAfter: 42 });
  for (const entry of [...results, { path, feed: calendar }]) {
    const limited = await compare(entry.path, entry.feed, { actor: MODERATOR, validator: "*" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("42");
    expect(limited.bytes.toString()).toBe("Too many requests");
  }
  expect(getEventRow).not.toHaveBeenCalled();
  expect(listFeed).not.toHaveBeenCalled();
  for (const { get } of sides) expect(get).not.toHaveBeenCalled();
});

it("keeps the branded refusal for a matched multisegment detail path", async () => {
  const { compare } = fixture();
  const malformed = await compare(`/events/${KEY}/part.ics`, { ...detail, key: `${KEY}/part` });
  expect(malformed.status).toBe(404);
  expect(malformed.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  expect(getEventRow).not.toHaveBeenCalled();
});

it("preserves a classified read outage and declines an unowned method", async () => {
  vi.mocked(listFeed).mockRejectedValue(
    Object.assign(new Error("fixture outage"), { code: "ECONNREFUSED" }),
  );
  const outage = await fixture().compare("/events.rss", rss);
  expect(outage.status).toBe(503);
  expect(outage.bytes.toString()).toContain(`"request_id":"${REQUEST_ID}"`);
  vi.mocked(listFeed).mockClear();
  vi.mocked(checkJoinThrottle).mockClear();
  const request = new Request(new URL("/events.rss", baseEnv.APP_URL), { method: "POST" });
  expect(await fetchKitFeed(request, baseEnv, rss)).toBeNull();
  expect(checkJoinThrottle).not.toHaveBeenCalled();
  expect(listFeed).not.toHaveBeenCalled();
});

it.each([
  ["/events.ics", calendar, "/events.ics"],
  ["/events.rss", rss, "/events.rss"],
  [detailPath, detail, "/events/:file{.+\\.ics}"],
] as const)(
  "correlates a detached %s alert without logging request data",
  async (path, feed, route) => {
    const alert = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env } = fixture().sides[1]!;
    vi.mocked(feed.kind === "event-calendar" ? getEventRow : listFeed).mockRejectedValue(
      new TypeError("fixture private error message"),
    );
    const request = new Request(new URL(`${path}?game=fixture`, env.APP_URL));
    const response = await fetchKitFeed(request, env, feed, REQUEST_ID);

    expect(response?.status).toBe(500);
    expect(await response?.text()).toContain(REQUEST_ID);
    expect(alert).toHaveBeenCalledTimes(1);
    const line = String(alert.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      event: "error.alert",
      method: "GET",
      route,
      request_id: REQUEST_ID,
    });
    expect(line).not.toContain("game=");
    expect(line).not.toContain(KEY);
    expect(line).not.toContain("fixture private error message");
  },
);
