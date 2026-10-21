// Protected acceptance tests: the paired builder changes production, not this file.
// Catch bare browser refusals while retaining cross-origin JSON, upload status,
// feed bytes, and the no-downstream-work boundary. No DB or network is needed.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestBodyLimit } from "../src/body-limit";
import type { Env } from "../src/env";
import { forbidden } from "../src/errors";
import { sameOrigin } from "../src/same-origin";

vi.mock("postgres", () => ({
  default: () => {
    throw new Error("acceptance fixtures must not open a database");
  },
}));

const env = {
  APP_URL: "https://next.example.test",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
} as Env;
const BROWSER = "text/html,application/xhtml+xml";
const FEEDS = ["/events.ics", "/events.rss", "/events.md", "/llms.txt"];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("fixture must remain offline"))),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function privateNoStore(response: Response) {
  expect(
    response.headers
      .get("cache-control")
      ?.split(",")
      .map((s) => s.trim())
      .sort(),
  ).toEqual(["no-store", "private"]);
}

async function branded(response: Response, status: number, heading: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toContain("text/html");
  const body = await response.text();
  expect(body).toContain(heading);
  expect(body).toContain('id="error-heading"');
  expect(body).toContain('name="robots" content="noindex, nofollow"');
  expect(body).toContain('href="/"');
  expect(body).not.toContain("private upload failure");
  privateNoStore(response);
  expect(
    response.headers
      .get("vary")
      ?.toLowerCase()
      .split(",")
      .map((s) => s.trim()),
  ).toContain("accept");
}

function guarded() {
  const app = new Hono<{ Bindings: Env }>();
  const entered = vi.fn();
  app.use("*", async (c, next) => {
    c.header("vary", "Origin, Cookie");
    await next();
  });
  app.use("*", sameOrigin);
  app.all("*", (c) => {
    entered();
    return c.text("accepted");
  });
  return { app, entered };
}

function uploadFixture(path = "/form") {
  const app = new Hono<{ Bindings: Env }>();
  const entered = vi.fn();
  app.post(path, requestBodyLimit("form"), (c) => {
    entered();
    return c.text("accepted");
  });
  return { app, entered };
}

function brokenUpload(path: string, accept: string) {
  return new Request(new URL(path, env.APP_URL), {
    method: "POST",
    headers: { accept, "content-type": "application/x-www-form-urlencoded" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("private upload failure"));
      },
    }),
    duplex: "half",
  } as RequestInit);
}

describe("same-origin browser refusals negotiate without changing machine envelopes", () => {
  it.each(["https://foreign.example.test", "null", "", undefined])(
    "untrusted Origin %s gets branded 403 before the route",
    async (origin) => {
      const { app, entered } = guarded();
      const response = await app.request(
        new URL("/logout", env.APP_URL).toString(),
        {
          method: "POST",
          headers: { accept: BROWSER, ...(origin === undefined ? {} : { origin }) },
        },
        env,
      );
      expect(response.status).toBe(403);
      expect(entered).not.toHaveBeenCalled();
      await branded(response, 403, "You do not have access to this");
      expect(
        response.headers
          .get("vary")
          ?.toLowerCase()
          .split(",")
          .map((s) => s.trim())
          .sort(),
      ).toEqual(["accept", "cookie", "origin"]);
    },
  );

  it.each(["application/json;q=0, text/html", "text/html;q=0.9, application/json;q=0.1"])(
    "browser preference %s is respected",
    async (accept) => {
      const { app } = guarded();
      const response = await app.request("/logout", { method: "POST", headers: { accept } }, env);
      await branded(response, 403, "You do not have access to this");
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "%s JSON refusal retains the exact cross_origin envelope",
    async (method) => {
      const { app, entered } = guarded();
      const response = await app.request(
        "/logout",
        {
          method,
          headers: { accept: "application/json", origin: "https://foreign.example.test" },
        },
        env,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "cross_origin" });
      expect(entered).not.toHaveBeenCalled();
      privateNoStore(response);
    },
  );

  it.each([undefined, "APPLICATION/JSON", "text/html;q=0.1, application/json;q=0.9"])(
    "non-browser Accept %s retains the exact cross_origin envelope",
    async (accept) => {
      const { app, entered } = guarded();
      const response = await app.request(
        "/logout",
        {
          method: "POST",
          headers: accept ? { accept } : {},
        },
        env,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "cross_origin" });
      expect(entered).not.toHaveBeenCalled();
    },
  );

  it.each(["/api/fixture", "/events", "/events/fixture/publish"])(
    "machine-only %s stays the exact JSON envelope even with browser Accept",
    async (path) => {
      const { app } = guarded();
      const response = await app.request(
        path,
        { method: "POST", headers: { accept: BROWSER } },
        env,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "cross_origin" });
    },
  );

  it("an admitted same-origin write still reaches the route", async () => {
    const { app, entered } = guarded();
    const response = await app.request(
      new URL("/logout", env.APP_URL).toString(),
      {
        method: "POST",
        headers: { origin: env.APP_URL, accept: BROWSER },
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("accepted");
    expect(entered).toHaveBeenCalledOnce();
  });
});

describe("unreadable uploads refuse as negotiated 400s, never route failures", () => {
  it("a browser gets BadRequestPage without reaching the route", async () => {
    const { app, entered } = uploadFixture();
    const response = await app.request(brokenUpload("/form", BROWSER), undefined, env);
    expect(response.status).toBe(400);
    expect(entered).not.toHaveBeenCalled();
    await branded(response, 400, "Check your request");
  });

  it("JSON callers get a static bad_request envelope without stream details", async () => {
    const { app, entered } = uploadFixture();
    const response = await app.request(brokenUpload("/form", "application/json"), undefined, env);
    expect(response.status).toBe(400);
    expect(entered).not.toHaveBeenCalled();
    expect(response.headers.get("content-type")).toContain("application/json");
    // New helper contract: the discriminator is fixed, explanatory copy is not.
    expect(await response.json()).toEqual({ error: "bad_request", message: expect.any(String) });
    privateNoStore(response);
  });

  it.each(["/api/upload", "/events", "/events/fixture/publish"])(
    "%s unreadable machine upload stays JSON even with browser Accept",
    async (path) => {
      const { app, entered } = uploadFixture(path);
      const response = await app.request(brokenUpload(path, BROWSER), undefined, env);
      expect(response.status).toBe(400);
      expect(entered).not.toHaveBeenCalled();
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual({ error: "bad_request", message: expect.any(String) });
    },
  );

  it.each(FEEDS)(
    "%s unreadable upload retains plaintext bytes for browser Accept",
    async (path) => {
      const { app, entered } = uploadFixture(path);
      const response = await app.request(brokenUpload(path, BROWSER), undefined, env);
      expect(response.status).toBe(400);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toBe("Bad request");
      expect(entered).not.toHaveBeenCalled();
    },
  );

  it("oversize JSON keeps the exact 413 envelope, not the new 400", async () => {
    const { app, entered } = uploadFixture();
    const response = await app.request(
      "/form",
      {
        method: "POST",
        body: "fixture",
        headers: { accept: "application/json", "content-length": "65537" },
      },
      env,
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      reason: "payload_too_large",
      message: "Reduce the size of your request and try again.",
    });
    expect(entered).not.toHaveBeenCalled();
  });
});

describe("existing forbidden feed bytes stay outside branded negotiation", () => {
  it.each(FEEDS)("%s never turns Forbidden into HTML or JSON", async (path) => {
    const app = new Hono<{ Bindings: Env }>();
    app.get(path, (c) => forbidden(c));
    for (const accept of [BROWSER, "application/json"]) {
      const response = await app.request(path, { headers: { accept } }, env);
      expect(response.status).toBe(403);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toBe("Forbidden");
    }
  });
});
