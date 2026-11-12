import { describe, expect, it } from "vitest";
import app from "./app";
import { withStreamedBody } from "../src/html-stream";
import type { Env } from "../src/env";

// TWO-7591: HTML responses must leave the Worker as unknown-length streams so
// the edge negotiates br/gzip like it already does for CSS/JSON. A declared
// Content-Length marks the body untransformable (`cache-control:
// no-transform` on the wire), which is exactly the staging Lighthouse defect.
const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

describe("withStreamedBody", () => {
  it("streams an HTML body and drops a declared Content-Length", async () => {
    const res = new Response("<!doctype html><p>hi</p>", {
      status: 200,
      statusText: "OK",
      headers: {
        "content-type": "text/html; charset=UTF-8",
        "content-length": "28",
        "cache-control": "public, max-age=3600",
        "x-test-marker": "kept",
      },
    });
    const out = withStreamedBody(res);
    expect(out).not.toBe(res);
    expect(out.status).toBe(200);
    expect(out.headers.get("x-test-marker")).toBe("kept");
    expect(out.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(out.headers.get("content-length")).toBeNull();
    expect(await out.text()).toBe("<!doctype html><p>hi</p>");
  });

  it("returns non-HTML responses unchanged", () => {
    const json = new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "2" },
    });
    expect(withStreamedBody(json)).toBe(json);
  });

  it("returns already-encoded HTML unchanged (never double-compressed)", () => {
    const encoded = new Response("<p>hi</p>", {
      headers: { "content-type": "text/html", "content-encoding": "gzip" },
    });
    expect(withStreamedBody(encoded)).toBe(encoded);
  });

  it("returns bodyless responses unchanged", () => {
    const empty = new Response(null, {
      status: 204,
      headers: { "content-type": "text/html" },
    });
    expect(withStreamedBody(empty)).toBe(empty);
  });
});

describe("HTML wire shape through the app", () => {
  it.each(["/about", "/faq", "/rules", "/privacy"])(
    "%s answers text/html without a declared Content-Length",
    async (path) => {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("content-length")).toBeNull();
      expect((await res.text()).length).toBeGreaterThan(1000);
    },
  );

  it("branded 404s also stream without a declared Content-Length", async () => {
    const res = await app.request("/__missing__", {}, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-length")).toBeNull();
  });

  it("JSON routes keep their existing shape", async () => {
    const res = await app.request("/version", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});
