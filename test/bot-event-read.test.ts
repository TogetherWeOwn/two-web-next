import { describe, expect, it, vi } from "vitest";
import { observeDiscordEvent, signedEventReader } from "../src/bot/event-read";
import { encodeCanonicalJson, signInternalAction } from "../src/bot/signer";

const cfg = { baseUrl: "https://bot.fixture.test", keyId: "fixture-key", secret: "fixture-secret-not-a-credential" };
const local = { event_key: "01FIXTURE000000000000000000", discord_event_id: "1545644954272137000" };
const observation = { event_id: local.discord_event_id, name: "Independent bot name", starts_at: "2030-07-01T19:00:00Z",
  location: "Voice", status: "scheduled", observed_at: "2030-07-01T18:00:00Z" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

// Every fetcher is a local stub, never the staging bot or a live guild.
describe("signed bot event.read observation", () => {
  it("never calls a bot for a row that was never mirrored", async () => {
    const read = vi.fn();
    expect(await observeDiscordEvent({ ...local, discord_event_id: null }, read)).toEqual({
      unavailable: "verification_unavailable", reason: "never_mirrored",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("signs the exact canonical body, with a UUID header and one bounded nonredirecting attempt", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ ok: true, result: observation }));
    const reader = signedEventReader(cfg, fetcher);
    expect(await observeDiscordEvent(local, reader)).toEqual(observation);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://bot.fixture.test/internal/actions");
    expect(init).toMatchObject({ method: "POST", redirect: "error", body: encodeCanonicalJson({ action: "event.read", event_key: local.event_key }) });
    const h = init!.headers as Record<string, string>;
    expect(h["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(init!.body).not.toContain("idempotency");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(h).toMatchObject(await signInternalAction(cfg.keyId, cfg.secret, init!.body as string,
      Number(h["X-TWO-Timestamp"]), h["X-TWO-Nonce"]!));
  });

  it("returns typed bot failure codes, not messages or local mirror claims", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ ok: false,
      error: { code: "action_not_allowed", message: "private bot detail" } }, 403));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable", reason: "action_not_allowed",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("fails closed on a mismatched ID even when every other field looks right", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ ok: true, result: { ...observation, event_id: "other" } }));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable", reason: "mirror_mismatch",
    });
  });

  it("transport failure has no retry or alternate credentials", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("fixture transport detail"));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable", reason: "bot_unreachable",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([{}, { ...cfg, secret: "" }, { ...cfg, keyId: "" }, { ...cfg, baseUrl: "http://bot.fixture.test" },
    { ...cfg, baseUrl: "https://user:password@bot.fixture.test" }])("unconfigured/unsafe endpoint is unavailable without any request: %j", async (config) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await observeDiscordEvent(local, signedEventReader(config, fetcher))).toEqual({
      unavailable: "verification_unavailable", reason: "bot_unreachable",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([null, {}, { result: observation }, { ok: true, result: { ...observation, observed_at: null } },
    { ok: true, result: { ...observation, event_id: {} } }, { ok: false, error: { message: "no code" } },
    { error: { code: "missing_ok" } }, { ok: false, error: { code: "unsafe code with message" } }])("malformed reply is unavailable: %j", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply(body));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({
      unavailable: "verification_unavailable", reason: "bot_unreachable",
    });
  });

  it("normalizes the legacy optional location and scalar fields without inventing values", async () => {
    const { location: _location, ...result } = observation;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(reply({ ok: true, result: { ...result, name: 123 } }));
    expect(await observeDiscordEvent(local, signedEventReader(cfg, fetcher))).toEqual({ ...result, name: "123", location: null });
  });
});
