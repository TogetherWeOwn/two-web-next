import { describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { botFlagOf, countryOf, recordPageView, referrerHostOf } from "../src/pageviews";

// TOG-11885 experiment: staging-only first-party page-view counts via
// Workers Analytics Engine. One data point per HTML GET — no beacon, no CSP
// change, no cookies. Schema: blobs [route template, country, referrer host],
// doubles [status, bot flag]. No IP, user agent, user id or session is stored.

const APP_URL = "https://next.example.test";

const base: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

type DataPoint = { blobs: (string | null)[]; doubles: number[] };

function fakeDataset(points: DataPoint[]): NonNullable<Env["PAGE_VIEWS"]> {
  return { writeDataPoint: (event) => { points.push(event as DataPoint); } };
}

describe("page-view field derivation (no PII stored)", () => {
  it.each([["US", "US"], ["us", "US"], ["gb", "GB"]])("keeps the 2-letter country code: %s", (input, expected) => {
    expect(countryOf(input)).toBe(expected);
  });

  it.each([[undefined], [null], [""], ["XXL"], ["12"], [123], [{}]])("maps %s to unknown", (input) => {
    expect(countryOf(input)).toBe("unknown");
  });

  it("stores only the referrer host, never the URL or query", () => {
    expect(referrerHostOf("https://search.example.com/q?secret=abc")).toBe("search.example.com");
    expect(referrerHostOf("HTTPS://UPPER.EXAMPLE/Path")).toBe("upper.example");
  });

  it.each([[null, ""], [undefined, ""], ["", ""], ["not a url", ""], ["https://direct", "direct"]])(
    "maps %s to %s",
    (input, expected) => {
      expect(referrerHostOf(input)).toBe(expected);
    },
  );

  it.each([
    ["Mozilla/5.0 (compatible; Googlebot/2.1)", 1],
    ["facebookexternalhit/1.1", 0], // not in the conservative token list
    ["curl/8.0", 0],
    [null, 0],
    [undefined, 0],
  ])("bot flag for %s is %s", (input, expected) => {
    expect(botFlagOf(input)).toBe(expected);
  });
});

describe("recordPageView on the mounted worker", () => {
  it("writes one data point per HTML GET with template, status and derived fields", async () => {
    const points: DataPoint[] = [];
    const res = await app.request("/about", {
      headers: { referer: "https://search.example.com/q?secret=abc", "user-agent": "curl/8.0" },
    }, { ...base, PAGE_VIEWS: fakeDataset(points) });
    expect(res.status).toBe(200);
    await res.text();
    expect(points).toHaveLength(1);
    expect(points[0]!.blobs).toEqual(["/about", "unknown", "search.example.com"]);
    expect(points[0]!.doubles).toEqual([200, 0]);
  });

  it("groups unmatched paths as 404", async () => {
    const points: DataPoint[] = [];
    const res = await app.request("/no-such-page-xyz", {}, { ...base, PAGE_VIEWS: fakeDataset(points) });
    expect(res.status).toBe(404);
    await res.text();
    expect(points).toHaveLength(1);
    expect(points[0]!.blobs[0]).toBe("404");
    expect(points[0]!.doubles[0]).toBe(404);
  });

  it("skips non-GET, non-HTML and unbound requests without touching the response", async () => {
    const points: DataPoint[] = [];
    const withBinding = { ...base, PAGE_VIEWS: fakeDataset(points) };
    const post = await app.request("/csp-reports", {
      method: "POST",
      headers: { "content-type": "application/csp-report" },
      body: "{}",
    }, withBinding);
    expect(post.status).toBe(204);
    const json = await app.request("/up", {}, withBinding);
    expect(json.status).toBe(200);
    await json.text();
    const unbound = await app.request("/about", {}, base);
    expect(unbound.status).toBe(200);
    await unbound.text();
    expect(points).toHaveLength(0);
  });

  it("never breaks the page when the dataset throws", async () => {
    const res = await app.request("/about", {}, {
      ...base,
      PAGE_VIEWS: { writeDataPoint: () => { throw new Error("wae down"); } },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("About Together We Own");
  });

  it("recordPageView is a no-op without a response or binding", () => {
    expect(() => recordPageView({} as never)).not.toThrow();
  });
});
