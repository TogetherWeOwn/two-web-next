import assert from "node:assert/strict";
import { test } from "node:test";
import { crawlablePath, EXPLORE_ORIGIN, findingId, severityFor } from "./crawl-utils.mjs";

const from = `${EXPLORE_ORIGIN}/events`;

test("keeps same-origin HTML paths and drops fragments", () => {
  assert.equal(crawlablePath("/rules#top", from), "/rules");
  assert.equal(crawlablePath(`${EXPLORE_ORIGIN}/e/abc`, from), "/e/abc");
});

test("refuses other origins, including production", () => {
  assert.equal(crawlablePath("https://togetherweown.com/rules", from), null);
  assert.equal(crawlablePath("https://discord.com/invite/x", from), null);
});

test("skips sign-in, Discord, admin and feed paths", () => {
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
    assert.equal(crawlablePath(p, from), null, p);
});

test("keeps only small pagination queries", () => {
  assert.equal(crawlablePath("/events/past?page=2", from), "/events/past?page=2");
  assert.equal(crawlablePath("/events/past?page=9999", from), "/events/past");
  assert.equal(crawlablePath("/events?q=x&page=2", from), "/events");
});

test("finding ids are stable across volatile numbers and differ by viewport", () => {
  const a = findingId({ kind: "console", path: "/", viewport: "mobile", detail: "err at 12345" });
  const b = findingId({ kind: "console", path: "/", viewport: "mobile", detail: "err at 67890" });
  const c = findingId({ kind: "console", path: "/", viewport: "desktop", detail: "err at 12345" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("severity: 5xx and page errors are high, 404 medium, console low", () => {
  assert.equal(severityFor("status", "503"), "high");
  assert.equal(severityFor("pageerror"), "high");
  assert.equal(severityFor("status", "404"), "medium");
  assert.equal(severityFor("console"), "low");
});
