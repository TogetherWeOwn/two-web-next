// Differential pin: Hono sameOrigin vs the Kit same-origin twin.
//
// Hono guard: src/same-origin.ts:19-51 (exemptions :13-17, unsafe :4).
// Kit twin: src/route-ownership.ts:524-552 (`isSameOriginAllowed`).
// Both import the same constants, so this file pins the logic, not the lists:
// every agreement row drives the Hono middleware (via app requests against a
// minimal guard app) and the twin (direct) over identical method/path/headers/
// URL and asserts identical allow/refuse verdicts.
//
// Two input families currently split the halves and are pinned per-half
// instead of as agreement, so either alignment direction flips them red:
//   - Method case: fetch normalizes post/put/delete/get/head/options to
//     uppercase but not patch, so `patch`/`Patch`/`pAtCh` bypass the Hono
//     guard (raw compare, same-origin.ts:21) while the twin uppercases
//     (route-ownership.ts:525) and guards them.
//   - Encoded exempt paths: Hono matches exemptions against the decoded
//     c.req.path (same-origin.ts:23), while the twin matches URL.pathname,
//     which keeps %XX escapes (route-ownership.ts:528), so /%6dcp-style
//     spellings are exempt on Hono only.
// Aligning either family is a separately paired build slice: this file stays
// test-only and never changes the guard or the twin.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { isSameOriginAllowed } from "../src/route-ownership";
import { SAME_ORIGIN_EXEMPTIONS, UNSAFE_METHODS, sameOrigin } from "../src/same-origin";

const APP_URL = "https://two.test";
const GUARDED_PATH = "/write";
const guardedUrl = (host = "two.test", path = GUARDED_PATH) => `https://${host}${path}`;

function guardApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.use("*", sameOrigin);
  app.all("*", (c) => c.json({ ok: true }));
  return app;
}

const app = guardApp();

// Hono verdict via app request. Allow is the downstream 200; refuse is the one
// envelope (403 cross_origin + no-store private), never any other status.
async function honoAllows(
  url: string,
  method: string,
  headers: HeadersInit,
  appUrl: string,
): Promise<boolean> {
  const res = await app.request(url, { method, headers }, { APP_URL: appUrl } as unknown as Env);
  if (res.status === 200) {
    // HEAD answers 200 with an empty body; every other allow carries the probe.
    if (method !== "HEAD") expect(await res.json()).toEqual({ ok: true });
    return true;
  }
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "cross_origin" });
  expect(res.headers.get("cache-control")).toBe("no-store, private");
  return false;
}

function twinAllows(url: string, method: string, headers: HeadersInit, appUrl: string): boolean {
  return isSameOriginAllowed(new Request(url, { method, headers }), appUrl);
}

async function expectSameVerdict(
  url: string,
  method: string,
  headers: HeadersInit,
  appUrl: string,
  expected: boolean,
  label: string,
): Promise<void> {
  const hono = await honoAllows(url, method, headers, appUrl);
  const twin = twinAllows(url, method, headers, appUrl);
  expect(hono, `Hono ${label}`).toBe(expected);
  expect(twin, `Kit twin ${label}`).toBe(expected);
  expect(twin, `differential ${label}`).toBe(hono);
}

// Known-divergence pin: asserts each half's current verdict separately. Used
// only for the two families named in the header; every other row must agree.
async function expectKnownDivergence(
  url: string,
  method: string,
  headers: HeadersInit,
  appUrl: string,
  expected: { hono: boolean; twin: boolean },
  label: string,
): Promise<void> {
  const hono = await honoAllows(url, method, headers, appUrl);
  const twin = twinAllows(url, method, headers, appUrl);
  expect(hono, `Hono ${label}`).toBe(expected.hono);
  expect(twin, `Kit twin ${label}`).toBe(expected.twin);
}

describe("same-origin differential (Hono guard vs Kit twin)", () => {
  it("refuses explicit null and malformed Origins on both halves", async () => {
    // An explicit Origin always wins, including "null" or a malformed value:
    // none of these may fall through to Fetch Metadata.
    const origins = [
      "null",
      "",
      "https://evil.test",
      "https://two.test.evil.test",
      "http://two.test",
      "https://two.test:444",
      "https://two.test/path",
      "https://two.test/",
      "https://two.test https://evil.test",
    ];
    for (const method of UNSAFE_METHODS) {
      for (const origin of origins) {
        await expectSameVerdict(
          guardedUrl(),
          method,
          { origin },
          APP_URL,
          false,
          `${method} ${GUARDED_PATH} origin=${JSON.stringify(origin)}`,
        );
      }
      // Explicit Origin wins over a same-origin Fetch Metadata hint.
      await expectSameVerdict(
        guardedUrl(),
        method,
        { origin: "https://evil.test", "sec-fetch-site": "same-origin" },
        APP_URL,
        false,
        `${method} ${GUARDED_PATH} evil origin + same-origin hint`,
      );
    }
  });

  it("admits the exact APP_URL Origin and the matching Fetch Metadata fallback on both", async () => {
    for (const method of UNSAFE_METHODS) {
      await expectSameVerdict(
        guardedUrl(),
        method,
        { origin: APP_URL },
        APP_URL,
        true,
        `${method} ${GUARDED_PATH} exact origin`,
      );
      await expectSameVerdict(
        guardedUrl(),
        method,
        { "sec-fetch-site": "same-origin" },
        APP_URL,
        true,
        `${method} ${GUARDED_PATH} same-origin hint on APP_URL host`,
      );
    }
  });

  it("matches on the Sec-Fetch-Site fallback: non-matching host and non-origin hints refuse", async () => {
    const nonOriginHints = ["same-site", "cross-site", "none", ""];
    for (const method of UNSAFE_METHODS) {
      // Fallback asserts same-origin relative to the request host, which must
      // itself be APP_URL: an alternate host refuses even with the hint.
      await expectSameVerdict(
        guardedUrl("alternate.test"),
        method,
        { "sec-fetch-site": "same-origin" },
        APP_URL,
        false,
        `${method} ${GUARDED_PATH} same-origin hint on alternate host`,
      );
      // The fallback compares full origins, not hosts: a scheme or port
      // mismatch refuses even when the hostname matches APP_URL.
      await expectSameVerdict(
        `http://two.test${GUARDED_PATH}`,
        method,
        { "sec-fetch-site": "same-origin" },
        APP_URL,
        false,
        `${method} ${GUARDED_PATH} same-origin hint on http scheme`,
      );
      await expectSameVerdict(
        `https://two.test:444${GUARDED_PATH}`,
        method,
        { "sec-fetch-site": "same-origin" },
        APP_URL,
        false,
        `${method} ${GUARDED_PATH} same-origin hint on non-APP_URL port`,
      );
      // Absent Origin with a non-same-origin hint (or no hint at all) refuses.
      await expectSameVerdict(
        guardedUrl(),
        method,
        {},
        APP_URL,
        false,
        `${method} ${GUARDED_PATH} no origin, no hint`,
      );
      for (const hint of nonOriginHints) {
        await expectSameVerdict(
          guardedUrl(),
          method,
          { "sec-fetch-site": hint },
          APP_URL,
          false,
          `${method} ${GUARDED_PATH} hint=${JSON.stringify(hint)}`,
        );
      }
    }
  });

  it("pins method casing: fetch-normalized verbs agree, patch-family splits", async () => {
    // fetch uppercases post/put/delete/get/head/options before either half
    // sees them, so both halves see the same method and agree; patch is not
    // normalized, so the Hono raw compare bypasses while the twin uppercases
    // and guards. Unknown verbs agree-allow on both.
    for (const method of ["post", "Post", "put", "delete"]) {
      await expectSameVerdict(
        guardedUrl(),
        method,
        { origin: "https://evil.test" },
        APP_URL,
        false,
        `${method} ${GUARDED_PATH} evil origin agrees refuse`,
      );
    }
    for (const method of ["get", "purge"]) {
      await expectSameVerdict(
        guardedUrl(),
        method,
        { origin: "https://evil.test" },
        APP_URL,
        true,
        `${method} ${GUARDED_PATH} evil origin agrees allow`,
      );
    }
    // Exact Origin admits on both, for different reasons: Hono bypasses the
    // guard entirely while the twin checks and admits.
    await expectSameVerdict(
      guardedUrl(),
      "patch",
      { origin: APP_URL },
      APP_URL,
      true,
      `patch ${GUARDED_PATH} exact origin agrees allow`,
    );
    const splitHeaders: HeadersInit[] = [{ origin: "https://evil.test" }, { origin: "null" }, {}];
    for (const method of ["patch", "Patch", "pAtCh"]) {
      for (const headers of splitHeaders) {
        await expectKnownDivergence(
          guardedUrl(),
          method,
          headers,
          APP_URL,
          { hono: true, twin: false },
          `${method} ${GUARDED_PATH} headers=${JSON.stringify(headers)}`,
        );
      }
    }
  });

  it("allows every documented exemption on both halves, independent of Origin", async () => {
    expect(SAME_ORIGIN_EXEMPTIONS).toEqual([
      { method: "POST", path: "/api/agent-events" },
      { method: "POST", path: "/csp-reports" },
      { method: "POST", path: "/mcp" },
    ]);
    const headerCases: HeadersInit[] = [
      {},
      { origin: "https://evil.test" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
    ];
    for (const { method, path } of SAME_ORIGIN_EXEMPTIONS) {
      for (const headers of headerCases) {
        await expectSameVerdict(
          guardedUrl("two.test", path),
          method,
          headers,
          APP_URL,
          true,
          `exempt ${method} ${path} headers=${JSON.stringify(headers)}`,
        );
      }
      // Query strings do not move a path off its exact exemption.
      await expectSameVerdict(
        `${guardedUrl("two.test", path)}?next=1`,
        method,
        { origin: "https://evil.test" },
        APP_URL,
        true,
        `exempt ${method} ${path} with query`,
      );
    }
  });

  it("keeps exemptions exact on both: prefixes and other verbs refuse", async () => {
    for (const { method, path } of SAME_ORIGIN_EXEMPTIONS) {
      for (const candidate of [`${path}/`, `${path}/write`]) {
        await expectSameVerdict(
          guardedUrl("two.test", candidate),
          method,
          { origin: "https://evil.test" },
          APP_URL,
          false,
          `prefix ${method} ${candidate}`,
        );
      }
      for (const candidate of UNSAFE_METHODS.filter((m) => m !== method)) {
        await expectSameVerdict(
          guardedUrl("two.test", path),
          candidate,
          { origin: "https://evil.test" },
          APP_URL,
          false,
          `non-exempt verb ${candidate} ${path}`,
        );
      }
    }
  });

  it("pins percent-encoded spellings: guarded paths agree, exempt spellings split", async () => {
    // An encoded guarded path agrees on both; an encoded exempt spelling is
    // exempt on Hono (decoded c.req.path) but guarded on the twin
    // (URL.pathname keeps escapes). Exact Origin admits on both either way.
    await expectSameVerdict(
      guardedUrl("two.test", "/writ%65"),
      "POST",
      { origin: "https://evil.test" },
      APP_URL,
      false,
      "encoded guarded path evil origin agrees refuse",
    );
    await expectSameVerdict(
      guardedUrl("two.test", "/writ%65"),
      "POST",
      { origin: APP_URL },
      APP_URL,
      true,
      "encoded guarded path exact origin agrees allow",
    );
    const encodedExempt = ["/%6dcp", "/m%63p", "/%63sp-reports", "/api/agent%2devents"];
    const splitHeaders: HeadersInit[] = [{ origin: "https://evil.test" }, { origin: "null" }, {}];
    for (const path of encodedExempt) {
      await expectSameVerdict(
        guardedUrl("two.test", path),
        "POST",
        { origin: APP_URL },
        APP_URL,
        true,
        `encoded exempt ${path} exact origin agrees allow`,
      );
      for (const headers of splitHeaders) {
        await expectKnownDivergence(
          guardedUrl("two.test", path),
          "POST",
          headers,
          APP_URL,
          { hono: true, twin: false },
          `encoded exempt ${path} headers=${JSON.stringify(headers)}`,
        );
      }
    }
  });

  it("refuses the PUT-/mcp non-exemption on both halves", async () => {
    // POST /mcp is exempt (pinned above); PUT /mcp is a guarded write: evil
    // Origin and absent-hint requests refuse, the exact Origin admits.
    await expectSameVerdict(
      guardedUrl("two.test", "/mcp"),
      "PUT",
      { origin: "https://evil.test" },
      APP_URL,
      false,
      "PUT /mcp evil origin",
    );
    await expectSameVerdict(
      guardedUrl("two.test", "/mcp"),
      "PUT",
      {},
      APP_URL,
      false,
      "PUT /mcp no origin, no hint",
    );
    await expectSameVerdict(
      guardedUrl("two.test", "/mcp"),
      "PUT",
      { origin: "null" },
      APP_URL,
      false,
      "PUT /mcp null origin",
    );
    await expectSameVerdict(
      guardedUrl("two.test", "/mcp"),
      "PUT",
      { origin: APP_URL },
      APP_URL,
      true,
      "PUT /mcp exact origin",
    );
    await expectSameVerdict(
      guardedUrl("two.test", "/mcp"),
      "PUT",
      { "sec-fetch-site": "same-origin" },
      APP_URL,
      true,
      "PUT /mcp same-origin hint on APP_URL host",
    );
  });

  it("leaves safe methods alone on both halves", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      await expectSameVerdict(
        guardedUrl(),
        method,
        { origin: "https://evil.test" },
        APP_URL,
        true,
        `${method} ${GUARDED_PATH} evil origin bypasses guard`,
      );
    }
  });

  it("parses APP_URL as an origin on both: slash, subpath, port, and scheme", async () => {
    // docs/same-origin.md: a configured trailing slash or path is not part
    // of the origin; scheme and port matter. The raw configured string must
    // never be compared directly.
    for (const appUrl of ["https://two.test/", "https://two.test/base", "https://two.test:443"]) {
      await expectSameVerdict(
        guardedUrl(),
        "POST",
        { origin: "https://two.test" },
        appUrl,
        true,
        `POST ${GUARDED_PATH} APP_URL=${appUrl} exact origin admits`,
      );
    }
    await expectSameVerdict(
      guardedUrl(),
      "POST",
      { origin: "http://two.test" },
      "http://two.test",
      true,
      "http APP_URL matching http origin admits",
    );
    await expectSameVerdict(
      guardedUrl(),
      "POST",
      { origin: "https://two.test" },
      "http://two.test",
      false,
      "http APP_URL https origin refuses",
    );
    await expectSameVerdict(
      guardedUrl(),
      "POST",
      { origin: "https://two.test:8443" },
      "https://two.test:8443",
      true,
      "port APP_URL matching origin admits",
    );
    await expectSameVerdict(
      guardedUrl(),
      "POST",
      { origin: "https://two.test" },
      "https://two.test:8443",
      false,
      "port APP_URL bare origin refuses",
    );
  });

  it("fails closed on invalid APP_URL on both halves in the same run", async () => {
    for (const appUrl of ["", "not a URL", "file:///two", "null"]) {
      // Even the normally-admitting headers refuse when config is unparseable.
      await expectSameVerdict(
        guardedUrl(),
        "POST",
        { origin: "https://two.test", "sec-fetch-site": "same-origin" },
        appUrl,
        false,
        `POST ${GUARDED_PATH} invalid APP_URL=${JSON.stringify(appUrl)}`,
      );
      // A null Origin must not satisfy a non-HTTP(S) config whose URL origin
      // is the string "null": the protocol gate fails closed first.
      await expectSameVerdict(
        guardedUrl(),
        "POST",
        { origin: "null" },
        appUrl,
        false,
        `POST ${GUARDED_PATH} null origin invalid APP_URL=${JSON.stringify(appUrl)}`,
      );
      // Layering stays identical too: exact exemptions bypass the guard before
      // the config check, on both halves.
      await expectSameVerdict(
        guardedUrl("two.test", "/mcp"),
        "POST",
        { origin: "https://evil.test" },
        appUrl,
        true,
        `exempt POST /mcp invalid APP_URL=${JSON.stringify(appUrl)}`,
      );
    }
  });
});
