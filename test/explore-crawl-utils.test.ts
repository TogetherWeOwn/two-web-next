import { describe, expect, it } from "vitest";
import {
  crawlablePath,
  EXPLORE_ORIGIN,
  findingId,
  mdCell,
  severityFor,
  // @ts-expect-error Standalone tooling has no declaration file.
} from "../e2e/explore/crawl-utils.mjs";

const from = `${EXPLORE_ORIGIN}/events`;

describe("e2e/explore/crawl-utils.mjs", () => {
  it("keeps same-origin HTML paths and drops fragments", () => {
    expect(crawlablePath("/rules#top", from)).toBe("/rules");
    expect(crawlablePath(`${EXPLORE_ORIGIN}/e/abc`, from)).toBe("/e/abc");
  });

  it("refuses other origins, including production", () => {
    expect(crawlablePath("https://togetherweown.com/rules", from)).toBeNull();
    expect(crawlablePath("https://discord.com/invite/x", from)).toBeNull();
  });

  it("skips sign-in, Discord, admin and feed paths", () => {
    for (const p of [
      "/auth/discord",
      "/join/discord",
      "/login",
      "/profile",
      "/admin/x",
      "/events.ics",
      "/events.rss",
      "/sitemap_index.xml",
    ])
      expect(crawlablePath(p, from), p).toBeNull();
  });

  it("keeps only small pagination queries", () => {
    expect(crawlablePath("/events/past?page=2", from)).toBe("/events/past?page=2");
    expect(crawlablePath("/events/past?page=9999", from)).toBe("/events/past");
    expect(crawlablePath("/events?q=x&page=2", from)).toBe("/events");
  });

  it("gives stable ids across volatile numbers and distinct ids per viewport", () => {
    const a = findingId({ kind: "console", path: "/", viewport: "mobile", detail: "err at 12345" });
    const b = findingId({ kind: "console", path: "/", viewport: "mobile", detail: "err at 67890" });
    const c = findingId({
      kind: "console",
      path: "/",
      viewport: "desktop",
      detail: "err at 12345",
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("rates 5xx and page errors high, 404 medium, console low", () => {
    expect(severityFor("status", "503")).toBe("high");
    expect(severityFor("pageerror")).toBe("high");
    expect(severityFor("status", "404")).toBe("medium");
    expect(severityFor("console")).toBe("low");
  });

  it("escapes backslash before pipe and backtick in Markdown cells and flattens newlines", () => {
    expect(mdCell("a\\|b`c\nd")).toBe("a\\\\\\|b\\`c d");
    expect(mdCell("x".repeat(200))).toHaveLength(120);
  });
});
