import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDatabaseUnavailable } from "../src/db/errors";
import { internalErrorHandler } from "../src/errors";
import app from "../src/index";
import { createMemorySessionStore } from "../src/sessions";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { cookieFor, env, MEMBER } from "./helpers/member-data";

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
  it.each([new TypeError("programming bug"), new Error("ECONNREFUSED in message only"), pgError("42601"), pgError("23505")])(
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
  it("clears the browser cookie on failed DB revocation without claiming the row was revoked", async () => {
    const { store, cookie, bindings } = await fixture();
    vi.spyOn(store, "revoke").mockRejectedValue(refused());
    const res = await app.request("/logout", { method: "POST", headers: { cookie, origin: env.APP_URL } }, bindings);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(store.revoke).toHaveBeenCalledOnce();
    const cleared = res.headers.getSetCookie().join(";");
    for (const flag of ["__Host-two_session=;", "Max-Age=0", "Path=/", "Secure"]) expect(cleared).toContain(flag);
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
