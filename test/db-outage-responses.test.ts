import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDatabaseUnavailable } from "../src/db/errors";
import { internalErrorHandler } from "../src/errors";
import app from "./app";
import { createMemorySessionStore } from "../src/sessions";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { cookieFor, env, EVENT_KEY, MEMBER, MODERATOR } from "./helpers/member-data";

const EVENT_WRITES = [
  { method: "POST", path: "/events" },
  { method: "PATCH", path: `/events/${EVENT_KEY}` },
  ...["publish", "cancel", "rsvp-pause", "rsvp-reopen"].map((action) => ({ method: "POST", path: `/events/${EVENT_KEY}/${action}` })),
  { method: "PUT", path: `/events/${EVENT_KEY}/rsvp` },
  { method: "DELETE", path: `/events/${EVENT_KEY}/rsvp` },
];

const refused = () => Object.assign(new Error("private connection details"), { code: "ECONNREFUSED" });
const pgError = (code: string) => Object.assign(new Error("private query details"), { name: "PostgresError", code });

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("External HTTP is disabled"));
});
afterEach(() => vi.restoreAllMocks());

describe("narrow database outage classification", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "CONNECT_TIMEOUT", "CONNECTION_CLOSED"])("recognizes transport code %s through a query wrapper", (code) => {
    const cause = Object.assign(new Error("private connection details"), { code });
    expect(isDatabaseUnavailable(new Error("Failed query", { cause }))).toBe(true);
  });
  it.each(["08006", "57P01", "57P03", "53300"])("recognizes Postgres unavailable code %s", (code) => {
    expect(isDatabaseUnavailable(pgError(code))).toBe(true);
  });
  it.each([new TypeError("programming bug"), new Error("ECONNREFUSED in message only"), pgError("42601"), pgError("23505"), pgError("42501")])(
    "does not disguise unrelated errors as maintenance: %s", (error) => {
      expect(isDatabaseUnavailable(error)).toBe(false);
    },
  );
  it("terminates on cyclic causes", () => {
    const error = new Error("cycle");
    error.cause = error;
    expect(isDatabaseUnavailable(error)).toBe(false);
  });
  it.each(["text/html", "application/json"])("negotiates sanitized, non-cacheable 503s for %s", async (accept) => {
    const scratch = new Hono();
    scratch.onError(internalErrorHandler);
    scratch.get("/", () => { throw new Error("query", { cause: refused() }); });
    const res = await scratch.request("/", { headers: { accept } }, env);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain(accept);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("vary")).toContain("Accept");
    const body = await res.text();
    expect(body).not.toMatch(/private|ECONNREFUSED|Failed query/);
    if (accept === "text/html") expect(body).toContain("Together We Own");
    else expect(JSON.parse(body)).toMatchObject({ error: "db_unavailable" });
  });
  it.each([
    { accept: "text/html, application/json;q=0", format: "text/html" },
    { accept: "text/html;q=1, application/json;q=0.1", format: "text/html" },
    { accept: "text/html;q=0.1, application/json;q=1", format: "application/json" },
    { accept: "text/html;q=0, application/json;q=0.5", format: "application/json" },
    { accept: "application/json;q=0, */*;q=1", format: "text/html" },
    { accept: "text/html;q=0, */*;q=1", format: "application/json" },
    { accept: "application/*;q=0.9, text/*;q=0.1", format: "application/json" },
    { accept: "application/json;q=0.1, application/*;q=1, text/html;q=0.5", format: "text/html" },
    { accept: "*/*", format: "text/html" },
    { accept: "text/html, application/json", format: "text/html" },
    { accept: "application/json, text/html", format: "application/json" },
    { accept: "Application/JSON;Q=0.9, text/html;q=0.1", format: "application/json" },
  ])("honors media quality, specificity and preference for $accept", async ({ accept, format }) => {
    const scratch = new Hono();
    scratch.onError(internalErrorHandler);
    scratch.get("/profile", () => { throw refused(); });
    const res = await scratch.request("/profile", { headers: { accept } }, env);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain(format);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("vary")).toContain("Accept");
    const body = await res.text();
    expect(body).not.toMatch(/private|ECONNREFUSED/);
    if (format === "text/html") expect(body).toContain('<a class="brand" href="/">TWO</a>');
    else expect(JSON.parse(body)).toMatchObject({ error: "db_unavailable" });
  });
  it.each(["/events", "/events.json"])("preserves the %s endpoint format for query outages without Accept", async (path) => {
    const scratch = new Hono();
    scratch.onError(internalErrorHandler);
    scratch.get(path, () => { throw new Error("query", { cause: refused() }); });
    const res = await scratch.request(path, {}, env);
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toContain("no-store");
    if (path === "/events.json") {
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(await res.json()).toMatchObject({ error: "db_unavailable" });
    } else {
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("Together We Own");
    }
  });
  it.each([
    { method: "GET", path: "/events" },
    { method: "POST", path: "/admin/events" },
    { method: "POST", path: `/admin/events/${EVENT_KEY}/publish` },
    { method: "POST", path: `/members/${MEMBER.userId}` },
    { method: "GET", path: `/events/${EVENT_KEY}` },
    { method: "GET", path: `/events/${EVENT_KEY}/rsvp` },
    { method: "POST", path: `/events/${EVENT_KEY}` },
    { method: "POST", path: `/events/${EVENT_KEY}/rsvp` },
    { method: "PUT", path: "/events" },
    { method: "POST", path: `/events/${EVENT_KEY}/publish/extra` },
    { method: "POST", path: `/events/${EVENT_KEY}/unknown` },
    { method: "POST", path: "/events.json" },
  ])("does not force JSON for browser routes or unmatched method/path contracts: $method $path", async ({ method, path }) => {
    const scratch = new Hono();
    scratch.onError(internalErrorHandler);
    scratch.on(method, path, () => { throw refused(); });
    const res = await scratch.request(path, { method, headers: { accept: "*/*" } }, env);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Together We Own");
  });
  it.each(EVENT_WRITES)("does not reclassify unrelated event-write errors: $method $path", async ({ method, path }) => {
    for (const error of [new TypeError("private bug"), pgError("42601")]) {
      const scratch = new Hono();
      scratch.onError(internalErrorHandler);
      scratch.on(method, path, () => { throw error; });
      const res = await scratch.request(path, { method }, env);
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("private");
    }
  });
  it("keeps programming and SQL syntax failures at 500", async () => {
    for (const error of [new TypeError("private bug"), pgError("42601")]) {
      const scratch = new Hono();
      scratch.onError(internalErrorHandler);
      scratch.get("/", () => { throw error; });
      const res = await scratch.request("/", {}, env);
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("private");
    }
  });
});

describe("profile failures after a successful session and data read", () => {
  async function fixture() {
    const sessions = createMemorySessionStore();
    const cookie = await cookieFor(sessions, MEMBER);
    const store = createMemoryProfileStore([
      { id: MEMBER.userId, username: MEMBER.username, avatar: null, bio: "private profile fixture", games: [], timezone: null },
    ]);
    const profile = profilesApp({
      sessionStore: sessions, store, throttle: async () => ({ limited: false }),
      accessLog: async () => { throw refused(); },
    });
    return { cookie, store, profile };
  }
  it.each(["text/html", "application/json"])("refuses an unaudited read with a negotiated %s 503, never the finalized profile", async (accept) => {
    const { cookie, profile } = await fixture();
    const res = await profile.request("/profile", { headers: { cookie, accept } }, env);
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain(accept);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.text();
    expect(body).not.toContain("private profile fixture");
    if (accept === "text/html") expect(body).toContain("Together We Own");
    else expect(JSON.parse(body)).toMatchObject({ error: "db_unavailable" });
  });
  it.each(["text/html, application/json;q=0", "text/html;q=1, application/json;q=0.1"])(
    "honors HTML preference when replacing an unaudited profile: %s", async (accept) => {
      const { cookie, profile } = await fixture();
      const res = await profile.request("/profile", { headers: { cookie, accept } }, env);
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("vary")).toContain("Accept");
      const body = await res.text();
      expect(body).not.toContain("private profile fixture");
      expect(body).toContain('<a class="brand" href="/">TWO</a>');
    },
  );
  it.each(["text/html", "application/json"])("classifies a save outage after a successful lookup for %s", async (accept) => {
    const { cookie, store, profile } = await fixture();
    vi.spyOn(store, "save").mockRejectedValue(refused());
    const res = await profile.request(`/members/${MEMBER.userId}`, {
      method: "PATCH", headers: { cookie, accept, origin: env.APP_URL, "content-type": "application/json" },
      body: JSON.stringify({ bio: "new fixture", games: [] }),
    }, env);
    expect(store.save).toHaveBeenCalledOnce();
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain(accept);
    expect(await res.text()).not.toContain("private profile fixture");
  });
});

describe("public session failure boundaries", () => {
  async function fixture() {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MEMBER);
    return { store, cookie, bindings: { ...env, SESSION_STORE: store } };
  }
  it("degrades home to guest without rotating or fabricating identity", async () => {
    const { store, cookie, bindings } = await fixture();
    vi.spyOn(store, "get").mockRejectedValue(refused());
    const rotate = vi.spyOn(store, "rotate");
    const res = await app.request("/", { headers: { cookie } }, bindings);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(MEMBER.username);
    expect(rotate).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toEqual([]);
  });
  it("keeps the invite floor when the DB fails during rotation after a successful session lookup", async () => {
    const { store, cookie, bindings } = await fixture();
    vi.spyOn(store, "rotate").mockRejectedValue(refused());
    const res = await app.request("/", { headers: { cookie } }, bindings);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(MEMBER.username);
    expect(body).toContain('href="/discord" data-testid="discord-join"');
    expect(res.headers.getSetCookie()).toEqual([]);
  });
  it("does not swallow a home programming error", async () => {
    const { store, cookie, bindings } = await fixture();
    vi.spyOn(store, "get").mockRejectedValue(new TypeError("private bug"));
    expect((await app.request("/", { headers: { cookie } }, bindings)).status).toBe(500);
  });
  it.each([refused(), pgError("42501"), new TypeError("private revocation bug")])(
    "clears the browser cookie on failed revocation without claiming the row was revoked: %s", async (error) => {
      const { store, cookie, bindings } = await fixture();
      vi.spyOn(store, "revoke").mockRejectedValue(error);
      const res = await app.request("/logout", { method: "POST", headers: { cookie, origin: env.APP_URL } }, bindings);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/");
      expect(store.revoke).toHaveBeenCalledOnce();
      expect(console.warn).toHaveBeenCalledWith("logout session revocation failed");
      const cleared = res.headers.getSetCookie().join(";");
      for (const flag of ["__Host-two_session=;", "Max-Age=0", "Path=/", "Secure"]) expect(cleared).toContain(flag);
    },
  );
  it.each([undefined, "*/*", "text/html", "application/json", "text/html, application/json;q=0", "text/html;q=1, application/json;q=0.1"])(
    "keeps events.json session outages JSON-only with Accept %s", async (accept) => {
      const { store, cookie, bindings } = await fixture();
      vi.spyOn(store, "get").mockRejectedValue(refused());
      const rotate = vi.spyOn(store, "rotate");
      const res = await app.request("/events.json", { headers: { cookie, ...(accept ? { accept } : {}) } }, bindings);
      expect(store.get).toHaveBeenCalledOnce();
      expect(rotate).not.toHaveBeenCalled();
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toContain("application/json");
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.getSetCookie()).toEqual([]);
      const body = await res.text();
      expect(body).not.toMatch(/private|ECONNREFUSED/);
      expect(JSON.parse(body)).toMatchObject({ error: "db_unavailable" });
    },
  );
  describe.each(EVENT_WRITES)("JSON-only $method $path", ({ method, path }) => {
    it.each([undefined, "*/*", "text/html", "application/json", "text/html, application/json;q=0", "text/html;q=1, application/json;q=0.1"])("keeps pre-handler session outages JSON-only with Accept %s", async (accept) => {
      const store = createMemorySessionStore();
      const cookie = await cookieFor(store, MODERATOR);
      vi.spyOn(store, "get").mockRejectedValue(refused());
      const rotate = vi.spyOn(store, "rotate");
      const res = await app.request(path, {
        method,
        headers: { cookie, origin: env.APP_URL, "content-type": "application/json", ...(accept ? { accept } : {}) },
        body: JSON.stringify({ status: "going" }),
      }, { ...env, SESSION_STORE: store });
      expect(store.get).toHaveBeenCalledOnce();
      expect(rotate).not.toHaveBeenCalled();
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("vary")).toContain("Accept");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(res.headers.get("content-type")).toContain("application/json");
      const body = await res.text();
      expect(body).not.toMatch(/private|ECONNREFUSED/);
      expect(JSON.parse(body)).toMatchObject({ error: "db_unavailable" });
    });
  });
  it("refuses cross-origin logout before revocation or cookie changes", async () => {
    const { store, cookie, bindings } = await fixture();
    const revoke = vi.spyOn(store, "revoke");
    const res = await app.request("/logout", { method: "POST", headers: { cookie, origin: "https://other.example.test" } }, bindings);
    expect(res.status).toBe(403);
    expect(revoke).not.toHaveBeenCalled();
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
