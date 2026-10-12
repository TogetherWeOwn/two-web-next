import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "cloudflare:workers",
  () => ({
    env: { APP_URL: "https://example.com", FEATURED_IMAGE_HOSTS: "" },
    waitUntil: vi.fn(),
  }),
  { virtual: true },
);

vi.mock("../web/src/lib/server/hono", () => ({
  honoFetch: vi.fn(),
}));

vi.mock("../src/route-ownership", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, decideOwner: vi.fn((request) => actual.decideOwner(request)) };
});

import { honoFetch } from "../web/src/lib/server/hono";
import { KIT_RENDERER_HEADER, KIT_RENDERER_VALUE, decideOwner } from "../src/route-ownership";
import { handle } from "../web/src/hooks.server";

const mockedHonoFetch = vi.mocked(honoFetch);
const mockedDecideOwner = vi.mocked(decideOwner);

function trustedEvent(path, host = "example.com") {
  const request = new Request(`https://example.com${path}`, { headers: { host } });
  return { request, url: new URL(request.url), route: { id: "/events/past" } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedHonoFetch.mockResolvedValue(new Response("hono", { status: 200 }));
});

describe("hooks.server route ownership wiring", () => {
  it("returns honoFetch before resolve for a Hono-owned path", async () => {
    const event = trustedEvent("/events/past");
    const resolve = vi.fn(async () => new Response("kit", { status: 200 }));

    const response = await handle({ event, resolve });
    expect(mockedDecideOwner).toHaveBeenCalledOnce();
    expect(mockedHonoFetch).toHaveBeenCalledOnce();
    expect(mockedHonoFetch).toHaveBeenCalledWith(event.request);
    expect(resolve).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono");
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBeNull();
  });

  it("reaches resolve and never Hono for a Kit-owned path, with the renderer marker", async () => {
    mockedDecideOwner.mockReturnValueOnce("kit");
    const event = trustedEvent("/events/past");
    const resolve = vi.fn(
      async () =>
        new Response("<html>kit page</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const response = await handle({ event, resolve });
    expect(resolve).toHaveBeenCalledOnce();
    expect(mockedHonoFetch).not.toHaveBeenCalled();
    expect(response.headers.get(KIT_RENDERER_HEADER)).toBe(KIT_RENDERER_VALUE);
  });

  it("propagates a resolve failure without replaying through Hono", async () => {
    mockedDecideOwner.mockReturnValueOnce("kit");
    const event = trustedEvent("/events/past");
    const failure = new Error("kit resolve blew up");
    const resolve = vi.fn(async () => {
      throw failure;
    });

    await expect(handle({ event, resolve })).rejects.toThrow(failure);
    expect(mockedHonoFetch).not.toHaveBeenCalled();
  });

  it("answers untrusted hosts via Hono before the ownership decision", async () => {
    const event = trustedEvent("/events/past", "evil.example");
    const resolve = vi.fn(async () => new Response("kit", { status: 200 }));

    const response = await handle({ event, resolve });
    expect(mockedHonoFetch).toHaveBeenCalledOnce();
    expect(resolve).not.toHaveBeenCalled();
    expect(mockedDecideOwner).not.toHaveBeenCalled();
    expect(await response.text()).toBe("hono");
  });
});
