// Missing route-level read cases at Hono base 10099ce45e7f6a4f1ade945bbbca85278982109e.
// Existing serializer, GET access and collection-validator suites own those cases.
// Real mounted app/middleware/session code; only event reads are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { getEventRow, getPublicEvent, listFeed, listJson } from "../src/events/reads";
import { waitlistPosition } from "../src/events/waitlist";
import { createMemorySessionStore } from "../src/sessions";
import * as throttle from "../src/throttle";
import app from "./app";
import { calendarRow, KEY } from "./helpers/ics-wire-fixture";
import { cookieFor, env as baseEnv, MEMBER, MODERATOR } from "./helpers/member-data";

vi.mock("../src/events/reads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/reads")>()),
  getEventRow: vi.fn(),
  getPublicEvent: vi.fn(),
  listFeed: vi.fn(),
  listJson: vi.fn(),
}));
vi.mock("../src/events/waitlist", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/waitlist")>()),
  waitlistPosition: vi.fn(),
}));

const ICS_PATH = `/events/${KEY}.ics`;
const JSON_PATH = `/events/${KEY}`;
const row = calendarRow();
const publicRow = { ...row, goingCount: 0, goingOccupancy: 0 };
type Actor = "guest" | "member" | "moderator";

function fixture() {
  const store = createMemorySessionStore();
  const rotate = vi.spyOn(store, "rotate");
  const get = vi.spyOn(store, "get");
  const env = {
    ...baseEnv,
    SESSION_STORE: store,
    ADMIN_DB: new Proxy({} as Db, {
      get: (_, key) => {
        if (key === "then") return undefined;
        throw new Error("Contract fixture must not query a database");
      },
    }),
  } as Env;
  return {
    rotate,
    get,
    async request(path: string, method = "GET", actor: Actor = "guest", validator?: string) {
      const headers = new Headers({ accept: "application/json" });
      if (actor !== "guest")
        headers.set("cookie", await cookieFor(store, actor === "moderator" ? MODERATOR : MEMBER));
      if (validator !== undefined) headers.set("if-none-match", validator);
      return app.request(path, { method, headers }, env);
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-15T19:00:00Z"));
  vi.mocked(getEventRow).mockResolvedValue(row);
  vi.mocked(getPublicEvent).mockResolvedValue(publicRow);
  vi.mocked(listFeed).mockResolvedValue([row]);
  vi.mocked(listJson).mockResolvedValue({ rows: [publicRow], total: 1, page: 1 });
  vi.mocked(waitlistPosition).mockResolvedValue(null);
  vi.spyOn(throttle, "throttleGuard");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function expectHardened(response: Response) {
  expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-request-id")).toBeTruthy();
}

function expectNoEventReads() {
  expect(listFeed).not.toHaveBeenCalled();
  expect(listJson).not.toHaveBeenCalled();
  expect(getEventRow).not.toHaveBeenCalled();
  expect(getPublicEvent).not.toHaveBeenCalled();
  expect(waitlistPosition).not.toHaveBeenCalled();
}

const representations = [
  {
    path: "/events.rss",
    actor: "guest",
    type: "application/rss+xml; charset=utf-8",
    cache: "max-age=300, public",
    marker: "<rss",
    read: listFeed,
  },
  {
    path: "/events.ics",
    actor: "guest",
    type: "text/calendar; charset=utf-8",
    cache: "max-age=300, public",
    marker: "BEGIN:VCALENDAR",
    read: listFeed,
  },
  {
    path: ICS_PATH,
    actor: "guest",
    type: "text/calendar; charset=utf-8",
    cache: "max-age=300, private",
    marker: "BEGIN:VEVENT",
    read: getEventRow,
  },
  {
    path: "/events.json",
    actor: "member",
    type: "application/json; charset=UTF-8",
    cache: "private, no-cache",
    marker: '"data":[',
    read: listJson,
  },
  {
    path: JSON_PATH,
    actor: "member",
    type: "application/json; charset=UTF-8",
    cache: "private, no-cache",
    marker: '"data":{',
    read: getPublicEvent,
  },
] as const;

describe("Hono feed HEAD representations", () => {
  it.each(representations)(
    "$path keeps GET headers and reads, but sends no body",
    async ({ path, actor, type, cache, marker, read }) => {
      const f = fixture();
      const get = await f.request(path, "GET", actor);
      expect(get.status).toBe(200);
      expect(await get.text()).toContain(marker);
      expect(get.headers.get("content-type")).toBe(type);
      expect(get.headers.get("cache-control")).toBe(cache);
      const head = await f.request(path, "HEAD", actor);
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      for (const header of ["content-type", "cache-control", "etag", "content-disposition", "vary"])
        expect(head.headers.get(header)).toBe(get.headers.get(header));
      expect(head.headers.get("etag")).toMatch(
        path.endsWith(".ics") || path.endsWith(".rss") ? /^"[a-f0-9]{64}"$/ : /^"[a-f0-9]{40}"$/,
      );
      expectHardened(head);
      expect(head.headers.get("set-cookie")).toBeNull();
      expect(read).toHaveBeenCalledTimes(2);
      if (actor === "member") {
        expect(get.headers.get("vary")).toBe("Cookie, Accept");
        expect(f.get).toHaveBeenCalledTimes(2);
      } else expect(f.get).not.toHaveBeenCalled();
      expect(f.rotate).not.toHaveBeenCalled();
    },
  );

  it.each(["/events.rss", "/events.ics", ICS_PATH])(
    "%s HEAD evaluates an exact validator and retains middleware on 304",
    async (path) => {
      const f = fixture();
      const get = await f.request(path);
      expect(get.status).toBe(200);
      const head = await f.request(path, "HEAD", "guest", get.headers.get("etag")!);
      expect(head.status).toBe(304);
      expect(await head.text()).toBe("");
      expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
      expect(head.headers.get("cache-control")).toBe(get.headers.get("cache-control"));
      expect(head.headers.get("content-type")).toBeNull();
      expect(head.headers.get("content-disposition")).toBeNull();
      expect(head.headers.get("set-cookie")).toBeNull();
      expectHardened(head);
      expect(path === ICS_PATH ? getEventRow : listFeed).toHaveBeenCalledTimes(2);
      expect(f.get).not.toHaveBeenCalled();
    },
  );

  it("draft ICS HEAD still authorizes and delivers the rotating moderator session", async () => {
    vi.mocked(getEventRow).mockResolvedValue({ ...row, status: "draft" });
    const f = fixture();
    const response = await f.request(ICS_PATH, "HEAD", "moderator");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${KEY}.ics"`);
    expect(response.headers.get("cache-control")).toBe("max-age=300, private");
    expect(response.headers.get("set-cookie")).toContain("__Host-two_session=");
    expect(getEventRow).toHaveBeenCalledTimes(1);
    expect(f.rotate).toHaveBeenCalledTimes(1);
  });

  it("draft JSON HEAD stays noindex and does not rotate the moderator session", async () => {
    vi.mocked(getPublicEvent).mockResolvedValue({ ...publicRow, status: "draft" });
    const f = fixture();
    const response = await f.request(JSON_PATH, "HEAD", "moderator");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(getPublicEvent).toHaveBeenCalledTimes(1);
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(f.rotate).not.toHaveBeenCalled();
  });

  it.each(["/events.json", JSON_PATH])(
    "%s guest HEAD refuses before event reads, even with a wildcard",
    async (path) => {
      const response = await fixture().request(path, "HEAD", "guest", "*");
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("etag")).toBeNull();
      expectNoEventReads();
    },
  );

  it.each([ICS_PATH, JSON_PATH])(
    "%s draft HEAD cannot become a wildcard 304 for a member",
    async (path) => {
      vi.mocked(getEventRow).mockResolvedValue({ ...row, status: "draft" });
      vi.mocked(getPublicEvent).mockResolvedValue({ ...publicRow, status: "draft" });
      const f = fixture();
      const response = await f.request(path, "HEAD", "member", "*");
      expect(response.status).toBe(403);
      expect(await response.text()).toBe("");
      expect(response.headers.get("etag")).toBeNull();
      expect(path === ICS_PATH ? getEventRow : getPublicEvent).toHaveBeenCalledTimes(1);
      expect(waitlistPosition).not.toHaveBeenCalled();
      expect(f.get).toHaveBeenCalledTimes(1);
    },
  );
});

describe("detail JSON conditional reads", () => {
  it.each([
    { method: "GET", tag: "weak" },
    { method: "GET", tag: "list" },
    { method: "GET", tag: "wildcard" },
    { method: "HEAD", tag: "exact" },
    { method: "HEAD", tag: "weak" },
    { method: "HEAD", tag: "list" },
    { method: "HEAD", tag: "wildcard" },
  ])(
    "$method $tag validator gives a private 304 after the non-rotating read",
    async ({ method, tag }) => {
      const f = fixture();
      const first = await f.request(JSON_PATH, "GET", "member");
      expect(first.status).toBe(200);
      const etag = first.headers.get("etag")!;
      const validators: Record<string, string> = {
        exact: etag,
        weak: `W/${etag}`,
        list: `"stale", W/${etag}`,
        wildcard: "*",
      };
      const response = await f.request(JSON_PATH, method, "member", validators[tag]);
      expect(response.status).toBe(304);
      expect(await response.text()).toBe("");
      expect(response.headers.get("etag")).toBe(etag);
      expect(response.headers.get("cache-control")).toBe("private, no-cache");
      expect(response.headers.get("vary")).toBe("Cookie, Accept");
      expect(response.headers.get("content-type")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      expectHardened(response);
      expect(getPublicEvent).toHaveBeenCalledTimes(2);
      expect(waitlistPosition).toHaveBeenCalledTimes(2);
      expect(f.get).toHaveBeenCalledTimes(2);
      expect(f.rotate).not.toHaveBeenCalled();
    },
  );

  it.each(["GET", "HEAD"])(
    "cancelled %s retains the private refusal instead of a wildcard 304",
    async (method) => {
      vi.mocked(getPublicEvent).mockResolvedValue({ ...publicRow, status: "cancelled" });
      const response = await fixture().request(JSON_PATH, method, "member", "*");
      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("vary")).toBe("Cookie, Accept");
      expect(response.headers.get("etag")).toBeNull();
      expect(response.headers.get("content-type")).toBe("application/json");
      if (method === "HEAD") expect(await response.text()).toBe("");
      else
        expect(await response.json()).toEqual({
          reason: "event_cancelled",
          message: "This event was cancelled.",
          event_key: KEY,
          status: "cancelled",
        });
      expect(getPublicEvent).toHaveBeenCalledTimes(1);
      expect(waitlistPosition).not.toHaveBeenCalled();
    },
  );
});

describe("feed path and refusal dispatch", () => {
  it.each(["GET", "HEAD"])(
    "%s canonical detail redirect preserves the raw query before session/event reads",
    async (method) => {
      const f = fixture();
      const query = "?tag=a%2Fb&tag=c+d&empty=";
      const response = await f.request(
        `/events/${KEY.toLowerCase()}${query}`,
        method,
        "member",
        "*",
      );
      expect(response.status).toBe(301);
      expect(response.headers.get("location")).toBe(`${JSON_PATH}${query}`);
      expect(await response.text()).toBe("");
      expect(f.get).not.toHaveBeenCalled();
      expectNoEventReads();
    },
  );

  it.each(["GET", "HEAD"])(
    "%s multi-segment ICS reaches the feed guard, not JSON or the global 404",
    async (method) => {
      const f = fixture();
      const response = await f.request(`/events/${KEY}/part.ics`, method, "member", "*");
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("etag")).toBeNull();
      if (method === "HEAD") expect(await response.text()).toBe("");
      else expect(await response.text()).toContain('data-testid="error-home"');
      expect(throttle.throttleGuard).toHaveBeenCalledWith(expect.anything(), "events-read", 60);
      expect(f.get).not.toHaveBeenCalled();
      expectNoEventReads();
    },
  );

  it("an empty ICS stem falls through to the session-gated JSON detail registration", async () => {
    const f = fixture();
    const response = await f.request("/events/.ics", "GET", "member", "*");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(f.get).toHaveBeenCalledTimes(1);
    expectNoEventReads();
  });

  it.each(
    ["/events.rss/", "/events.ics/", "/events.json/", `${JSON_PATH}/`].flatMap((path) =>
      ["GET", "HEAD"].map((method) => ({ path, method })),
    ),
  )("$method $path stays a branded 404 outside the feed handlers", async ({ path, method }) => {
    const f = fixture();
    const response = await f.request(path, method, "member", "*");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    if (method === "HEAD") expect(await response.text()).toBe("");
    else expect(await response.text()).toContain('data-testid="error-home"');
    expect(throttle.throttleGuard).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
    expectNoEventReads();
  });

  it.each(["GET", "HEAD"])(
    "%s invalid game scope is the exact no-store text refusal even with a wildcard",
    async (method) => {
      const response = await fixture().request("/events.ics?game=%00", method, "guest", "*");
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
      expect(response.headers.get("etag")).toBeNull();
      expect(await response.text()).toBe(method === "HEAD" ? "" : "Invalid game filter.");
      expectNoEventReads();
    },
  );
});
