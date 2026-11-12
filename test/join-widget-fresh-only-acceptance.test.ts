// Acceptance: fresh-only widget presence on /join (E2).
//
// Under sustained Discord 429s the join widget snapshot never ages out by the
// verdict clock (checkedAt refreshes with no new information) yet renders as
// "N members online now". These fixtures pin the fix: a snapshot older than a
// bounded multiple of the verdict TTL is dropped to the existing non-presence
// render (facade strap or static fallback) instead of served as "now";
// 429-no-new-information preserves data only within that bound and cannot
// refresh freshness indefinitely; live copy ("now"/"right now") renders only
// on fresh snapshots, else a qualified ("as of"/updated-ago) presence or the
// non-presence render. Hono and Kit /join stay in parity (same gating, same
// copy); a fresh snapshot renders unchanged; missing-execution-context reads
// go stale the same way; no new fetches join the response path.
//
// Owned by the Test Author; the Builder builds on this branch and never edits
// this file. Failing-first: positive controls pass at the evidence pin, the
// rest fail until the build lands. Local stub transports only: no request
// leaves the test process, no Discord fetch, no database.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import {
  DISCORD_WIDGET_VERDICT_TTL_MS,
  createDiscordWidgetHealth,
  discordWidgetHealth,
} from "../src/discord-widget";

const GUILD = "326474832151838730";
const TTL = DISCORD_WIDGET_VERDICT_TTL_MS;
// Any reasonable "bounded multiple of the verdict TTL" is at most 10x. A
// snapshot this old must be dropped no matter what the Builder's exact bound
// is (2x, 3x, 5x all satisfy these pins).
const DEFINITELY_STALE_AGE_MS = 10 * TTL + 1;
// Intermediate staleness: older than one verdict TTL, so no longer "now", but
// young enough that the Builder may either qualify ("as of"/"ago") or drop.
const JUST_STALE_AGE_MS = 2 * TTL;
// Sustained-429 horizon: twelve verdict windows of no new information. Any
// bound at most 10x must have dropped by here.
const SUSTAINED_429_WINDOWS = 12;

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: GUILD,
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

function widgetPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: GUILD,
    name: "Together We Own",
    instant_invite: "https://discord.gg/widget-invite",
    presence_count: 42,
    channels: [
      { id: "2", name: "lobby-voice", position: 2 },
      { id: "1", name: "stage-night", position: 1 },
    ],
    members: [
      {
        id: "opaque-1",
        username: "rick",
        discriminator: "0",
        avatar: null,
        status: "online",
        avatar_url: null,
      },
    ],
    ...overrides,
  };
}

type Transport = (url: string) => Promise<Response>;

function harness(transport: Transport) {
  let clock = 0;
  const calls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return transport(String(input));
  });
  const widget = createDiscordWidgetHealth({
    fetch: fetch as typeof globalThis.fetch,
    now: () => clock,
  });
  vi.spyOn(discordWidgetHealth, "url").mockImplementation(widget.url);
  vi.spyOn(discordWidgetHealth, "snapshot").mockImplementation(widget.snapshot);
  return {
    calls,
    advance: (ms: number) => {
      clock += ms;
    },
    async join(withContext = true) {
      const pending: Promise<unknown>[] = [];
      const ctx = {
        waitUntil: (p: Promise<unknown>) => pending.push(p),
        passThroughOnException() {},
        props: {},
      };
      const res = await app.request("/join", {}, env, withContext ? ctx : undefined);
      return {
        status: res.status,
        html: await res.text(),
        pending,
        cacheControl: res.headers.get("cache-control"),
      };
    },
  };
}

function expectPresence(html: string) {
  expect(html).toContain('data-testid="join-widget-presence"');
}

function expectNoPresence(html: string) {
  expect(html).not.toContain('data-testid="join-widget-presence"');
}

function expectNoLiveCopy(html: string) {
  expect(html).not.toContain("In Together We Own now");
  expect(html).not.toContain("right now");
}

function expectNonPresenceRender(html: string) {
  // Either the facade strap (preview button, no presence) or the full static
  // fallback paragraph. Both are "not served as now".
  expect(html).toMatch(/join-widget-load|join-widget-fallback/);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fresh snapshot renders unchanged (positive controls)", () => {
  it("renders presence with live copy and a 60 s cache", async () => {
    const h = harness(async () => Response.json(widgetPayload()));
    const first = await h.join();
    expect(first.status).toBe(200);
    await Promise.all(first.pending);

    const second = await h.join();
    expect(second.status).toBe(200);
    expectPresence(second.html);
    expect(second.html).toContain("In Together We Own now");
    expect(second.html).toContain("42");
    expect(second.html).toContain("members online");
    expect(second.html).toContain("stage-night");
    expect(second.html).toContain("https://discord.gg/widget-invite");
    expect(second.html).not.toContain("rick");
    expect(second.cacheControl).toBe("public, max-age=60");
  });

  it("renders the empty-channels copy with live wording when fresh", async () => {
    const h = harness(async () => Response.json(widgetPayload({ channels: [] })));
    await Promise.all((await h.join()).pending);

    const warm = await h.join();
    expectPresence(warm.html);
    expect(warm.html).toContain("No voice channels open right now.");
  });

  it("a single 429 within the verdict TTL preserves the fresh presence", async () => {
    let status = 200;
    const h = harness(async () => new Response(JSON.stringify(widgetPayload()), { status }));
    await Promise.all((await h.join()).pending);
    const warm = await h.join();
    expectPresence(warm.html);

    // Half a TTL later the snapshot is still fresh; one rate-limited window
    // keeps the data and the live copy.
    status = 429;
    h.advance(Math.floor(TTL / 2));
    await Promise.all((await h.join()).pending);
    const limited = await h.join();
    expect(limited.status).toBe(200);
    expectPresence(limited.html);
    expect(limited.html).toContain("In Together We Own now");
  });
});

describe("stale snapshot drops to the non-presence render", () => {
  it("a snapshot older than the bound is dropped instead of served as now", async () => {
    const h = harness(async () => Response.json(widgetPayload()));
    await Promise.all((await h.join()).pending);
    const warm = await h.join();
    expectPresence(warm.html);

    // Age past any reasonable bound. The stale read happens before the
    // re-probe it schedules can settle, so this response must already drop.
    h.advance(DEFINITELY_STALE_AGE_MS);
    const stale = await h.join();
    expect(stale.status).toBe(200);
    expectNoPresence(stale.html);
    expectNoLiveCopy(stale.html);
    expectNonPresenceRender(stale.html);
    expect(stale.cacheControl).toBe("public, max-age=3600");

    // The background re-probe still refreshes: the next read is fresh again.
    await Promise.all(stale.pending);
    const refreshed = await h.join();
    expectPresence(refreshed.html);
    expect(refreshed.html).toContain("In Together We Own now");
  });

  it("snapshot() gates on age, not just guild and availability", async () => {
    let clock = 0;
    const widget = createDiscordWidgetHealth({
      fetch: (async () => Response.json(widgetPayload())) as typeof globalThis.fetch,
      now: () => clock,
    });
    const pending: Promise<unknown>[] = [];
    widget.url(GUILD, (p) => pending.push(p));
    await Promise.all(pending);
    expect(widget.snapshot(GUILD)).not.toBeNull();

    clock += DEFINITELY_STALE_AGE_MS;
    expect(widget.snapshot(GUILD)).toBeNull();
  });
});

describe("sustained 429s cannot refresh freshness indefinitely", () => {
  it("twelve verdict windows of 429s age the snapshot out to the fallback", async () => {
    let status = 200;
    const h = harness(async () => new Response(JSON.stringify(widgetPayload()), { status }));
    await Promise.all((await h.join()).pending);
    expectPresence((await h.join()).html);

    status = 429;
    for (let i = 0; i < SUSTAINED_429_WINDOWS; i += 1) {
      h.advance(TTL);
      await Promise.all((await h.join()).pending);
    }
    const aged = await h.join();
    expect(aged.status).toBe(200);
    expectNoPresence(aged.html);
    expectNoLiveCopy(aged.html);
    expectNonPresenceRender(aged.html);
    expect(aged.cacheControl).toBe("public, max-age=3600");
  });
});

describe("live copy renders only on fresh snapshots", () => {
  it("a just-stale snapshot never renders unqualified now copy", async () => {
    const h = harness(async () => Response.json(widgetPayload()));
    await Promise.all((await h.join()).pending);
    expectPresence((await h.join()).html);

    h.advance(JUST_STALE_AGE_MS);
    const stale = await h.join();
    expect(stale.status).toBe(200);
    expectNoLiveCopy(stale.html);
    if (stale.html.includes('data-testid="join-widget-presence"')) {
      // Preserved-but-stale presence must qualify itself.
      expect(stale.html).toMatch(/as of|ago/i);
    } else {
      expectNonPresenceRender(stale.html);
    }
    await Promise.all(stale.pending);
  });

  it("a just-stale empty-channels snapshot never renders right now copy", async () => {
    const h = harness(async () => Response.json(widgetPayload({ channels: [] })));
    await Promise.all((await h.join()).pending);
    const warm = await h.join();
    expect(warm.html).toContain("No voice channels open right now.");

    h.advance(JUST_STALE_AGE_MS);
    const stale = await h.join();
    expect(stale.status).toBe(200);
    expect(stale.html).not.toContain("No voice channels open right now.");
    expectNoLiveCopy(stale.html);
    await Promise.all(stale.pending);
  });
});

describe("missing execution context goes stale the same way", () => {
  it("a fresh snapshot still renders without a context (positive control)", async () => {
    const h = harness(async () => Response.json(widgetPayload()));
    await Promise.all((await h.join()).pending);
    expectPresence((await h.join()).html);

    const fresh = await h.join(false);
    expect(fresh.status).toBe(200);
    expectPresence(fresh.html);
    expect(fresh.html).toContain("In Together We Own now");
    expect(h.calls).toHaveLength(1);
  });

  it("a stale snapshot without a context drops instead of serving now", async () => {
    const h = harness(async () => Response.json(widgetPayload()));
    await Promise.all((await h.join()).pending);
    expectPresence((await h.join()).html);

    h.advance(DEFINITELY_STALE_AGE_MS);
    const stale = await h.join(false);
    expect(stale.status).toBe(200);
    expectNoPresence(stale.html);
    expectNoLiveCopy(stale.html);
    expectNonPresenceRender(stale.html);
    // No carrier, no probe: staleness drops locally without fetching.
    expect(h.calls).toHaveLength(1);
  });
});

describe("no new fetches on the response path", () => {
  it("a stale read schedules at most one background probe and never waits", async () => {
    const h = harness(async () => Response.json(widgetPayload()));
    await Promise.all((await h.join()).pending);
    expect(h.calls).toHaveLength(1);

    h.advance(DEFINITELY_STALE_AGE_MS);
    const stale = await h.join();
    expect(stale.status).toBe(200);
    // The response is complete without awaiting the probe: at most one
    // background probe was scheduled, nothing was awaited inline.
    expect(stale.pending.length).toBeLessThanOrEqual(1);
    await Promise.all(stale.pending);
    expect(h.calls).toHaveLength(2);
  });
});

describe("Hono and Kit /join stay in parity (same gating, same copy)", () => {
  const honoJoin = readFileSync(new NodeURL("../src/screens/join.tsx", import.meta.url), "utf8");
  const kitJoin = readFileSync(
    new NodeURL("../web/src/routes/join/+page.svelte", import.meta.url),
    "utf8",
  );

  it("both presence renders keep the fresh live copy and qualify stale the same way", () => {
    // Fresh snapshots keep the live copy on both renderers.
    expect(honoJoin).toContain("now");
    expect(kitJoin).toContain("now");
    // Qualified copy ("as of"/updated-ago) is either present in both or
    // absent in both: the Builder may drop every stale snapshot to the
    // non-presence render (no qualified copy anywhere) or qualify
    // preserved-but-stale presence, but Hono and Kit must match.
    const qualified = /\bas of\b|\bago\b/i;
    expect(qualified.test(kitJoin)).toBe(qualified.test(honoJoin));
  });

  it("both renders keep the same presence testids and fallback slot", () => {
    for (const needle of [
      'data-testid="join-widget-presence"',
      'data-testid="join-widget-online"',
      'data-testid="join-widget-channels"',
      'data-testid="join-widget-invite"',
      'data-testid="join-widget-load"',
      'data-testid="join-widget-fallback"',
    ]) {
      expect(honoJoin, `Hono missing ${needle}`).toContain(needle);
      expect(kitJoin, `Kit missing ${needle}`).toContain(needle);
    }
  });
});
