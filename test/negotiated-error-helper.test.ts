import { Hono } from "hono";
import { jsx } from "hono/jsx/jsx-runtime";
import { BadRequestPage } from "../src/errors";
import { describe, expect, it } from "vitest";
import { badRequest, prefersHtmlError, varyAccept } from "../src/errors";

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
