import { beforeEach, describe, expect, it, vi } from "vitest";

// The hook wiring test targets the framework-free dispatch core in
// src/route-ownership.ts, not web/src/hooks.server.ts: the root Vitest suite
// cannot transform that file (web/tsconfig.json extends the
// SvelteKit-generated $app/tsconfig, so the vite:oxc transform fails under
// coverage). web/src/hooks.server.ts delegates to dispatchHookRequest, so
// these cases pin the shipped ordering exactly.
vi.mock("cloudflare:workers", () => ({
  env: { APP_URL: "https://example.com", FEATURED_IMAGE_HOSTS: "" },
  waitUntil: vi.fn(),
}));

import {
  HONO_FALLBACK_ROUTE_ID,
  KIT_RENDERER_HEADER,
  KIT_RENDERER_VALUE,
  decideOwner,
  dispatchHookRequest,
} from "../src/route-ownership";
import { isTrustedHost } from "../src/trust-hosts";

const APP_URL = "https://example.com";

function trustedEvent(path, host = "example.com") {
  const request = new Request(`https://example.com${path}`, {
    headers: { host },
  });
  return { request, url: new URL(request.url), route: { id: "/events/past" } };
}

function deps(overrides = {}) {
  return {
    appUrl: APP_URL,
    isTrustedHost,
    decideOwner,
    honoFetch: vi.fn(async () => new Response("hono", { status: 200 })),
    resolve: vi.fn(async () => new Response("kit", { status: 200 })),
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("hooks.server route ownership wiring", () => {
  it("returns honoFetch before resolve for a Hono-owned path", async () => {
    const event = trustedEvent("/events/past");
    const d = deps();

    const response = await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.honoFetch).toHaveBeenCalledWith(event.request);
    expect(d.resolve).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono");
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
  });

  it("reaches resolve and never Hono for a Kit-owned path, with the renderer marker", async () => {
    const event = trustedEvent("/events/past");
    const d = deps({
      decideOwner: () => "kit",
      resolve: vi.fn(
        async () =>
          new Response("<html>kit page</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    });

    const response = await dispatchHookRequest(event, d);
    expect(d.resolve).toHaveBeenCalledOnce();
    expect(d.honoFetch).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
  });

  it("propagates a resolve failure without replaying through Hono", async () => {
    const event = trustedEvent("/events/past");
    const failure = new Error("kit resolve blew up");
    const d = deps({
      decideOwner: () => "kit",
      resolve: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(dispatchHookRequest(event, d)).rejects.toThrow(failure);
    expect(d.honoFetch).not.toHaveBeenCalled();
  });

  it("answers untrusted hosts via Hono before the ownership decision", async () => {
    const event = trustedEvent("/events/past", "evil.example");
    const decide = vi.fn(() => "kit");
    const d = deps({ decideOwner: decide });

    const response = await dispatchHookRequest(event, d);
    expect(d.honoFetch).toHaveBeenCalledOnce();
    expect(d.resolve).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono");
  });

  it("returns the catch-all fallback without the Kit marker", async () => {
    const event = trustedEvent("/api/ping");
    event.route = { id: HONO_FALLBACK_ROUTE_ID };
    const d = deps({
      decideOwner: () => "kit",
      resolve: vi.fn(async () => new Response("fallback", { status: 200 })),
    });

    const response = await dispatchHookRequest(event, d);
    expect(d.resolve).toHaveBeenCalledOnce();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
    expect(await response.text()).toBe("fallback");
  });
});

// Reference the module export so unused-import drift fails loudly rather
// than silently dropping the contract pin.
void decideOwner;
