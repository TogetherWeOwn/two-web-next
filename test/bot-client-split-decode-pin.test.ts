// Implementation-owned pin: a chunk split inside a multibyte character must
// decode to the exact original bytes, not replacement characters.
//
// The acceptance suite proves a mid-character split still succeeds, but it
// asserts only ok/outcome — a transport that decoded each chunk with a fresh
// TextDecoder would pass it while silently mojibake-ing the payload
// (U+FFFD where the split fell). This pin asserts the exact decoded
// `request_id` — a literal with 2-byte and 3-byte characters — for a split
// at every byte offset, through the public role.assign client.
//
// Hermetic: a mocked fetch only. No live bot, no database, synthetic
// canaries only.
import { describe, expect, it, vi } from "vitest";
import { createBotClient } from "../src/bot/client";

const SECRET = "wire-secret-never-surface-synthetic-canary";
const URL = "https://bot-staging.internal.example";
const KEY_ID = "web-staging";
const USER_ID = "900000000000009999";
// Hand-derived literal: é is 2 UTF-8 bytes, € and ✓ are 3 each.
const REQUEST_ID = "r-é-€-✓";

const enc = new TextEncoder();

function twoChunkStream(bytes: Uint8Array, splitAt: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        controller.enqueue(bytes.subarray(0, splitAt));
        controller.enqueue(bytes.subarray(splitAt));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
}

describe("multibyte characters split across chunks decode exactly", () => {
  it("every byte-offset split yields the exact request_id", async () => {
    const body = JSON.stringify({
      ok: true,
      result: { outcome: "assigned" },
      request_id: REQUEST_ID,
    });
    const bytes = enc.encode(body);
    for (let splitAt = 1; splitAt < bytes.byteLength; splitAt++) {
      const fetchFn = vi.fn(async () => {
        return new Response(twoChunkStream(bytes, splitAt), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const client = createBotClient({
        url: URL,
        secret: SECRET,
        keyId: KEY_ID,
        fetchFn: fetchFn as unknown as typeof fetch,
      });
      const result = await client.assignRole({ userId: USER_ID, roleKey: "rocketleague" });
      expect(result, `split at byte ${splitAt} must still succeed`).toMatchObject({
        ok: true,
        outcome: "assigned",
        requestId: REQUEST_ID,
      });
    }
  });
});
