import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { renderNotFoundDocument } from "../src/error-pages";
import { brandedNotFoundFallback } from "../src/http/not-found";
import app from "../src/index";
import { cachedNotFoundSuggestions } from "../src/not-found-suggestions";

vi.mock("../src/not-found-suggestions", { spy: true });

const env = { APP_URL: "https://wildcard.example.test" } as Env;
const suggestions = [
  {
    key: "fixture-event",
    title: "Café & board games",
    startsAt: new Date("2026-07-02T18:00:00Z"),
    location: "Lobby <East>",
  },
];

// The same unregistered path as the pure-Hono route parity golden.
const request = new Request(`${env.APP_URL}/parity-unregistered`, {
  headers: { "cf-ray": "0123456789abcdef" },
});
const headRequest = new Request(request, { method: "HEAD" });

it("preserves the mounted wildcard document and headers for GET and HEAD", async () => {
  vi.mocked(cachedNotFoundSuggestions).mockResolvedValue(suggestions);
  const get = await app.request(request, undefined, env);
  const head = await app.request(headRequest, undefined, env);
  const bytes = Buffer.from(await get.arrayBuffer());

  expect(get.status).toBe(404);
  expect({
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    headers: Object.fromEntries(get.headers),
  }).toMatchInlineSnapshot(`
    {
      "bytes": 3405,
      "headers": {
        "cache-control": "no-store, private",
        "content-security-policy": "default-src 'self'; base-uri 'self'; connect-src 'self'; object-src 'none'; img-src 'self' https://cdn.discordapp.com; frame-src 'none'; style-src 'self'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; form-action 'self'; report-to csp-endpoint",
        "content-type": "text/html; charset=UTF-8",
        "cross-origin-embedder-policy": "credentialless",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
        "origin-agent-cluster": "?1",
        "permissions-policy": "camera=(), microphone=(), geolocation=()",
        "referrer-policy": "strict-origin-when-cross-origin",
        "reporting-endpoints": "csp-endpoint="/csp-reports"",
        "x-content-type-options": "nosniff",
        "x-dns-prefetch-control": "off",
        "x-download-options": "noopen",
        "x-frame-options": "DENY",
        "x-permitted-cross-domain-policies": "none",
        "x-request-id": "0123456789abcdef",
        "x-robots-tag": "noindex, nofollow",
        "x-xss-protection": "0",
      },
      "sha256": "c2b71718bed14306e558914729529cfd1f9c5ea880f828c62f546c006b9fab70",
    }
  `);
  expect(head.status).toBe(get.status);
  expect([...head.headers]).toEqual([...get.headers]);
  expect(head.body).toBeNull();

  const render = vi.fn(() => renderNotFoundDocument(suggestions));
  const fallback = await brandedNotFoundFallback(request, render);
  const headFallback = await brandedNotFoundFallback(headRequest, render);
  expect(fallback.status).toBe(get.status);
  expect([...fallback.headers]).toEqual([
    ["cache-control", get.headers.get("cache-control")],
    ["content-type", get.headers.get("content-type")],
  ]);
  expect(Buffer.from(await fallback.arrayBuffer())).toEqual(bytes);
  expect(headFallback.status).toBe(fallback.status);
  expect([...headFallback.headers]).toEqual([...fallback.headers]);
  expect(headFallback.body).toBeNull();
  expect(render).toHaveBeenCalledTimes(1);
});
