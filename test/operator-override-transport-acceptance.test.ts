// route-inventory: GET /admin/ops-overrides
// route-inventory: POST /admin/ops-overrides
// route-inventory: PUT /admin/ops-overrides
// route-inventory: PATCH /admin/ops-overrides
// route-inventory: DELETE /admin/ops-overrides
// route-inventory: OPTIONS /admin/ops-overrides
// Test Author owned: return corrections instead of editing these on the build card.
// These mounted-Worker proofs supplement, never replace, the original panel suite.
import { setTimeout as realDelay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";

const ORIGIN = "https://next.example.test";
const BOT_ORIGIN = "https://bot.example.test";
const TOKEN = "operator-override-fixture-".padEnd(32, "x");
const MAX_BODY = 256 * 1024;
const SENTINEL = "upstream-private-error-must-not-leak";
const record = () => ({
  epoch: 98741,
  overrides: { TWO_AUTOMOD_MENTION_LIMIT: "ovr-acc-7" },
  baseline: { TWO_AUTOMOD_MENTION_LIMIT: "baseline-5" },
  enforcement: "pending",
});
const bindings = (patch: Record<string, unknown> = {}): Env =>
  ({
    APP_URL: ORIGIN,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    SESSION_STORE: createMemorySessionStore(),
    BOT_ENDPOINT_URL: `${BOT_ORIGIN}/internal-action`,
    OPS_CONTROL_TOKEN: TOKEN,
    ...patch,
  }) as Env;
const request = async (init: RequestInit = {}, patch: Record<string, unknown> = {}, query = "") =>
  app.request(
    `/admin/ops-overrides${query}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: ORIGIN,
        ...Object.fromEntries(new Headers(init.headers)),
      },
    },
    bindings(patch),
  );

function installFetch(
  response: () => Response | Promise<Response> = () => Response.json(record()),
) {
  const stub = vi.fn<typeof fetch>(async () => response());
  vi.stubGlobal("fetch", stub);
  return stub;
}

async function expectUnavailable(res: Response) {
  expect(res.status).toBe(503);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("location")).toBeNull();
  const html = await res.text();
  expect(html).toMatch(/unavailable|unable to (?:load|read|fetch)/i);
  expect(html).not.toContain(SENTINEL);
  expect(html).not.toContain("ovr-acc-7");
  expect(html).not.toContain(TOKEN);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Admission hashes the real bearer with native crypto. Let the real event loop
// reach fetch before advancing the fake upstream deadline; never fake authentication.
async function waitForFetchEntry(entered: Promise<void>) {
  const timeout = new AbortController();
  try {
    await Promise.race([
      entered,
      realDelay(5000, undefined, { signal: timeout.signal }).then(() => {
        throw new Error("operator request did not enter upstream fetch");
      }),
    ]);
  } finally {
    timeout.abort();
  }
}

// Breaks caught: wrong upstream resource/verb/credential; redirect/retry;
// parsing before bounded consumption; indefinite fetch/body; unchecked schema;
// session admission; raw upstream HTML/errors; accidentally writable dashboard.
describe("operator override mounted transport contract", () => {
  beforeEach(() => {
    for (const method of ["log", "warn", "info", "error"] as const)
      vi.spyOn(console, method).mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([`${BOT_ORIGIN}/internal-action`, `${BOT_ORIGIN}/nested/action/`])(
    "fetches only the configured HTTPS origin's /ops/config from %s",
    async (endpoint) => {
      const remote = installFetch();
      const res = await request({}, { BOT_ENDPOINT_URL: endpoint });
      expect(res.status).toBe(200);
      expect(remote).toHaveBeenCalledTimes(1);
      const [input, init] = remote.mock.calls[0]!;
      const outbound = new Request(input, init);
      expect(outbound.url).toBe("https://bot.example.test/ops/config");
      expect(outbound.method).toBe("GET");
      expect(outbound.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(outbound.headers.get("cookie")).toBeNull();
      expect(outbound.redirect).not.toBe("follow");
      expect(await outbound.text()).toBe("");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    },
  );

  it.each([
    "http://bot.example.test/internal-action",
    "https://user:pass@bot.example.test/internal-action",
    "https://bot.example.test/internal-action?target=elsewhere",
    "https://bot.example.test/internal-action#fragment",
    "not a URL",
    "",
  ])("refuses unsafe endpoint %s without contacting it", async (endpoint) => {
    const remote = installFetch();
    const res = await request({}, { BOT_ENDPOINT_URL: endpoint });
    expect(remote).not.toHaveBeenCalled();
    await expectUnavailable(res);
  });

  it.each([301, 302, 303, 307, 308])(
    "refuses an upstream %s redirect without retry",
    async (status) => {
      const remote = installFetch(
        () =>
          new Response(SENTINEL, {
            status,
            headers: { location: `https://elsewhere.example.test/${SENTINEL}` },
          }),
      );
      await expectUnavailable(await request());
      expect(remote).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403, 429, 500, 503])(
    "degrades upstream %s once without leaking its body",
    async (status) => {
      const remote = installFetch(() => new Response(SENTINEL, { status }));
      await expectUnavailable(await request());
      expect(remote).toHaveBeenCalledTimes(1);
    },
  );

  it("turns a throwing fetch into a sanitized unavailable page, without retry", async () => {
    const remote = installFetch(() => {
      throw new Error(SENTINEL);
    });
    await expectUnavailable(await request());
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it("refuses malformed JSON rather than rendering raw upstream bytes", async () => {
    const remote = installFetch(() => new Response(`{"epoch":${SENTINEL}`));
    await expectUnavailable(await request());
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["negative epoch", { ...record(), epoch: -1 }],
    ["fractional epoch", { ...record(), epoch: 0.5 }],
    ["unsafe epoch", { ...record(), epoch: Number.MAX_SAFE_INTEGER + 1 }],
    ["string epoch", { ...record(), epoch: "98741" }],
    ["null overrides", { ...record(), overrides: null }],
    ["array overrides", { ...record(), overrides: [] }],
    ["non-string override", { ...record(), overrides: { LIMIT: 1 } }],
    ["array baseline", { ...record(), baseline: [] }],
    ["non-string baseline", { ...record(), baseline: { LIMIT: false } }],
    ["non-string enforcement", { ...record(), enforcement: { detail: SENTINEL } }],
    ["missing enforcement", { epoch: 1, overrides: {}, baseline: {} }],
  ])("refuses %s before rendering the record", async (_label, payload) => {
    const remote = installFetch(() => Response.json(payload));
    await expectUnavailable(await request());
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it.each([0, Number.MAX_SAFE_INTEGER])("accepts safe nonnegative epoch %s", async (epoch) => {
    const remote = installFetch(() => Response.json({ ...record(), epoch }));
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(String(epoch));
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it("accepts a well-formed body exactly at the byte cap", async () => {
    const json = JSON.stringify(record());
    const payload = json + " ".repeat(MAX_BODY - new TextEncoder().encode(json).length);
    const remote = installFetch(() => new Response(payload));
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ovr-acc-7");
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it.each(["declared", "streamed", "utf8"])(
    "refuses an oversized %s body before rendering it",
    async (kind) => {
      const json = JSON.stringify(record());
      // The UTF-8 case has fewer than 256 KiB characters but too many bytes.
      const payload =
        kind === "utf8"
          ? JSON.stringify({ ...record(), enforcement: "é".repeat(MAX_BODY / 2) })
          : json + " ".repeat(MAX_BODY + 1 - json.length);
      const remote = installFetch(
        () =>
          new Response(payload, {
            headers: kind === "declared" ? { "content-length": String(MAX_BODY + 1) } : {},
          }),
      );
      await expectUnavailable(await request());
      expect(remote).toHaveBeenCalledTimes(1);
    },
  );

  it("cancels a chunked response at its first overflow, even with a lying small length", async () => {
    let pulls = 0;
    const cancel = vi.fn();
    const remote = installFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>(
            {
              cancel,
              pull(controller) {
                pulls++;
                // Finite even for a broken consumer, so this proof cannot hang the suite.
                if (pulls > 512) {
                  controller.close();
                  return;
                }
                const prefix = pulls === 1 ? JSON.stringify(record()) : "";
                controller.enqueue(new TextEncoder().encode(prefix.padEnd(1024, " ")));
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-length": "1" } },
        ),
    );
    await expectUnavailable(await request());
    expect(remote).toHaveBeenCalledTimes(1);
    expect(pulls).toBeGreaterThan(256);
    expect(pulls).toBeLessThanOrEqual(258);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("bounds a fetch that never settles at five seconds", async () => {
    vi.useFakeTimers();
    const gate = deferred<Response>();
    const entered = deferred<void>();
    const remote = installFetch(() => {
      entered.resolve();
      return gate.promise;
    });
    let settled = false;
    const pending = request().then((res) => {
      settled = true;
      return res;
    });
    try {
      await waitForFetchEntry(entered.promise);
      await vi.advanceTimersByTimeAsync(4999);
      expect(remote).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(true);
      await expectUnavailable(await pending);
    } finally {
      gate.resolve(Response.json(record()));
      await pending;
    }
  });

  it("shares the five-second deadline across fetch and a stalled response body", async () => {
    vi.useFakeTimers();
    const headers = deferred<Response>();
    const body = deferred<void>();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode('{"epoch":'));
        await body.promise;
        if (!cancelled) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const upstream = new Response(stream);
    const entered = deferred<void>();
    const remote = installFetch(() => {
      entered.resolve();
      return headers.promise;
    });
    let settled = false;
    const pending = request().then((res) => {
      settled = true;
      return res;
    });
    try {
      await waitForFetchEntry(entered.promise);
      await vi.advanceTimersByTimeAsync(4000);
      expect(remote).toHaveBeenCalledTimes(1);
      headers.resolve(upstream);
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(true);
      await expectUnavailable(await pending);
    } finally {
      headers.resolve(upstream);
      body.resolve();
      await pending;
    }
  });

  it("escapes every rendered upstream field and omits unknown fields", async () => {
    installFetch(() =>
      Response.json({
        epoch: 98741,
        overrides: { "<override-key>": '<img src=x onerror="override-xss">' },
        baseline: { "<baseline-key>": '<svg onload="baseline-xss">' },
        enforcement: "<enforcement-state>",
        unknown: SENTINEL,
      }),
    );
    const res = await request();
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const raw of [
      "<override-key>",
      "<img src=x",
      "<baseline-key>",
      "<svg onload=",
      "<enforcement-state>",
    ])
      expect(html).not.toContain(raw);
    for (const escaped of [
      "&lt;override-key&gt;",
      "&lt;img",
      "&lt;baseline-key&gt;",
      "&lt;svg",
      "&lt;enforcement-state&gt;",
    ])
      expect(html).toContain(escaped);
    expect(html).not.toContain(SENTINEL);
    expect(html).not.toContain(TOKEN);
  });

  it("shows a timestamped empty snapshot, the 300-second runtime bound and no application claim", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T12:34:56.000Z"));
    installFetch(() =>
      Response.json({ epoch: 0, overrides: {}, baseline: {}, enforcement: "pending" }),
    );
    const res = await request();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/no (?:active )?overrides|overrides[^<]*(?:empty|none)/i);
    expect(html).toContain("2026-10-22");
    expect(html).toMatch(/snapshot/i);
    expect(html).toMatch(/(?:300\s*seconds?|5\s*minutes?)/i);
    expect(html).toMatch(/last[- ]good/i);
    expect(html).toMatch(
      /(?:no|not|does not|doesn't)[^<.]{0,80}(?:auto[- ]?refresh|refresh automatically)/i,
    );
    expect(html).toMatch(
      /(?:not|does not|doesn't)[^<.]{0,100}(?:confirm|prove|guarantee)[^<.]{0,100}(?:appl|enforc)/i,
    );
    expect(html).not.toMatch(/<meta[^>]+http-equiv=["']refresh["']/i);
    expect(html).not.toMatch(/<form\b/i);
    expect(html).toMatch(/operator/i);
  });

  it("never reads sessions, rotates cookies or uses the web throttle on a bearer read", async () => {
    const store = createMemorySessionStore();
    const sessionAccess = vi.fn();
    const guarded = new Proxy(store, {
      get(target, property, receiver) {
        sessionAccess(property);
        return Reflect.get(target, property, receiver);
      },
    });
    const throttle = vi.fn(async () => {
      throw new Error("web throttle must not be used");
    });
    const remote = installFetch();
    const res = await request(
      { headers: { cookie: "__Host-two_session=invalid.fixture" } },
      {
        SESSION_STORE: guarded,
        THROTTLE_STORE: throttle,
      },
    );
    expect(res.status).toBe(200);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(sessionAccess).not.toHaveBeenCalled();
    expect(throttle).not.toHaveBeenCalled();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("HEAD inherits bearer GET admission and headers, never a response body", async () => {
    const remote = installFetch();
    const res = await request({ method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe("");
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "%s is an explicit private 405, without upstream, session or throttle contact",
    async (method) => {
      const remote = installFetch();
      const throttle = vi.fn(async () => {
        throw new Error("unexpected web throttle");
      });
      const sessionAccess = vi.fn();
      const store = new Proxy(createMemorySessionStore(), {
        get(target, property, receiver) {
          sessionAccess(property);
          return Reflect.get(target, property, receiver);
        },
      });
      const res = await request(
        {
          method,
          body: "{}",
          headers: {
            "content-type": "application/json",
            cookie: "__Host-two_session=invalid.fixture",
          },
        },
        {
          THROTTLE_STORE: throttle,
          SESSION_STORE: store,
        },
      );
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(remote).not.toHaveBeenCalled();
      expect(throttle).not.toHaveBeenCalled();
      expect(sessionAccess).not.toHaveBeenCalled();
      expect(await res.text()).not.toContain("ovr-acc-7");
    },
  );

  it.each(["", "?epoch=1", "?token=fixture"])(
    "refuses missing bearer/query %s privately before contacting the bot",
    async (query) => {
      const remote = installFetch();
      const res = await request({ headers: { authorization: "" } }, {}, query);
      expect(res.status).toBe(query ? 400 : 401);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("location")).toBeNull();
      expect(remote).not.toHaveBeenCalled();
      expect(await res.text()).not.toContain("ovr-acc-7");
    },
  );

  it.each(["?epoch=1", "?token=fixture"])(
    "rejects query %s even with the correct bearer",
    async (query) => {
      const remote = installFetch();
      const res = await request({}, {}, query);
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(remote).not.toHaveBeenCalled();
      expect(await res.text()).not.toContain("ovr-acc-7");
    },
  );

  it.each([
    `bearer ${TOKEN}`,
    `Bearer  ${TOKEN}`,
    `Bearer\t${TOKEN}`,
    `Bearer ${TOKEN} extra`,
    `Bearer ${TOKEN}, Bearer ${TOKEN}`,
    `Basic ${TOKEN}`,
    `Bearer ${TOKEN.slice(0, -1)}z`,
    `Bearer ${TOKEN}x`,
  ])("requires one exact Bearer value: %s", async (authorization) => {
    const remote = installFetch();
    const res = await request({ headers: { authorization } });
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("location")).toBeNull();
    expect(remote).not.toHaveBeenCalled();
    expect(await res.text()).not.toContain("ovr-acc-7");
  });

  it("sanitizes a response body stream error without retrying", async () => {
    const remote = installFetch(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(SENTINEL));
            },
          }),
        ),
    );
    await expectUnavailable(await request());
    expect(remote).toHaveBeenCalledTimes(1);
  });

  it.each([31, 513])(
    "configured token length %s stays dark before upstream contact",
    async (length) => {
      const remote = installFetch();
      const token = "x".repeat(length);
      const res = await request(
        { headers: { authorization: `Bearer ${token}` } },
        { OPS_CONTROL_TOKEN: token },
      );
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(remote).not.toHaveBeenCalled();
    },
  );

  it.each([32, 512])("configured token length %s admits only its exact bearer", async (length) => {
    const remote = installFetch();
    const token = "x".repeat(length);
    const res = await request(
      { headers: { authorization: `Bearer ${token}` } },
      { OPS_CONTROL_TOKEN: token },
    );
    expect(res.status).toBe(200);
    expect(remote).toHaveBeenCalledTimes(1);
    expect(await res.text()).toContain("ovr-acc-7");
  });
});
