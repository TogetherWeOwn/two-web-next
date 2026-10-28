import { Hono } from "hono";
import { jsx } from "hono/jsx/jsx-runtime";
import { BadRequestPage } from "../src/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import type { Env } from "../src/env";
import { badRequest, prefersHtmlError, varyAccept } from "../src/errors";
import { profilesApp } from "../src/profiles/routes";
import { requestLog } from "../src/request-log";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";

vi.mock("postgres", () => ({
  default: () => {
    throw new Error("supplemental fixtures must not open a database");
  },
}));

describe("shared malformed-request negotiation", () => {
  it("retains the unsupported-media status in the reused browser shell", async () => {
    const app = new Hono();
    app.get("/", (c) => c.html(jsx(BadRequestPage, { code: "415" }).toString(), 415));
    const response = await app.request("/");
    expect(response.status).toBe(415);
    const html = await response.text();
    expect(html).toContain("Check your request");
    expect(html).toContain('class="recovery-code" aria-hidden="true">415<');
  });
  it.each([
    [undefined, "text/html"],
    ["*/*", "text/html"],
    ["text/html", "text/html"],
    ["application/json;q=0, text/html", "text/html"],
    ["text/html;q=0.9, application/json;q=0.1", "text/html"],
    ["APPLICATION/JSON", "application/json"],
    ["text/html;q=0, application/json", "application/json"],
    ["text/*;q=0.4, application/json;q=0.8", "application/json"],
    ["*/*;q=1, text/html;q=0, application/json;q=0.5", "application/json"],
  ])("Accept %s selects %s and preserves existing Vary", async (accept, type) => {
    const app = new Hono();
    app.post("/form", (c) => {
      c.header("Vary", "Origin, Cookie");
      return badRequest(c);
    });
    const response = await app.request("/form", {
      method: "POST",
      headers: accept ? { accept } : {},
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain(type);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("vary")).toBe("Origin, Cookie, Accept");
    if (type === "application/json") {
      expect(await response.json()).toEqual({
        error: "bad_request",
        message: "Check your request and try again.",
      });
    } else {
      expect(await response.text()).toContain("Check your request");
    }
  });
});

describe("legacy machine errors require an explicit HTML preference", () => {
  it.each(["PATCH", "patch"])("%s event writes stay machine-only", async (method) => {
    const app = new Hono();
    app.all("/events/fixture", (c) => {
      expect(prefersHtmlError(c)).toBe(false);
      return badRequest(c);
    });
    const response = await app.request("/events/fixture", {
      method,
      headers: { accept: "text/html" },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "bad_request",
      message: "Check your request and try again.",
    });
  });
  it.each([
    ["/form", undefined, false],
    ["/form", "*/*", false],
    ["/form", "text/*", false],
    ["/form", "text/html", true],
    ["/form", "TEXT/HTML", true],
    ["/form", "application/json;q=0, text/html", true],
    ["/form", "text/html;q=0.1, application/json;q=0.9", false],
    ["/form", "text/html;q=0, */*", false],
    ["/form", "text/html;q=0", false],
    ["/form", "text/html;q=0, application/json;q=0", false],
    ["/form", "text/plain, text/html;q=0", false],
    ["/api/upload", "text/html", false],
    ["/events", "text/html", false],
    ["/events/fixture/publish", "text/html", false],
    ["/events.ics", "text/html", false],
    ["/events.rss", "text/html", false],
    ["/events.md", "text/html", false],
    ["/llms.txt", "text/html", false],
  ])("%s Accept %s opts into HTML: %s", async (path, accept, html) => {
    const app = new Hono();
    app.post("*", (c) => {
      c.header("Vary", "Cookie, ACCEPT");
      varyAccept(c);
      return c.json({ html: prefersHtmlError(c) });
    });
    const response = await app.request(path!, {
      method: "POST",
      headers: accept ? { accept } : {},
    });
    expect(await response.json()).toEqual({ html });
    expect(response.headers.get("vary")).toBe("Cookie, ACCEPT");
  });
});

describe("supplemental route-level refusal pins", () => {
  const BROWSER = "text/html,application/xhtml+xml";
  const MACHINE = "application/json";
  const PRIVATE = "supplemental fixture private details";

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("fixture must remain offline"))),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function profileRequest(options: {
    contentType: string;
    body: string;
    accept: string;
    saveThrows: boolean;
  }) {
    const sessions = createMemorySessionStore();
    const cookie = await cookieFor(sessions, MEMBER);
    const store = {
      find: vi.fn(async () => ({
        id: MEMBER.userId,
        username: MEMBER.username,
        avatar: null,
        bio: "fixture bio",
        games: [],
        timezone: null,
      })),
      save: vi.fn(async () => {
        if (options.saveThrows) throw new Error(PRIVATE);
      }),
    };
    const mounted = new Hono<{ Bindings: Env }>();
    mounted.use("*", requestLog);
    mounted.route(
      "/",
      profilesApp({ sessionStore: sessions, store, throttle: async () => ({ limited: false }) }),
    );
    const response = await mounted.request(
      `/members/${MEMBER.userId}`,
      {
        method: "PATCH",
        headers: {
          origin: env.APP_URL,
          accept: options.accept,
          cookie,
          "content-type": options.contentType,
        },
        body: options.body,
      },
      env,
    );
    return { response, store };
  }

  async function logoutRequest(accept?: string) {
    const sessions = createMemorySessionStore();
    const cookie = await cookieFor(sessions, MEMBER);
    const revoke = vi.spyOn(sessions, "revoke").mockRejectedValue(new Error(PRIVATE));
    const response = await app.request(
      "/logout",
      {
        method: "POST",
        headers: { origin: env.APP_URL, cookie, ...(accept === undefined ? {} : { accept }) },
      },
      { ...env, SESSION_STORE: sessions } as Env,
    );
    return { response, revoke };
  }

  async function adminRequest(accept: string) {
    const sessions = createMemorySessionStore();
    const cookie = await cookieFor(sessions, MODERATOR);
    const mounted = new Hono<{ Bindings: Env }>();
    mounted.route("/admin", adminApp({ sessionStore: sessions }));
    return mounted.request(
      "/admin/events",
      {
        method: "POST",
        headers: {
          cookie,
          origin: env.APP_URL,
          accept,
          "content-type": "multipart/form-data; boundary=fixture-boundary",
        },
        body: `malformed multipart ${PRIVATE}`,
      },
      { ...env } as Env,
    );
  }

  it("PATCH unsupported media renders the visible 415 through the real route", async () => {
    const { response, store } = await profileRequest({
      contentType: "text/plain",
      body: PRIVATE,
      accept: BROWSER,
      saveThrows: false,
    });
    expect(response.status).toBe(415);
    expect(store.save).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Check your request");
    expect(body).toContain('class="recovery-code" aria-hidden="true">415<');
    expect(body).not.toContain(PRIVATE);
    expect(response.headers.get("vary")).toContain("Accept");
  });

  it("PATCH unsupported media answers the unified JSON envelope with Vary for machine callers", async () => {
    const { response } = await profileRequest({
      contentType: "text/plain",
      body: PRIVATE,
      accept: MACHINE,
      saveThrows: false,
    });
    expect(response.status).toBe(415);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: "unsupported_media_type",
      request_id: expect.any(String),
    });
    expect(response.headers.get("vary")).toContain("Accept");
  });

  it.each([BROWSER, MACHINE])("profile save error merges Vary for %s", async (accept) => {
    const { response } = await profileRequest({
      contentType: "application/json",
      body: '{"bio":"updated","games":[]}',
      accept,
      saveThrows: true,
    });
    expect(response.status).toBe(500);
    expect(response.headers.get("vary")).toContain("Accept");
    if (accept === BROWSER) {
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("Something broke on our side");
    } else {
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toBe("Could not save your profile.");
    }
  });

  it.each([BROWSER, MACHINE])("logout revocation failure merges Vary for %s", async (accept) => {
    const { response, revoke } = await logoutRequest(accept);
    expect(response.status).toBe(503);
    expect(revoke).toHaveBeenCalledOnce();
    expect(response.headers.get("vary")).toContain("Accept");
    if (accept === BROWSER) {
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("We will be right back");
    } else {
      // Intentional pin update: refusal correlation serves the shared
      // JSON envelope (with request_id) instead of legacy plaintext.
      expect(response.headers.get("content-type")).toContain("application/json");
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ error: "db_unavailable" });
      expect(typeof body.request_id).toBe("string");
      expect(JSON.stringify(body)).not.toContain(PRIVATE);
    }
  });

  it.each([[undefined], ["*/*"], ["text/plain"], ["text/html;q=0, application/json;q=0"]])(
    "logout revocation failure keeps the legacy text bytes for Accept %s",
    async (accept) => {
      // Only an explicit JSON preference gets the correlated envelope:
      // absent, wildcard, non-JSON and all-q=0 callers keep the legacy text
      // bytes (main #1491 pins the absent-Accept body byte-exact).
      const { response, revoke } = await logoutRequest(accept);
      expect(response.status).toBe(503);
      expect(revoke).toHaveBeenCalledOnce();
      expect(response.headers.get("vary")).toContain("Accept");
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toBe("Sign-out temporarily unavailable");
    },
  );

  it("logout revocation failure logs one bounded error without the driver detail", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { response } = await logoutRequest(MACHINE);
    expect(response.status).toBe(503);
    const lines = error.mock.calls.filter(([message]) => message === "logout revocation failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toEqual({
      exception: "Error",
      request_id: response.headers.get("x-request-id"),
    });
    expect(
      warn.mock.calls.filter(([message]) => message === "logout revocation failed"),
    ).toHaveLength(0);
    expect(JSON.stringify(lines)).not.toContain(PRIVATE);
  });

  it.each([BROWSER, MACHINE])("admin no-DB write merges Vary for %s", async (accept) => {
    const response = await adminRequest(accept);
    expect(response.status).toBe(503);
    expect(response.headers.get("vary")).toContain("Accept");
    if (accept === BROWSER) {
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("Back to the dashboard");
    } else {
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toBe("Admin temporarily unavailable");
    }
  });
});
