// route-inventory: GET /join
// SvelteKit migration: the Kit GET /join load keeps the Hono landing page's
// cache contract byte-for-byte (src/index.tsx joinPage render). A consumed
// one-shot flash makes the view viewer-specific (private, no-store); a
// rendered presence snapshot says "now" (60 s shared TTL matching the widget
// verdict TTL); the static page without presence keeps 3600 s. Vary stays on
// every variant: the representation depends on the flash cookie even when the
// view has nothing to consume.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { DiscordWidgetSnapshot } from "../src/discord-widget";
import { joinPageCacheControl } from "../src/join/kit-page";

const snapshot = {
  guildId: "326474832151838730",
  name: "Together We Own",
  inviteUrl: null,
  presenceCount: 42,
  channels: [],
  members: [],
  fetchedAt: 0,
} satisfies DiscordWidgetSnapshot;

describe("Kit GET /join cache contract (Hono joinPage parity)", () => {
  it("a consumed flash answers private, no-store even with a snapshot", () => {
    expect(joinPageCacheControl("added", snapshot)).toBe("private, no-store");
    expect(joinPageCacheControl("already_member", snapshot)).toBe("private, no-store");
  });

  it("a consumed flash answers private, no-store without a snapshot", () => {
    expect(joinPageCacheControl("added", null)).toBe("private, no-store");
  });

  it("presence without a flash keeps the 60 s shared TTL", () => {
    expect(joinPageCacheControl(null, snapshot)).toBe("public, max-age=60");
  });

  it("the static page without presence or flash keeps 3600 s", () => {
    expect(joinPageCacheControl(null, null)).toBe("public, max-age=3600");
    expect(joinPageCacheControl(null, undefined)).toBe("public, max-age=3600");
  });
});

// The Kit load is a thin binding around the root-testable response policy
// (cloudflare:workers + SvelteKit imports stay out of the root test process);
// these source pins guard its markup contract, the same way
// test/discord-widget-snapshot.test.ts pins the shipped island by reading it
// as text. Every actions/URLs/testids acceptance item is named here, so
// deleting one fails this file first. Signed-flash behavior is exercised in
// test/join-kit-load.test.ts.
describe("Kit GET /join markup contract (src/screens/join.tsx parity)", () => {
  const page = readFileSync(
    new NodeURL("../web/src/routes/join/+page.svelte", import.meta.url),
    "utf8",
  );
  const load = readFileSync(
    new NodeURL("../web/src/routes/join/+page.server.ts", import.meta.url),
    "utf8",
  );

  it("keeps every action, URL and testid", () => {
    for (const needle of [
      'data-testid="join-oneclick"',
      'data-testid="join-invite"',
      'data-testid="join-widget-load"',
      'data-testid="join-widget-fallback"',
      'data-testid="join-widget-presence"',
      'data-testid="join-widget-online"',
      'data-testid="join-widget-channels"',
      'data-testid="join-widget-invite"',
      'data-testid="join-result"',
      'data-testid="reinvite-link"',
      'data-testid="signin"',
      "/join/discord",
      "/auth/discord",
      "/discord",
      "/join.md",
      "data-join-widget",
      "join-layout",
      "join-panel",
      "join-preview",
    ]) {
      expect(page, `missing ${needle}`).toContain(needle);
    }
  });

  it("defers the widget to a click: no-referrer facade link and island, no iframe", () => {
    expect(page).toContain('referrerpolicy="no-referrer"');
    expect(page).toContain('<script src="/islands/join-widget.js"');
    expect(page).not.toContain("<iframe");
  });

  it("renders the one-shot flash banner from the shared Hono copy", () => {
    // Single-sourced: the sentences live in src/home-copy.ts (the same module
    // the Hono banner renders) and ride to this page as load data, never as
    // duplicated literals in the page source.
    expect(page).toContain("HOME_JOIN_RESULT_COPY.added");
    expect(page).toContain("HOME_JOIN_RESULT_COPY.alreadyInServer");
    expect(page).toContain("HOME_JOIN_RESULT_COPY.reinvite");
    expect(load).toContain("HOME_JOIN_RESULT_COPY");
  });

  it("renders presence aggregates only, never member names", () => {
    expect(page).toContain("members online");
    expect(page).toContain("Voice and stage channels");
    expect(page).not.toContain("join-widget-members");
  });

  it("the load stays server-rendered, DB-free and flash-consuming", () => {
    expect(load).toContain("csr = false");
    expect(load).toContain("safeNext");
    expect(load).toContain("applyJoinPageResponsePolicy");
    expect(load).toContain("snapshot: widgetSnapshot");
    expect(load).toContain("cookies,");
    expect(load).toContain("setHeaders,");
    expect(load).not.toContain("SESSION_STORE");
    expect(load).not.toContain("ADMIN_DB");
  });
});
