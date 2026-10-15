import { describe, expect, it } from "vitest";
import { llmsTxt } from "../src/ai-friendly/md";
import { buildSitemapUrls, crawlableEvents, renderSitemap } from "../src/seo";
import {
  PUBLIC_ROUTE_SLOTS,
  TOOL_SLOTS,
  declareToolSlot,
  isPublicRouteSlot,
  supportedToolSlots,
  type ToolSlot,
} from "../src/seo-slots";

const APP_URL = "https://next.example.test";

// Member, admin, draft and API paths: no machine surface may name them.
const PRIVATE_PATHS = [
  "/events/past",
  "/events.json",
  "/profile",
  "/members/101",
  "/leaderboards/members",
  "/admin",
  "/admin/events",
  "/admin/featured/1",
  "/join/discord",
  "/join/callback",
  "/auth/discord",
  "/auth/recover",
  "/api/public/events",
  "/logout",
];

const readEvents: ToolSlot = {
  name: "list_public_events",
  route: "/events",
  method: "GET",
  auth: "public",
  confirmation: "none",
};

describe("public route slots", () => {
  it("lists the sitemap pages in their shipped order", () => {
    expect(Object.keys(PUBLIC_ROUTE_SLOTS)).toEqual([
      "/",
      "/join",
      "/events",
      "/about",
      "/faq",
      "/rules",
      "/privacy",
    ]);
  });

  it("drives the static sitemap entries from the slots", () => {
    const locs = buildSitemapUrls(APP_URL, []).map((u) => u.loc);
    expect(locs).toEqual([
      `${APP_URL}/`,
      `${APP_URL}/join`,
      `${APP_URL}/events`,
      `${APP_URL}/about`,
      `${APP_URL}/faq`,
      `${APP_URL}/rules`,
      `${APP_URL}/privacy`,
    ]);
  });

  it.each(PRIVATE_PATHS)("never admits %s as a public slot", (path) => {
    expect(isPublicRouteSlot(path)).toBe(false);
  });

  it("keeps every private path out of the sitemap and llms.txt", () => {
    const sitemap = renderSitemap(
      buildSitemapUrls(
        APP_URL,
        crawlableEvents([{ key: "K1", status: "published", updatedAt: null }]),
      ),
    );
    const llms = llmsTxt(APP_URL);
    for (const path of PRIVATE_PATHS) {
      expect(sitemap).not.toContain(`${APP_URL}${path}`);
      expect(llms).not.toContain(`${APP_URL}${path}`);
    }
  });

  it("keeps the auth-required events JSON off every machine surface", () => {
    const sitemap = renderSitemap(buildSitemapUrls(APP_URL, []));
    expect(sitemap).not.toContain("events.json");
    expect(llmsTxt(APP_URL)).not.toContain("events.json");
  });
});

describe("AI tool slots", () => {
  it("declares no tools until an approved AI card adds one", () => {
    expect(TOOL_SLOTS).toEqual([]);
  });

  it("accepts a read-only tool on a public slot", () => {
    expect(declareToolSlot(readEvents)).toEqual(readEvents);
  });

  it("refuses a tool on a route outside the public slots", () => {
    for (const route of ["/events.json", "/profile", "/events/past"]) {
      expect(() => declareToolSlot({ ...readEvents, route } as unknown as ToolSlot)).toThrow(
        /not a public slot/,
      );
    }
  });

  it("refuses any non-GET tool until a card widens the contract", () => {
    expect(() => declareToolSlot({ ...readEvents, method: "POST" } as unknown as ToolSlot)).toThrow(
      /read-only/,
    );
  });

  it("refuses a tool that asks for session auth", () => {
    expect(() =>
      declareToolSlot({ ...readEvents, auth: "session" } as unknown as ToolSlot),
    ).toThrow(/public auth/);
  });

  it("is absent when the server route it calls is not supported", () => {
    expect(supportedToolSlots([readEvents], () => false)).toEqual([]);
    expect(supportedToolSlots([readEvents], (route) => route === "/events")).toEqual([readEvents]);
  });
});
