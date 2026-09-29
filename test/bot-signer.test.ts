import { describe, expect, it } from "vitest";
import { encodeCanonicalJson, sha256Hex, signInternalAction } from "../src/bot/signer";

// Vectors carried over unmodified from two-web tests/Unit/Services/Bot/InternalActionSigner{,Reference}Test.php.
// Produced outside both codebases (openssl / two-bot scripts/internal-actions-acceptance.ts).
const sign = (keyId: string, secret: string, body: string, ts: number, nonce: string) =>
  signInternalAction(keyId, secret, body, ts, nonce);

describe("openssl vectors (event.upsert)", () => {
  const secret = "two-web-test-secret-at-least-32-characters";
  const body = '{"action":"event.upsert","event_key":"movie-night-2026-09-01"}';
  const nonce = "9f1c0a2b3d4e5f60718293a4b5c6d7e8";

  it("signs a known request to a known hex string", async () => {
    const h = await sign("web-test", secret, body, 1787173135, nonce);
    expect(h["X-TWO-Signature"]).toBe(
      "sha256=3604fc650acae867427205ec8da5dc6dc7e379e264c9014a2d947368d95a1224",
    );
    expect(h["X-TWO-Key-Id"]).toBe("web-test");
    expect(h["X-TWO-Timestamp"]).toBe("1787173135");
    expect(h["X-TWO-Nonce"]).toBe(nonce);
    expect(Object.keys(h).sort()).toEqual(["X-TWO-Key-Id", "X-TWO-Nonce", "X-TWO-Signature", "X-TWO-Timestamp"]);
  });

  it("hashes the body to the digest the bot recomputes", async () => {
    expect(await sha256Hex(body)).toBe("aa7823cc4a81eb30b2b6ecb1ffa1d59c13c7d25ac7eec14422d9a03131446536");
  });

  it("changes with body, secret, timestamp and nonce", async () => {
    const base = (await sign("web-test", secret, body, 1787173135, nonce))["X-TWO-Signature"];
    const others = await Promise.all([
      sign("web-test", secret, '{"action":"event.upsert","event_key":"something-else"}', 1787173135, nonce),
      sign("web-test", "a-completely-different-shared-secret-value", body, 1787173135, nonce),
      sign("web-test", secret, body, 1787173136, nonce),
      sign("web-test", secret, body, 1787173135, "0".repeat(32)),
    ]);
    for (const o of others) expect(o["X-TWO-Signature"]).not.toBe(base);
  });
});

describe("reference-implementation vectors", () => {
  const secret = "test-secret-do-not-use";
  const ts = 1787173135;
  const nonce = "9f1c0d3e5a7b9c1d3e5f7a9b0c2d4e6f";
  const role = '{"action":"role.assign","discord_id":"900000000000009999","role_key":"rocketleague"}';
  // Carries a slash and non-ASCII: what PHP escapes by default and JSON.stringify does not.
  const announce = '{"action":"announcement.post","channel_key":"qa-throwaway","body":"héllo / world «ok»"}';

  it("signs role.assign exactly as the reference does", async () => {
    expect((await sign("web-test", secret, role, ts, nonce))["X-TWO-Signature"]).toBe(
      "sha256=a2159435259369a4460b5d94202f44219f3e22fb17ed24c8a4394948bc6251a0",
    );
    expect(await sha256Hex(role)).toBe("84ba3c5c16706c5f9e4b8e6a4bc79eb9a36c55b823193e1e94a743a44a071afc");
  });

  it("signs announcement.post exactly as the reference does", async () => {
    expect((await sign("web-test", secret, announce, ts, nonce))["X-TWO-Signature"]).toBe(
      "sha256=d75833b1faf35524dbce628cf26a14bc71084f9eea37d645c2160cc9039afd51",
    );
    expect(await sha256Hex(announce)).toBe("17ce0c9cdc32c0d08457e1482da370e70f6bfb71d4cf23db1d3aa4d7d7a1c1c8");
  });

  it("encodes the payloads to the exact bytes the vectors were signed over", () => {
    expect(encodeCanonicalJson({ action: "role.assign", discord_id: "900000000000009999", role_key: "rocketleague" })).toBe(role);
    expect(encodeCanonicalJson({ action: "announcement.post", channel_key: "qa-throwaway", body: "héllo / world «ok»" })).toBe(announce);
  });

  it("escapes U+2028/2029 like PHP json_encode", () => {
    expect(encodeCanonicalJson({ a: "x\u2028y\u2029" })).toBe('{"a":"x\\u2028y\\u2029"}');
  });
});
