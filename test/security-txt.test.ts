// route-inventory: GET /.well-known/security.txt
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { SECURITY_HEADERS } from "../src/headers";

const ORIGIN = "https://next.example.test";
const CONTACT = "https://github.com/TogetherWeOwn/two-web-next/security/advisories/new";
const POLICY = "https://github.com/TogetherWeOwn/two-web-next/blob/main/SECURITY.md";

const env: Env = {
  APP_URL: ORIGIN,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const getSecurityTxt = (bindings: Env = env) =>
  app.request("/.well-known/security.txt", {}, bindings);

const expiresLine = (body: string) => body.split("\n").find((line) => line.startsWith("Expires: "));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("/.well-known/security.txt (RFC 9116)", () => {
  it("answers 200 text/plain with the RFC fields and a short public cache", async () => {
    vi.setSystemTime(new Date("2026-10-09T10:20:30.456Z"));
    const res = await getSecurityTxt();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await res.text()).toBe(
      [
        `Contact: ${CONTACT}`,
        "Expires: 2027-10-08T10:20:30Z",
        "Preferred-Languages: en",
        `Canonical: ${ORIGIN}/.well-known/security.txt`,
        `Policy: ${POLICY}`,
        "",
      ].join("\n"),
    );
  });

  it.each([
    ["2026-12-31T23:59:59.999Z", "2027-12-30T23:59:59Z"],
    ["2027-12-31T23:59:59Z", "2028-12-29T23:59:59Z"],
    ["2028-02-29T00:00:00Z", "2029-02-27T00:00:00Z"],
    ["2029-01-01T00:00:00Z", "2029-12-31T00:00:00Z"],
  ])("at %s the expiry is %s: after now, less than one year ahead", async (now, expires) => {
    vi.setSystemTime(new Date(now));
    const body = await (await getSecurityTxt()).text();
    expect(expiresLine(body)).toBe(`Expires: ${expires}`);
    const start = new Date(now);
    const oneYearLater = new Date(start);
    oneYearLater.setUTCFullYear(start.getUTCFullYear() + 1);
    expect(Date.parse(expires)).toBeGreaterThan(start.getTime());
    expect(Date.parse(expires)).toBeLessThan(oneYearLater.getTime());
  });

  it("keeps Canonical on a single slash when APP_URL ends with slashes", async () => {
    const body = await (await getSecurityTxt({ ...env, APP_URL: `${ORIGIN}//` })).text();
    expect(body).toContain(`\nCanonical: ${ORIGIN}/.well-known/security.txt\n`);
    expect(body).not.toContain("//.well-known");
  });

  it("answers HEAD with the same headers and an empty body", async () => {
    const res = await app.request("/.well-known/security.txt", { method: "HEAD" }, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await res.text()).toBe("");
  });

  it("carries the four security headers and never sets a cookie", async () => {
    const res = await getSecurityTxt();
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers.get(name), name).toBe(value);
    }
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("names no mailbox or personal data", async () => {
    const body = await (await getSecurityTxt()).text();
    expect(body).not.toMatch(/@|mailto:/i);
  });

  it("publishes the same private advisory URL that SECURITY.md names", () => {
    const security = readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
    expect(security).toContain(CONTACT);
  });

  it("stays out of the sitemap and leaves robots.txt unchanged", async () => {
    const sitemap = await (await app.request("/sitemap_index.xml", {}, env)).text();
    expect(sitemap).not.toContain("security.txt");
    const robots = await (await app.request("/robots.txt", {}, env)).text();
    expect(robots).toBe(`User-agent: *\nDisallow:\nSitemap: ${ORIGIN}/sitemap_index.xml\n`);
  });
});
