// Server-side widget.json presence (invite + voice/stage + online
// count + up to 100 anonymized members). No token in the client bundle; the
// response never waits on Discord (cache read + waitUntil re-probe, like the
// existing health verdict); widget-disabled falls back to the static invite.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import {
  createDiscordWidgetHealth,
  discordWidgetHealth,
  parseDiscordWidgetJson,
} from "../src/discord-widget";

const GUILD = "326474832151838730";

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
      {
        id: "opaque-2",
        username: "maria",
        discriminator: "0",
        avatar: null,
        status: "idle",
        avatar_url: null,
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseDiscordWidgetJson", () => {
  it("parses invite, sorted channels, online count and anonymized members", () => {
    const snapshot = parseDiscordWidgetJson(GUILD, widgetPayload());
    expect(snapshot).toMatchObject({
      guildId: GUILD,
      name: "Together We Own",
      inviteUrl: "https://discord.gg/widget-invite",
      presenceCount: 42,
    });
    expect(snapshot?.channels.map((c) => c.name)).toEqual(["stage-night", "lobby-voice"]);
    expect(snapshot?.members).toEqual([
      { username: "rick", status: "online" },
      { username: "maria", status: "idle" },
    ]);
    // Anonymized: no ids, discriminators or avatars survive parsing.
    expect(JSON.stringify(snapshot)).not.toContain("opaque-1");
    expect(JSON.stringify(snapshot)).not.toContain("discriminator");
    expect(JSON.stringify(snapshot)).not.toContain("avatar_url");
  });

  it("caps members at 100 and drops invalid rows", () => {
    const members = Array.from({ length: 120 }, (_, i) => ({
      id: `opaque-${i}`,
      username: `member-${i}`,
      discriminator: "0",
      avatar: null,
      status: "online",
      avatar_url: null,
    }));
    const snapshot = parseDiscordWidgetJson(
      GUILD,
      widgetPayload({ members: [...members, { username: "", status: "online" }, null] }),
    );
    expect(snapshot?.members).toHaveLength(100);
    expect(snapshot?.members[0]).toEqual({ username: "member-0", status: "online" });
  });

  it("rejects a hostile instant_invite and falls back to null", () => {
    const snapshot = parseDiscordWidgetJson(
      GUILD,
      widgetPayload({ instant_invite: "https://evil.test/invite" }),
    );
    expect(snapshot?.inviteUrl).toBeNull();
  });

  it("returns null on invalid top-level payloads", () => {
    expect(parseDiscordWidgetJson(GUILD, null)).toBeNull();
    expect(parseDiscordWidgetJson(GUILD, {})).toBeNull();
    expect(parseDiscordWidgetJson(GUILD, widgetPayload({ presence_count: -1 }))).toBeNull();
    expect(parseDiscordWidgetJson(GUILD, widgetPayload({ name: "" }))).toBeNull();
    expect(parseDiscordWidgetJson("unset", widgetPayload())).toBeNull();
  });
});

describe("/join widget.json presence (server-side cache only)", () => {
  function harness(transport: (url: string) => Promise<Response>) {
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
    vi.spyOn(discordWidgetHealth, "url").mockImplementation(widget.url.bind(widget));
    vi.spyOn(discordWidgetHealth, "snapshot").mockImplementation(widget.snapshot.bind(widget));
    return {
      calls,
      advance: (ms: number) => {
        clock += ms;
      },
      async join() {
        const pending: Promise<unknown>[] = [];
        const ctx = {
          waitUntil: (p: Promise<unknown>) => pending.push(p),
          passThroughOnException() {},
          props: {},
        };
        const res = await app.request("/join", {}, env, ctx);
        return { status: res.status, html: await res.text(), pending };
      },
    };
  }

  it("renders presence after the background probe warms the cache", async () => {
    const h = harness(async () => Response.json(widgetPayload()));
    const first = await h.join();
    expect(first.status).toBe(200);
    // Cold isolate: no presence yet, facade still stands (never waits on Discord).
    expect(first.html).not.toContain('data-testid="join-widget-presence"');
    await Promise.all(first.pending);

    const second = await h.join();
    expect(second.status).toBe(200);
    expect(second.html).toContain('data-testid="join-widget-presence"');
    expect(second.html).toContain("42");
    expect(second.html).toContain("stage-night");
    expect(second.html).toContain("rick");
    expect(second.html).toContain("https://discord.gg/widget-invite");
    expect(second.html).not.toContain("opaque-1");
    expect(second.html).not.toContain("bot-token");
    expect(second.html).not.toContain("client-secret");
  });

  it("falls back to the static invite when the widget is disabled (403)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = harness(async () =>
      Response.json({ code: 50004, message: "widget disabled" }, { status: 403 }),
    );
    await Promise.all((await h.join()).pending);
    const degraded = await h.join();
    expect(degraded.status).toBe(200);
    expect(degraded.html).toContain('data-testid="join-widget-fallback"');
    expect(degraded.html).not.toContain('data-testid="join-widget-presence"');
    expect(degraded.html).toContain("https://discord.gg/invite");
  });

  it("keeps presence server-side: the client island never fetches widget.json", () => {
    const binder = readFileSync(
      new NodeURL("../public/islands/join-widget.js", import.meta.url),
      "utf8",
    );
    expect(binder).not.toContain("widget.json");
    expect(binder).not.toContain("fetch(");
  });
});
