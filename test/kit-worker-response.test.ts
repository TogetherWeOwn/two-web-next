// Protector credit: Rick7C2, draft #2092 at eb1ba5d47e6d5a35a0a6deb2b7532b4c045865f3.
import { describe, expect, it } from "vitest";
import {
  KIT_FALLBACK_INLINE_STYLE,
  KIT_FALLBACK_STYLE_SHA256,
  securityHeadersFor,
} from "../src/headers";
import { protectKitWorkerResponse } from "../src/kit-worker-response";

const env = { APP_URL: "https://togetherweown.com" };
const get = (path = "/about", headers: Record<string, string> = {}) =>
  new Request(`https://togetherweown.com${path}`, { headers });

describe("protectKitWorkerResponse", () => {
  it("returns a response that already carries every security header untouched", async () => {
    const complete = new Response("x", {
      headers: securityHeadersFor({ path: "/about", method: "GET" }, ""),
    });
    expect(await protectKitWorkerResponse(get(), complete, env)).toBe(complete);
  });

  it("adds headers, keeps the stream and both cookies, and mints a safe request id", async () => {
    const bare = new Response("{}", {
      status: 500,
      headers: { "content-type": "application/json" },
    });
    bare.headers.append("set-cookie", "a=1");
    bare.headers.append("set-cookie", "b=2");
    const out = await protectKitWorkerResponse(get(), bare, env);
    expect(out.status).toBe(500);
    expect(out.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(out.headers.get("cache-control")).toBe("private, no-store");
    expect(out.headers.get("x-two-renderer")).toBe("kit");
    expect(out.headers.get("x-request-id")).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(await out.text()).toBe("{}");
  });

  it("keeps a safe upstream request id and never echoes a hostile one", async () => {
    const safe = "0123456789abcdef-SJC";
    const bare = new Response("", { status: 500, headers: { "x-request-id": safe } });
    expect((await protectKitWorkerResponse(get(), bare, env)).headers.get("x-request-id")).toBe(
      safe,
    );
    const hostile = new Response("", { status: 500, headers: { "x-request-id": "bad id" } });
    const out = await protectKitWorkerResponse(get("/about", { "cf-ray": safe }), hostile, env);
    expect(out.headers.get("x-request-id")).toBe(safe);
  });

  it("allows the fallback style hash only for the exact fallback document", async () => {
    const html = { "content-type": "text/html" };
    const page = `<style>${KIT_FALLBACK_INLINE_STYLE}</style>`;
    const hit = await protectKitWorkerResponse(
      get(),
      new Response(page, { status: 500, headers: html }),
      env,
    );
    expect(hit.headers.get("content-security-policy")).toContain(KIT_FALLBACK_STYLE_SHA256);
    expect(hit.headers.get("content-type")).toBe("text/html; charset=UTF-8");
    const miss = await protectKitWorkerResponse(
      get(),
      new Response("<p>x</p>", { status: 500, headers: html }),
      env,
    );
    expect(miss.headers.get("content-security-policy")).not.toContain(KIT_FALLBACK_STYLE_SHA256);
    const ok = await protectKitWorkerResponse(
      get(),
      new Response(page, { status: 200, headers: html }),
      env,
    );
    expect(ok.headers.get("content-security-policy")).not.toContain(KIT_FALLBACK_STYLE_SHA256);
  });

  it("serves the restrictive policy when the error body cannot be probed", async () => {
    const response = new Response("x", { status: 500, headers: { "content-type": "text/html" } });
    response.clone = () => {
      throw new TypeError("unreadable");
    };
    const out = await protectKitWorkerResponse(get(), response, env);
    expect(out.headers.get("content-security-policy")).not.toContain(KIT_FALLBACK_STYLE_SHA256);
  });
});
