// Endpoint-shape regressions: validate configuration before path derivation,
// then validate the exact fetched string. Mocked fetch only; no DB or live bot.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotClient } from "../src/bot/client";
import * as signer from "../src/bot/signer";
import { BotTransportError } from "../src/jobs/types";

const opts = { secret: "fixture-signing-secret", keyId: "fixture-key" };

/** A clean success if reached, so a missing refusal cannot pass as a fetch failure. */
function assigned() {
  return Response.json({ ok: true, result: { outcome: "assigned" }, request_id: "fixture" });
}

afterEach(() => vi.restoreAllMocks());

describe("mutation endpoint shape", () => {
  it.each([
    "https:",
    "https:/",
    "https://",
    "https:///",
    "https://bot.example?tenant=fixture",
    "https://bot.example/base/?tenant=fixture",
    "https://bot.example?",
    "https://bot.example/base/?",
    "https://bot.example#fixture",
    "https://bot.example/base/#fixture",
    "https://bot.example#",
    "https://bot.example/base/#",
  ])("refuses %s before encoding, signing or fetching, with no cause", async (url) => {
    const encode = vi.spyOn(signer, "encodeCanonicalJson");
    const sign = vi.spyOn(signer, "signInternalAction");
    const fetchFn = vi.fn(async () => assigned());
    const client = createBotClient({ ...opts, url, fetchFn: fetchFn as typeof fetch });
    const error = await client
      .assignRole({ userId: "1", roleKey: "fixture" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BotTransportError);
    expect((error as Error).message).toBe("bot unreachable");
    expect((error as Error).cause).toBeUndefined();
    expect(encode).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["https://bot.example", "https://bot.example/internal/actions"],
    ["https://bot.example///", "https://bot.example/internal/actions"],
    ["https://bot.example/base/", "https://bot.example/base/internal/actions"],
    ["https://bot.example:8443/base", "https://bot.example:8443/base/internal/actions"],
    ["HTTPS://BOT.EXAMPLE/base", "HTTPS://BOT.EXAMPLE/base/internal/actions"],
  ])("preserves the signed request and path derivation for %s", async (url, endpoint) => {
    const sign = vi.spyOn(signer, "signInternalAction");
    const fetchFn = vi.fn(async () => assigned());
    const client = createBotClient({ ...opts, url, fetchFn: fetchFn as typeof fetch });

    await expect(client.assignRole({ userId: "1", roleKey: "fixture" })).resolves.toMatchObject({
      ok: true,
      outcome: "assigned",
    });
    expect(sign).toHaveBeenCalledOnce();
    expect(fetchFn).toHaveBeenCalledExactlyOnceWith(
      endpoint,
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        body: '{"action":"role.assign","discord_id":"1","role_key":"fixture"}',
        headers: expect.objectContaining({
          "X-TWO-Signature": expect.stringMatching(/^sha256=[0-9a-f]{64}$/),
        }),
      }),
    );
  });
});
