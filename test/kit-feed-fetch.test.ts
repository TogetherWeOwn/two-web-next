import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { fetchKitFeed, type FeedRead } from "../src/events/kit-feed-fetch";
import { getEventRow, listFeed } from "../src/events/reads";
import { checkJoinThrottle } from "../src/join/service";
import { createMemorySessionStore } from "../src/sessions";
import { fetchAppPath } from "./helpers/fetch-app";
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

const IP = "192.0.2.44";
const REQUEST_ID = "0123456789abcdef-IAD";
const NOW = new Date("2026-07-15T19:00:00Z");
const GAME = "Échecs & co.";
const TITLE = "Chess ♟ & friends";
const row = calendarRow({ title: TITLE, game: GAME });
const draft = calendarRow({ title: "Unannounced chess night", status: "draft" });
const rss = { kind: "rss" } satisfies FeedRead;
const calendar = { kind: "calendar" } satisfies FeedRead;
const detail = { kind: "event-calendar", key: KEY } satisfies FeedRead;
const detailPath = `/events/${KEY}.ics`;
const representations = [
  { path: "/events.rss", feed: rss, marker: "Chess ♟ &amp; friends", cache: "public" },
  {
    path: "/events.ics?game=%20%C3%89checs+%26+co.%20",
    feed: calendar,
    marker: `SUMMARY:${TITLE}\r\n`,
    cache: "public",
  },
  { path: detailPath, feed: detail, marker: `SUMMARY:${TITLE}\r\n`, cache: "private" },
] as const;

type Options = { method?: "GET" | "HEAD"; actor?: typeof MEMBER; validator?: string };

function fixture(options: { noDb?: boolean; sessionOutage?: boolean } = {}) {
  const db = new Proxy({} as Db, {
    get: (_, key) => {
      if (key === "then") return undefined;
      throw new Error("Feed parity fixtures must not query a database");
    },
  });
  const throttleStore = async () => null;
  const sides = (["mounted", "candidate"] as const).map((side) => {
    const store = createMemorySessionStore();
    const get = vi.spyOn(store, "get");
    const rotate = vi.spyOn(store, "rotate");
    if (options.sessionOutage) rotate.mockRejectedValue(new Error("synthetic session outage"));
    const env = {
      ...baseEnv,
      SESSION_STORE: store,
      ADMIN_DB: options.noDb ? undefined : db,
      THROTTLE_STORE: throttleStore,
    } as Env;
    return { side, env, store, get, rotate };
  });

  async function compare(path: string, feed: FeedRead, options: Options = {}) {
    const { method = "GET", actor, validator } = options;
    const results = [];
    for (const { side, env, store } of sides) {
      const headers = new Headers({
        accept: "application/json",
        "cf-connecting-ip": IP,
        "cf-ray": REQUEST_ID,
      });
      if (actor) headers.set("cookie", await cookieFor(store, actor));
      if (validator !== undefined) headers.set("if-none-match", validator);
      vi.mocked(checkJoinThrottle).mockClear();
      const response =
        side === "mounted"
          ? await fetchAppPath(path, { method, headers }, env)
          : await fetchKitFeed(
              new Request(new URL(path, env.APP_URL), { method, headers }),
              env,
              feed,
              REQUEST_ID,
            );
      if (!response) throw new Error(`${side} refused the fixture's matched feed request`);
      expect(checkJoinThrottle).toHaveBeenCalledExactlyOnceWith(null, `events-read:${IP}`, 60);
      const body = Buffer.from(await response.arrayBuffer());
      results.push({ response, body });
    }
    const [mounted, candidate] = results;
    if (!mounted || !candidate) throw new Error("Missing feed fixture response");
    expect(candidate.response.status).toBe(mounted.response.status);
    expect(candidate.body).toEqual(mounted.body);
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
    ]) {
      expect(candidate.response.headers.get(name), name).toBe(mounted.response.headers.get(name));
    }
    // Rotation mints fresh opaque values independently for each session store.
    const cookieShape = (res: Response) =>
      res.headers.getSetCookie().map((cookie) => cookie.replace(/=[^;]+/, "=<opaque>"));
    const cookies = cookieShape(candidate.response);
    expect(cookies).toEqual(cookieShape(mounted.response));
    return { response: candidate.response, body: candidate.body, cookies };
  }

  const expectSessionCalls = (reads: number, rotations: number) => {
    for (const { get, rotate } of sides) {
      expect(get).toHaveBeenCalledTimes(reads);
      expect(rotate).toHaveBeenCalledTimes(rotations);
    }
  };

  return { compare, expectSessionCalls };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.mocked(checkJoinThrottle).mockResolvedValue({ limited: false });
  vi.mocked(getEventRow).mockResolvedValue(row);
  vi.mocked(listFeed).mockResolvedValue([
    row,
    calendarRow({
      id: 2,
      eventKey: OTHER_KEY,
      title: "Cancelled game",
      status: "cancelled",
      game: GAME,
    }),
  ]);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected outbound request")));
});

afterEach(() => {
  vi.useRealTimers();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("detached Kit feed parity with the mounted Hono reads", () => {
  it.each(representations)(
    "$path keeps GET bytes, HEAD headers and strong conditional validators",
    async ({ path, feed, marker, cache }) => {
      const f = fixture();
      const get = await f.compare(path, feed, { actor: MODERATOR });
      expect(get.response.status).toBe(200);
      expect(get.body.toString()).toContain(marker);
      expect(get.body.toString()).not.toContain(draft.title);
      expect(get.cookies).toEqual([]);
      const etag = `"${createHash("sha256").update(get.body).digest("hex")}"`;
      expect(get.response.headers.get("etag")).toBe(etag);
      expect(get.response.headers.get("cache-control")).toBe(`max-age=300, ${cache}`);

      const head = await f.compare(path, feed, { method: "HEAD", actor: MODERATOR });
      expect(head.response.status).toBe(200);
      expect(head.body).toHaveLength(0);
      for (const name of ["content-type", "content-disposition", "etag", "cache-control"])
        expect(head.response.headers.get(name)).toBe(get.response.headers.get(name));

      const unchanged = await f.compare(path, feed, { validator: etag });
      const weak = await f.compare(path, feed, { method: "HEAD", validator: `"stale", W/${etag}` });
      for (const { response, body, cookies } of [unchanged, weak]) {
        expect(response.status).toBe(304);
        expect(body).toHaveLength(0);
        expect(response.headers.get("etag")).toBe(etag);
        expect(response.headers.get("cache-control")).toBe(`max-age=300, ${cache}`);
        expect(response.headers.get("content-type")).toBeNull();
        expect(response.headers.get("content-disposition")).toBeNull();
        expect(cookies).toEqual([]);
      }
      f.expectSessionCalls(0, 0);
      if (feed.kind === "event-calendar") {
        expect(getEventRow).toHaveBeenCalledTimes(8);
        expect(getEventRow).toHaveBeenCalledWith(expect.anything(), KEY);
        expect(listFeed).not.toHaveBeenCalled();
      } else {
        expect(get.body.toString()).toContain("Cancelled game");
        expect(getEventRow).not.toHaveBeenCalled();
        expect(listFeed).toHaveBeenCalledTimes(8);
        const scope = feed.kind === "calendar" ? [NOW, GAME] : [];
        expect(listFeed).toHaveBeenCalledWith(
          expect.anything(),
          ["published", "cancelled"],
          ...scope,
        );
      }
    },
  );

  it("checks the live draft session before conditional success and delivers renewals", async () => {
    vi.mocked(getEventRow).mockResolvedValue(draft);
    const f = fixture();
    const get = await f.compare(detailPath, detail, { actor: MODERATOR });
    expect(get.response.status).toBe(200);
    expect(get.body.toString()).toContain(draft.title);
    const etag = get.response.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const head = await f.compare(detailPath, detail, { method: "HEAD", actor: MODERATOR });
    expect(head.response.status).toBe(200);
    expect(head.body).toHaveLength(0);

    const unchanged = await f.compare(detailPath, detail, {
      method: "HEAD",
      actor: MODERATOR,
      validator: etag,
    });
    expect(unchanged.response.status).toBe(304);
    expect(unchanged.body).toHaveLength(0);
    for (const { cookies } of [get, head, unchanged]) {
      expect(cookies.map((cookie) => cookie.split("=")[0])).toEqual([
        "__Host-two_session_status",
        "__Host-two_session",
      ]);
    }
    f.expectSessionCalls(3, 3);

    const guest = await f.compare(detailPath, detail, { validator: etag });
    const member = await f.compare(detailPath, detail, {
      method: "HEAD",
      actor: MEMBER,
      validator: etag,
    });
    for (const { response, body } of [guest, member]) {
      expect(response.status).toBe(403);
      expect(response.headers.get("etag")).toBeNull();
      expect(response.headers.get("content-disposition")).toBeNull();
      expect(body.toString()).not.toContain(draft.title);
    }
    expect(guest.body.toString()).toBe("Forbidden");
    expect(member.body).toHaveLength(0);
    f.expectSessionCalls(4, 4);
    expect(getEventRow).toHaveBeenCalledTimes(10);
  });

  it("preserves the draft session-outage refusal under a wildcard", async () => {
    vi.mocked(getEventRow).mockResolvedValue(draft);
    const f = fixture({ sessionOutage: true });
    const result = await f.compare(detailPath, detail, { actor: MODERATOR, validator: "*" });
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("etag")).toBeNull();
    expect(result.body.toString()).toContain('"error":"db_unavailable"');
    expect(result.body.toString()).not.toContain(draft.title);
    expect(result.cookies).toEqual([]);
    f.expectSessionCalls(1, 1);
  });

  it("refuses invalid scope before reads and preserves admission precedence", async () => {
    const f = fixture();
    const invalidPath = "/events.ics?game=%00";
    const invalid = await f.compare(invalidPath, calendar, { validator: "*" });
    expect(invalid.response.status).toBe(400);
    expect(invalid.response.headers.get("etag")).toBeNull();
    expect(invalid.body.toString()).toBe("Invalid game filter.");

    vi.mocked(checkJoinThrottle).mockResolvedValue({ limited: true, retryAfter: 42 });
    for (const { path, feed } of [...representations, { path: invalidPath, feed: calendar }]) {
      const limited = await f.compare(path, feed, { actor: MODERATOR, validator: "*" });
      expect(limited.response.status).toBe(429);
      expect(limited.response.headers.get("retry-after")).toBe("42");
      expect(limited.response.headers.get("etag")).toBeNull();
      expect(limited.body.toString()).toBe("Too many requests");
    }
    expect(listFeed).not.toHaveBeenCalled();
    expect(getEventRow).not.toHaveBeenCalled();
    f.expectSessionCalls(0, 0);
  });

  it("preserves the canonical redirect and branded refusal for matched detail paths", async () => {
    const f = fixture();
    const key = KEY.toLowerCase();
    const query = "?tag=a%2Fb&tag=c+d&empty=";
    const redirect = await f.compare(
      `/events/${key}.ics${query}`,
      { kind: "event-calendar", key },
      { method: "HEAD", validator: "*" },
    );
    expect(redirect.response.status).toBe(301);
    expect(redirect.response.headers.get("location")).toBe(detailPath + query);
    expect(redirect.body).toHaveLength(0);

    const missing = await f.compare(`/events/${KEY}/part.ics`, {
      kind: "event-calendar",
      key: `${KEY}/part`,
    });
    expect(missing.response.status).toBe(404);
    expect(missing.response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(missing.body.toString()).toContain('data-testid="error-home"');
    expect(getEventRow).not.toHaveBeenCalled();
    f.expectSessionCalls(0, 0);
  });

  it("keeps negotiated 503s and the dispatch request ID", async () => {
    const noDb = await fixture({ noDb: true }).compare("/events.rss", rss, { validator: "*" });
    expect(noDb.response.status).toBe(503);
    expect(noDb.body.toString()).toContain(`"request_id":"${REQUEST_ID}"`);
    expect(noDb.response.headers.get("etag")).toBeNull();
    expect(listFeed).not.toHaveBeenCalled();

    vi.mocked(listFeed).mockRejectedValue(
      Object.assign(new Error("fixture outage"), {
        code: "ECONNREFUSED",
      }),
    );
    const outage = await fixture().compare("/events.rss", rss);
    expect(outage.response.status).toBe(503);
    expect(outage.body.toString()).toContain('"error":"db_unavailable"');
    expect(outage.body.toString()).not.toContain("fixture outage");
  });

  it("declines an unowned method before admission", async () => {
    const request = new Request(new URL("/events.rss", baseEnv.APP_URL), { method: "POST" });
    expect(await fetchKitFeed(request, baseEnv, rss)).toBeNull();
    expect(checkJoinThrottle).not.toHaveBeenCalled();
    expect(listFeed).not.toHaveBeenCalled();
  });
});
