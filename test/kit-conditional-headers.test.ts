import { describe, expect, it, vi } from "vitest";
import { dispatchHookRequest, type OwnedRoute } from "../src/route-ownership";

const appUrl = "https://example.com";
const manifest: OwnedRoute[] = [{ method: "GET", path: "/about", enabled: true, reads: "public" }];

function fixture(status = 200, etag: string | null = '"fixture"') {
  const headers = new Headers({
    "content-security-policy": "default-src 'self'",
    "cache-control": "public, max-age=60",
    "x-custom-contract": "retained",
    vary: "Accept",
  });
  if (etag !== null) headers.set("etag", etag);
  headers.append("set-cookie", "first=1; Secure; HttpOnly; Path=/");
  headers.append("set-cookie", "second=2; Secure; SameSite=Lax; Path=/");
  return new Response(status === 304 ? null : "body", { status, headers });
}

async function dispatch(
  branch: "hono" | "kit" | "untrusted",
  validator: string | null,
  upstream: Response,
) {
  const headers = new Headers();
  if (validator !== null) headers.set("if-none-match", validator);
  const request = new Request(`${appUrl}/${branch === "hono" ? "unowned" : "about"}`, { headers });
  const url = new URL(request.url);
  if (branch === "untrusted") url.host = "untrusted.example";
  const honoFetch = vi.fn(async () => upstream);
  const resolve = vi.fn(async () => upstream);
  const response = await dispatchHookRequest(
    { request, url, route: { id: branch === "hono" ? "/[...path]" : "/about" } },
    { appUrl, manifest, honoFetch, resolve },
  );
  return { response, honoFetch, resolve };
}

describe("Kit conditional response headers", () => {
  it.each(["hono", "kit", "untrusted"] as const)(
    "preserves the %s envelope for exact and weak validators",
    async (branch) => {
      for (const validator of ['"fixture"', 'W/"fixture"']) {
        const upstream = fixture();
        const { response, honoFetch, resolve } = await dispatch(branch, validator, upstream);
        expect(response.status).toBe(304);
        expect(await response.text()).toBe("");
        expect([...response.headers]).toEqual([...upstream.headers]);
        expect(response.headers.getSetCookie()).toEqual(upstream.headers.getSetCookie());
        expect(response.headers.getSetCookie()).toHaveLength(2);
        expect(honoFetch.mock.calls.length + resolve.mock.calls.length).toBe(1);
      }
    },
  );

  it.each([
    [200, null, '"fixture"'],
    [200, '"other"', '"fixture"'],
    [200, "*", '"fixture"'],
    [200, '"other", "fixture"', '"fixture"'],
    [200, '"fixture"', null],
    [304, '"fixture"', '"fixture"'],
    [404, '"fixture"', '"fixture"'],
    [201, '"fixture"', '"fixture"'],
  ])("leaves status %s and validator %s unchanged", async (status, validator, etag) => {
    const upstream = fixture(status, etag);
    const { response } = await dispatch("hono", validator, upstream);
    expect(response).toBe(upstream);
  });
});
