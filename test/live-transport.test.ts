import { createHash, createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import { LIVE_INGEST_PATH, signedLiveSnapshot, verifyLiveIngress } from "../src/live/transport";

const key = { keyId: "fixture", secret: "offline signing fixture" };
const unix = 1_800_000_000;
const nonce = "a".repeat(32);
const raw = '{ "name": "é" }\n';
function signature(path: string, timestamp: string, token: string, body: string) {
  const digest = createHash("sha256").update(body).digest("hex");
  return `sha256=${createHmac("sha256", key.secret).update(`POST\n${path}\n${timestamp}\n${token}\n${digest}`).digest("hex")}`;
}
function request(
  body: string | ReadableStream<Uint8Array>,
  suffix = "",
  timestamp = unix,
  id = key.keyId,
) {
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    body,
    duplex: "half",
    headers: {
      "X-TWO-Key-Id": id,
      "X-TWO-Timestamp": String(timestamp),
      "X-TWO-Nonce": nonce,
      "X-TWO-Signature": signature(LIVE_INGEST_PATH, String(timestamp), nonce, raw),
    },
  };
  return new Request(`https://site.example${LIVE_INGEST_PATH}${suffix}`, init);
}

it("authenticates the original bytes and rejects reserialization", async () => {
  const result = await verifyLiveIngress(request(raw), key, unix * 1000);
  expect(result).toEqual({ status: 200, bytes: new TextEncoder().encode(raw).buffer });
  expect(await verifyLiveIngress(request('{"name":"é"}'), key, unix * 1000)).toEqual({
    status: 401,
  });
});

it.each([
  request(raw, "?other=1"),
  request(raw, "", unix - 61),
  request(raw, "", unix + 61),
  request(raw, "", unix, "fixture, fixture"),
  request(raw, "", unix, "other"),
])("rejects requests outside the signing scope", async (req) => {
  expect(await verifyLiveIngress(req, key, unix * 1000)).toEqual({ status: 401 });
});

it.each([
  [65_536, 401],
  [65_537, 413],
])("caps a lengthless ingest body of %i bytes", async (size, status) => {
  expect(await verifyLiveIngress(request("x".repeat(size)), key, unix * 1000)).toEqual({ status });
});

it("times out during HMAC verification after reading the body", async () => {
  vi.useFakeTimers();
  let started!: () => void;
  const verifying = new Promise<void>((resolve) => {
    started = resolve;
  });
  const verify = vi.spyOn(crypto.subtle, "verify").mockImplementation(() => {
    started();
    return new Promise((resolve) => setTimeout(() => resolve(true), 3_000));
  });
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(raw));
          controller.close();
        }, 1_000);
      },
    });
    const result = verifyLiveIngress(request(body), key, unix * 1000);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.race([verifying, result]);
    expect(verify).toHaveBeenCalledOnce();
    // Body reading and HMAC verification share the deadline from request start.
    await vi.advanceTimersByTimeAsync(1_499);
    expect(await Promise.race([result, Promise.resolve("pending")])).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(await Promise.race([result, Promise.resolve("pending")])).toEqual({ status: 400 });
    await vi.advanceTimersByTimeAsync(1_500);
  } finally {
    verify.mockRestore();
    vi.useRealTimers();
  }
});

const config = { ...key, origin: "https://producer.example", guildId: "1234" };
const snapshot = (observedAt = new Date().toISOString()) => ({
  v: 1,
  guild_id: config.guildId,
  seq: 11,
  observed_at: observedAt,
  topics: { voice: 5 },
});
const decode = (topics: Record<string, unknown>) =>
  typeof topics.voice === "number" ? topics.voice : null;

it.each([
  () => Response.json({ ...snapshot(), guild_id: "4321" }),
  () => Response.json({ ...snapshot(), topics: {} }),
  () => Response.json({ ...snapshot(), seq: -1 }),
  () => Response.redirect("https://other.example/"),
  () => Response.json(snapshot("2026-02-30T02:10:00Z")),
  () => Response.json(snapshot(new Date().toISOString().replace("Z", "4567890Z"))),
])("does not supply a watermark for a rejected snapshot", async (response) => {
  expect(await signedLiveSnapshot(config, decode, async () => response())()).toBeNull();
});

it("bounds leases by observation age and accepts at most two seconds of forward skew", async () => {
  const now = Date.parse("2026-11-21T04:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const loadAt = (offset: number) =>
      signedLiveSnapshot(config, decode, async () =>
        Response.json(snapshot(new Date(now + offset).toISOString())),
      )();
    expect(await loadAt(-30_000)).toBeNull();
    expect(await loadAt(-29_999)).toEqual({ seq: 11, state: 5, validUntil: now + 1 });
    expect(await loadAt(2_000)).toEqual({ seq: 11, state: 5, validUntil: now + 30_000 });
    expect(await loadAt(2_001)).toBeNull();
  } finally {
    clock.mockRestore();
  }
});

it("signs the actual pull bytes and only admits valid JSON within the snapshot limit", async () => {
  const doc = snapshot();
  const json = JSON.stringify(doc);
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementationOnce(async () => new Response(json.padEnd(1_048_576)))
    .mockImplementationOnce(async () => new Response(json.padEnd(1_048_577)));
  const load = signedLiveSnapshot(config, decode, fetcher);
  expect(await load()).toEqual({
    seq: 11,
    state: 5,
    validUntil: Date.parse(doc.observed_at) + 30_000,
  });
  const [url, init] = fetcher.mock.calls[0]!;
  const headers = new Headers(init?.headers);
  const body = '{"action":"live.snapshot","guild_id":"1234"}';
  expect([url, init?.method, init?.body]).toEqual([
    `${config.origin}/internal/actions`,
    "POST",
    body,
  ]);
  expect(init?.redirect).toBe("manual");
  expect(headers.get("X-TWO-Key-Id")).toBe(config.keyId);
  expect(headers.get("X-TWO-Signature")).toBe(
    signature(
      "/internal/actions",
      headers.get("X-TWO-Timestamp")!,
      headers.get("X-TWO-Nonce")!,
      body,
    ),
  );
  expect(await load()).toBeNull();
});
