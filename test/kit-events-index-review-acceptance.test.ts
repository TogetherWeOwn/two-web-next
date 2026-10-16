// Acceptance pins for the events-index review findings. No database or network.
import { describe, expect, it, vi } from "vitest";
import { loadEventsPage } from "../src/kit-events";
import {
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  ROUTE_MANIFEST,
  decideOwner,
  dispatchHookRequest,
  resolveRouteOwner,
} from "../src/route-ownership";

const APP_URL = "https://events.example.test";
const env = {
  APP_URL,
  DISCORD_CLIENT_ID: "synthetic-discord-client-id",
  DISCORD_INVITE_URL: "https://discord.gg/synthetic-invite",
} as never;
const baseModel = {
  state: { view: "list", month: "2026-10", q: "", past: false, page: 1 },
  upcoming: [],
  past: [],
  zone: "Europe/London",
  now: new Date("2026-10-13T12:00:00Z"),
  totalPages: 1,
  emptyState: null,
  robots: undefined,
  discordFailed: false,
};

describe("events index review acceptance", () => {
  it("keeps successful HEAD flash peeks private without consuming the flash", async () => {
    const setHeaders = vi.fn();
    const deleteJoinCookie = vi.fn();
    const journeyForFn = vi.fn(async () => "added" as const);

    await loadEventsPage({
      env,
      url: new URL(`${APP_URL}/events`),
      method: "HEAD",
      island: false,
      request: new Request(`${APP_URL}/events`, {
        method: "HEAD",
        headers: { cookie: "__Host-two_join_result=synthetic-pending-flash" },
      }),
      setHeaders,
      deleteJoinCookie,
      dbForFn: async () => ({}) as never,
      sessionForFn: async () => null,
      journeyForFn,
      modelForFn: async () => baseModel,
      discordForFn: () => ({ upcoming: async () => [], lastReadFailed: () => false }) as never,
    });

    expect(journeyForFn).toHaveBeenCalledOnce();
    expect(setHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ "cache-control": "private, no-store" }),
    );
    expect(deleteJoinCookie).not.toHaveBeenCalled();
  });

  it("ships GET /events as a Kit route while retaining Hono write and JSON ownership", () => {
    expect(ROUTE_MANIFEST).toContainEqual({
      method: "GET",
      path: "/events",
      enabled: true,
      reads: "public",
    });
    expect(resolveRouteOwner({ method: "GET", path: "/events" })).toBe("kit");
    expect(resolveRouteOwner({ method: "HEAD", path: "/events" })).toBe("kit");
    expect(decideOwner(new Request(`${APP_URL}/events`))).toBe("kit");
    expect(resolveRouteOwner({ method: "POST", path: "/events" })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/events.json" })).toBe("hono");
  });

  it("dispatches the events index to Kit with its renderer marker", async () => {
    const request = new Request(`${APP_URL}/events`, {
      headers: { host: "events.example.test" },
    });
    const resolve = vi.fn(async () => new Response("kit events", { status: 200 }));
    const honoFetch = vi.fn(async () => new Response("hono events", { status: 200 }));

    const response = await dispatchHookRequest(
      { request, url: new URL(request.url), route: { id: "/events" } },
      { appUrl: APP_URL, resolve, honoFetch },
    );

    expect(resolve).toHaveBeenCalledOnce();
    expect(honoFetch).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
  });
});
