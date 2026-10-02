// Parity matrix "Home support" row: the Discord widget iframe must never cost
// the page. A Discord outage, a hung probe or a rate limit only swaps the
// /join preview for the static fallback; the response never waits on Discord,
// and the home shell never embeds or fetches the widget at all. Local
// transports only: no request leaves the test process.
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { DISCORD_HTTP_BUDGET_MS } from "../src/discord-http";
import {
  DISCORD_WIDGET_VERDICT_TTL_MS,
  createDiscordWidgetHealth,
  discordWidgetHealth,
} from "../src/discord-widget";

const GUILD = "326474832151838730";
const PROBE_URL = `https://discord.com/api/v10/guilds/${GUILD}/widget.json`;
const IFRAME = `src="https://discord.com/widget?id=${GUILD}&amp;theme=dark" width="350" height="500"`;
const FALLBACK = '<div class="join-preview"><p class="strap" data-testid="join-widget-fallback">';

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: GUILD,
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

type Transport = (url: string, init?: RequestInit) => Promise<Response>;

function harness(transport: Transport, overrides: Partial<Env> = {}) {
  let clock = 0;
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    return transport(String(input), init);
  });
  // /join reads the module's widget health and no binding (static-theme
  // guard), so each test swaps in a fresh instance on its own clock.
  const widget = createDiscordWidgetHealth({
    fetch: fetch as typeof globalThis.fetch,
    now: () => clock,
  });
  vi.spyOn(discordWidgetHealth, "url").mockImplementation(widget.url);
  const bindings = { ...env, ...overrides };
  return {
    calls,
    inits: () => fetch.mock.calls.map(([, init]) => init),
    advance: (ms: number) => {
      clock += ms;
    },
    // One /join request with a Workers-style execution context; background
    // probes land in `pending` instead of the response path.
    async join(withContext = true) {
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException() {},
        props: {},
      };
      const res = await app.request("/join", {}, bindings, withContext ? ctx : undefined);
      return { status: res.status, html: await res.text(), pending };
    },
  };
}

function expectIframe(html: string) {
  expect(html).toContain(IFRAME);
  expect(html).toContain('loading="lazy"');
  expect(html).not.toContain('data-testid="join-widget-fallback"');
}

function expectFallback(html: string) {
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain("discord.com/widget");
  // Same slot as the iframe, so the two-column layout keeps its shape.
  expect(html).toContain(FALLBACK);
  expect(html).toContain("Live server preview is unavailable");
  // The conversion paths never depended on Discord answering the widget.
  expect(html).toContain('href="/join/discord" data-testid="join-oneclick"');
  expect(html).toContain('href="https://discord.gg/invite" data-testid="join-invite"');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("/join Discord widget: success", () => {
  it("keeps the lazy, fixed-size iframe and probes once per verdict window", async () => {
    const h = harness(async () => Response.json({ id: GUILD, presence_count: 12 }));
    const first = await h.join();
    expect(first.status).toBe(200);
    expectIframe(first.html);
    expect(first.pending).toHaveLength(1);
    await Promise.all(first.pending);
    expect(h.calls).toEqual([PROBE_URL]);
    // A bare GET: no credential or member cookie ever reaches the probe.
    const [init] = h.inits();
    expect(init?.method ?? "GET").toBe("GET");
    expect([...new Headers(init?.headers).keys()]).toEqual([]);

    const second = await h.join();
    expectIframe(second.html);
    expect(second.pending).toHaveLength(0);

    h.advance(DISCORD_WIDGET_VERDICT_TTL_MS);
    const third = await h.join();
    expectIframe(third.html);
    await Promise.all(third.pending);
    expect(h.calls).toEqual([PROBE_URL, PROBE_URL]);
  });

  it("treats a rate limit as no new information", async () => {
    let status = 200;
    const h = harness(async () => new Response("{}", { status }));
    await Promise.all((await h.join()).pending);
    status = 429;
    h.advance(DISCORD_WIDGET_VERDICT_TTL_MS);
    await Promise.all((await h.join()).pending);
    expectIframe((await h.join()).html);
  });
});

describe("/join Discord widget: outage", () => {
  const outages: [string, Transport][] = [
    ["503 from Discord", async () => new Response("upstream-private-body", { status: 503 })],
    ["500 from Discord", async () => new Response("upstream-private-body", { status: 500 })],
    [
      "widget disabled (403)",
      async () => Response.json({ code: 50004, message: "upstream-private-body" }, { status: 403 }),
    ],
    [
      "network failure",
      async () => {
        throw new TypeError("fetch failed upstream-private-body");
      },
    ],
  ];

  it.each(outages)(
    "%s renders the static fallback with a 200 and logs no body",
    async (_name, transport) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const h = harness(transport);
      // The first view answers from the (optimistic) verdict; the probe runs after.
      const first = await h.join();
      expect(first.status).toBe(200);
      expectIframe(first.html);
      await Promise.all(first.pending);

      const degraded = await h.join();
      expect(degraded.status).toBe(200);
      expectFallback(degraded.html);
      expect(degraded.pending).toHaveLength(0);
      expect(warn).toHaveBeenCalledOnce();
      expect(JSON.stringify(warn.mock.calls)).not.toContain("upstream-private-body");

      // Still down at the next window: fallback stays, no repeat warning.
      h.advance(DISCORD_WIDGET_VERDICT_TTL_MS);
      const stillDown = await h.join();
      expectFallback(stillDown.html);
      await Promise.all(stillDown.pending);
      expect(warn).toHaveBeenCalledOnce();
    },
  );

  it("restores the iframe once Discord answers again", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let healthy = false;
    const h = harness(async () => new Response("{}", { status: healthy ? 200 : 503 }));
    await Promise.all((await h.join()).pending);
    expectFallback((await h.join()).html);

    healthy = true;
    h.advance(DISCORD_WIDGET_VERDICT_TTL_MS);
    const stale = await h.join();
    expectFallback(stale.html);
    await Promise.all(stale.pending);
    expectIframe((await h.join()).html);
  });
});

describe("/join Discord widget: timeout", () => {
  it("never holds the page on a hung probe, then falls back after the Discord budget", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Ignores the abort signal and never settles: the worst slow Discord.
    const h = harness(() => new Promise<Response>(() => {}));

    // No timer has advanced, yet the page is complete: nothing awaits the probe.
    const first = await h.join();
    expect(first.status).toBe(200);
    expectIframe(first.html);
    expect(first.pending).toHaveLength(1);

    // Concurrent views while the probe hangs: same page, no probe pile-up.
    const during = await h.join();
    expectIframe(during.html);
    expect(during.pending).toHaveLength(0);
    expect(h.calls).toEqual([PROBE_URL]);

    await vi.advanceTimersByTimeAsync(DISCORD_HTTP_BUDGET_MS);
    await Promise.all(first.pending);
    const after = await h.join();
    expect(after.status).toBe(200);
    expectFallback(after.html);
  });
});

describe("/join Discord widget: probe guards", () => {
  it("probes nothing without an execution context to carry it", async () => {
    const h = harness(async () => new Response("{}", { status: 503 }));
    const res = await h.join(false);
    expect(res.status).toBe(200);
    expectIframe(res.html);
    expect(h.calls).toEqual([]);
  });

  it("probes nothing for an invalid guild and keeps the copy fallback", async () => {
    const h = harness(async () => new Response("{}"), { DISCORD_GUILD_ID: "unset" });
    const res = await h.join();
    expect(res.status).toBe(200);
    expectFallback(res.html);
    expect(res.pending).toHaveLength(0);
    expect(h.calls).toEqual([]);
  });
});

describe("home shell during a Discord outage", () => {
  it("stays 200 with the static lobby link and never reaches for the widget", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        throw new TypeError("discord is down");
      }),
    );
    const ctx = { waitUntil: vi.fn(), passThroughOnException() {}, props: {} };
    const res = await app.request("/", {}, env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("frame-src 'none';");
    const html = await res.text();
    expect(html).not.toContain("<iframe");
    expect(html).toContain('<a href="/join#join-heading" data-testid="home-widget-link">');
    expect(html).toContain('<a href="/discord" data-testid="home-discord-invite">');
    expect(calls.filter((url) => url.includes("/widget"))).toEqual([]);
  });
});
