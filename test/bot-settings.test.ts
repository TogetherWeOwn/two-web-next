// Signed guild-settings transport pins (dashboard moderation slice).
//
// The bot already speaks settings.get/settings.set into guild_settings
// (parent spec section 4.3); this module is the web side of that path: live
// reads for display plus the queued write the worker delivers. Fail-closed
// throughout: transport, shape and budget failures answer unavailable (reads)
// or a terminal/transport error (writes), never a partial setting and never
// with bot detail in the message.
import { setTimeout as realDelay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BotTerminalError, BotTransportError } from "../src/jobs/types";
import {
  applyGuildSetting,
  createSettingsWriter,
  readGuildSettings,
  SETTINGS_READ_VERB,
  SETTINGS_WRITE_VERB,
  settingsBotConfig,
  type SettingsBotConfig,
} from "../src/bot/settings";

const CFG: SettingsBotConfig = {
  baseUrl: "https://bot.settings-fixture.test",
  keyId: "fixture-key-id",
  secret: "fixture-secret-not-a-credential",
};

const SETTINGS_DOC = {
  ok: true,
  result: {
    settings: [
      {
        key: "TWO_AUTOMOD_MENTION_LIMIT",
        value: "5",
        version: 7,
        updated_by: "discord:/automod",
        updated_at: "2026-10-20T12:00:00.000Z",
      },
      {
        key: "TWO_MODERATION",
        value: "on",
        version: 3,
        updated_by: "operator:deploy",
        updated_at: "2026-10-19T08:00:00.000Z",
      },
    ],
  },
};

function jsonResponse(doc: unknown, status = 200): Response {
  return new Response(JSON.stringify(doc), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("settings verbs and config", () => {
  it("reuses the bot's settings verbs, inventing no new path", () => {
    expect(SETTINGS_READ_VERB).toBe("settings.get");
    expect(SETTINGS_WRITE_VERB).toBe("settings.set");
  });

  it("maps the bot bindings to a config, or null when any is missing", () => {
    expect(
      settingsBotConfig({
        BOT_ENDPOINT_URL: CFG.baseUrl,
        BOT_KEY_ID: CFG.keyId,
        BOT_SHARED_SECRET: CFG.secret,
      }),
    ).toEqual(CFG);
    expect(
      settingsBotConfig({
        BOT_ENDPOINT_URL: CFG.baseUrl,
        BOT_KEY_ID: CFG.keyId,
      }),
    ).toBeNull();
    expect(settingsBotConfig({})).toBeNull();
  });
});

describe("readGuildSettings", () => {
  it("posts a signed settings.get and parses the guild_settings rows", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse(SETTINGS_DOC);
    }) as typeof fetch;
    const res = await readGuildSettings(CFG, fetcher);
    expect(res).toEqual({
      ok: true,
      settings: [
        {
          key: "TWO_AUTOMOD_MENTION_LIMIT",
          value: "5",
          version: 7,
          updatedBy: "discord:/automod",
          updatedAt: "2026-10-20T12:00:00.000Z",
        },
        {
          key: "TWO_MODERATION",
          value: "on",
          version: 3,
          updatedBy: "operator:deploy",
          updatedAt: "2026-10-19T08:00:00.000Z",
        },
      ],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://bot.settings-fixture.test/internal/actions");
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["X-TWO-Key-Id"]).toBe("fixture-key-id");
    expect(headers["X-TWO-Signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(String(seen[0]!.init.body)).toContain('"action":"settings.get"');
  });

  it("stringifies scalar JSONB values so the form always renders text", async () => {
    const fetcher = (async () =>
      jsonResponse({
        ok: true,
        result: {
          settings: [
            {
              key: "TWO_AUTOMOD_MENTION_LIMIT",
              value: 5,
              version: 7,
              updated_by: "discord:/automod",
              updated_at: "2026-10-20T12:00:00.000Z",
            },
          ],
        },
      })) as typeof fetch;
    expect(await readGuildSettings(CFG, fetcher)).toEqual({
      ok: true,
      settings: [
        {
          key: "TWO_AUTOMOD_MENTION_LIMIT",
          value: "5",
          version: 7,
          updatedBy: "discord:/automod",
          updatedAt: "2026-10-20T12:00:00.000Z",
        },
      ],
    });
  });

  it("skips malformed rows instead of failing the whole read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = (async () =>
      jsonResponse({
        ok: true,
        result: {
          settings: [
            {
              key: "TWO_AUTOMOD_MENTION_LIMIT",
              value: { nested: true },
              version: 7,
              updated_by: "discord:/automod",
              updated_at: "2026-10-20T12:00:00.000Z",
            },
            SETTINGS_DOC.result.settings[1],
          ],
        },
      })) as typeof fetch;
    const res = await readGuildSettings(CFG, fetcher);
    expect(res.ok).toBe(true);
    expect(res.ok && res.settings.map((s) => s.key)).toEqual(["TWO_MODERATION"]);
    expect(warn).toHaveBeenCalled();
  });

  it.each([
    ["bot outage", jsonResponse({ ok: false, error: { code: "bot_down" } }, 500)],
    ["refusal", jsonResponse({ ok: false, error: { code: "forbidden", retryable: false } }, 403)],
    ["non-JSON body", new Response("bot down", { status: 500 })],
    ["missing settings array", jsonResponse({ ok: true, result: {} })],
    ["non-array settings", jsonResponse({ ok: true, result: { settings: {} } })],
    ["redirect", new Response(null, { status: 302, headers: { location: "https://evil.test/" } })],
  ])("fails closed on %s, without bot detail", async (_name, response) => {
    const fetcher = (async () => response) as typeof fetch;
    const res = await readGuildSettings(CFG, fetcher);
    expect(res).toEqual({ ok: false });
    expect(JSON.stringify(res)).not.toContain("bot down");
  });

  it("fails closed without config, without an http endpoint, or off https", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    expect(await readGuildSettings(null, fetcher)).toEqual({ ok: false });
    expect(await readGuildSettings({ ...CFG, baseUrl: "" }, fetcher)).toEqual({ ok: false });
    expect(await readGuildSettings({ ...CFG, baseUrl: "http://plain.test" }, fetcher)).toEqual({
      ok: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds the wait even when the transport never settles", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const pending = readGuildSettings(CFG, fetcher);
    const assertion = expect(pending).resolves.toEqual({ ok: false });
    // Signing is real async crypto: wait (real time, zero fake
    // milliseconds) until the attempt is on the wire, so the advance below
    // measures transport time only (precedent: bot-event-read-budget).
    const deadline = vi.getRealSystemTime() + 2_000;
    while (fetcher.mock.calls.length === 0 && vi.getRealSystemTime() < deadline) {
      await realDelay(1);
    }
    expect(fetcher.mock.calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("refuses an over-large body before parsing", async () => {
    const big = "x".repeat(300 * 1024);
    const fetcher = (async () =>
      jsonResponse({ ok: true, result: { settings: [], padding: big } })) as typeof fetch;
    expect(await readGuildSettings(CFG, fetcher)).toEqual({ ok: false });
  });
});

describe("applyGuildSetting", () => {
  const REQ = {
    key: "TWO_AUTOMOD_MENTION_LIMIT",
    value: "8",
    expectedVersion: 7,
    actor: "dashboard:100000000000000103",
    guildId: "326474832151838730",
  };
  const KEY = "123e4567-e89b-12d3-a456-426614174000";

  it("posts the signed settings.set with the queued idempotency key", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return jsonResponse({ ok: true, result: { applied: true } });
    }) as typeof fetch;
    const res = await applyGuildSetting(CFG, REQ, KEY, fetcher);
    expect(res).toEqual({ ok: true, replayed: false });
    expect(seen).toHaveLength(1);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(KEY);
    const body = String(seen[0]!.init.body);
    expect(body).toContain('"action":"settings.set"');
    expect(body).toContain('"key":"TWO_AUTOMOD_MENTION_LIMIT"');
    expect(body).toContain('"value":"8"');
    expect(body).toContain('"expected_version":7');
    expect(body).toContain("dashboard:100000000000000103");
    expect(body).toContain("326474832151838730");
  });

  it("reports a replayed success without re-applying", async () => {
    const fetcher = (async () =>
      new Response(JSON.stringify({ ok: true, result: { applied: true } }), {
        status: 200,
        headers: { "content-type": "application/json", "Idempotent-Replay": "true" },
      })) as typeof fetch;
    expect(await applyGuildSetting(CFG, REQ, KEY, fetcher)).toEqual({ ok: true, replayed: true });
  });

  it("maps a bot refusal to a failure with the bot's retryable verdict", async () => {
    const fetcher = (async () =>
      jsonResponse(
        { ok: false, error: { code: "version_mismatch", retryable: false } },
        409,
      )) as typeof fetch;
    const res = await applyGuildSetting(CFG, REQ, KEY, fetcher);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.failure).toMatchObject({
      code: "version_mismatch",
      retryable: false,
    });
  });

  it("a transport throw is a transport error, never a failure", async () => {
    const fetcher = (async () => {
      throw new Error("connection reset");
    }) as unknown as typeof fetch;
    await expect(applyGuildSetting(CFG, REQ, KEY, fetcher)).rejects.toBeInstanceOf(
      BotTransportError,
    );
  });

  it("a malformed idempotency key or missing config is terminal before any send", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    await expect(applyGuildSetting(CFG, REQ, "not-a-uuid", fetcher)).rejects.toBeInstanceOf(
      BotTerminalError,
    );
    await expect(applyGuildSetting(null, REQ, KEY, fetcher)).rejects.toBeInstanceOf(
      BotTerminalError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("createSettingsWriter", () => {
  it("adapts the transport to the queue consumer's writer seam", async () => {
    const fetcher = (async () =>
      jsonResponse({ ok: true, result: { applied: true } })) as typeof fetch;
    const writer = createSettingsWriter(CFG, fetcher);
    await expect(
      writer.setSetting(
        {
          key: "TWO_AUTOMOD_MENTION_LIMIT",
          value: "8",
          expectedVersion: 7,
          actor: "dashboard:100000000000000103",
          guildId: "326474832151838730",
        },
        "123e4567-e89b-12d3-a456-426614174000",
      ),
    ).resolves.toEqual({ ok: true, requestId: null, replayed: false });
  });

  it("an unconfigured writer fails terminally without sending", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    const writer = createSettingsWriter(null, fetcher);
    await expect(
      writer.setSetting(
        {
          key: "TWO_AUTOMOD_MENTION_LIMIT",
          value: "8",
          expectedVersion: 7,
          actor: "dashboard:1",
          guildId: "2",
        },
        "123e4567-e89b-12d3-a456-426614174000",
      ),
    ).rejects.toBeInstanceOf(BotTerminalError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
