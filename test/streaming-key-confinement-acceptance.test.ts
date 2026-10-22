// Streaming S3 acceptance: ingest-key plaintext confinement. Plaintext
// keys exist only in the show-once setup response and Worker memory: never
// in logs, snapshots, error payloads, SQL text, or bound params. Companion
// to test/streaming-setup-acceptance.test.ts, which pins the provisioning
// behavior; this file pins that every other surface stays key-free.
//
// RED on arrival: the behavior tests fail with 404 (no /streaming route)
// and the storage-shape test fails (no stream_live_inputs table anywhere).
// Tests marked CONTROL pass before and after; they guard regressions the
// Builder could otherwise introduce silently.
//
// Locked contract (extends the setup suite header):
// - Each issuance reveals its full key in exactly one response body; every
//   other response across provision, reload, rotate, disable, enable,
//   status, and error paths (HTML and JSON) is key-free.
// - Tampered ciphertext and ciphertext transplanted from another member
//   fail closed (5xx, sanitized): AEAD integrity with AAD bound to the
//   user + purpose, proven behaviorally through the route.
// - Missing STREAM_KEYS_KEY or Cloudflare credentials fail closed with
//   zero Cloudflare calls; a Cloudflare failure stores nothing; a DB
//   outage provisions nothing (no orphan live inputs).
// - stream_live_inputs persists bytea ciphertext + IV with a key_version
//   and no plaintext column; STREAM_KEYS_KEY never ships to client
//   bundles; no .md snapshot alternate serves the setup page.
//
// Hermetic: same fakes as the setup suite. No DATABASE_URL, no network.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STREAMING_ALICE,
  STREAMING_BOB,
  captureConsole,
  countOccurrences,
  setupAction,
  setupGet,
  setupStreaming,
  testidText,
  withoutEnv,
  type StreamingFixture,
} from "./helpers/streaming-acceptance";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let fx: StreamingFixture;
let consoleCapture: { lines: string[]; restore: () => void };

beforeEach(() => {
  fx = setupStreaming();
  consoleCapture = captureConsole();
});

afterEach(() => {
  consoleCapture.restore();
  fx.uninstall();
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe("plaintext appears in exactly one response per issuance", () => {
  it("full keys occur once each across the whole flow, HTML and JSON alike", async () => {
    fx.sdb.seedSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const bodies: string[] = [];
    const collect = async (res: Response): Promise<string> => {
      const text = await res.text();
      bodies.push(text);
      return text;
    };

    const firstRes = await setupGet(fx, cookie);
    expect(firstRes.status).toBe(200);
    const firstHtml = await collect(firstRes);
    const key1 = testidText(firstHtml, "streaming-key-once")!;
    expect(typeof key1).toBe("string");
    await collect(await setupGet(fx, cookie));
    const rotatePosted = await setupAction(fx, cookie, "rotate");
    const rotateHtml =
      rotatePosted.status === 200
        ? await collect(rotatePosted)
        : await collect(
            await fx.request(rotatePosted.headers.get("location") ?? "/streaming/setup", {
              headers: { cookie },
            }),
          );
    const key2 = testidText(rotateHtml, "streaming-key-once")!;
    expect(typeof key2).toBe("string");
    expect(key2).not.toBe(key1);
    await collect(await setupGet(fx, cookie));
    await collect(await setupAction(fx, cookie, "disable"));
    await collect(await setupGet(fx, cookie));
    await collect(await setupAction(fx, cookie, "enable"));
    await collect(await setupGet(fx, cookie));
    await collect(await setupGet(fx, cookie, "application/json"));

    const joined = bodies.join("\n---body---\n");
    expect(countOccurrences(joined, key1)).toBe(1);
    expect(countOccurrences(joined, key2)).toBe(1);
    expect(fx.cf.unexpected).toHaveLength(0);
  });
});

describe("logs, statements, and error payloads stay key-free", () => {
  it("no console line carries key material, including error paths", async () => {
    fx.sdb.seedSubscription(STREAMING_ALICE);
    fx.sdb.seedSubscription(STREAMING_BOB);
    const alice = await fx.cookieFor(STREAMING_ALICE, "alice");
    const bob = await fx.cookieFor(STREAMING_BOB, "bob");
    const aliceRes = await setupGet(fx, alice);
    expect(aliceRes.status).toBe(200);
    const aliceHtml = await aliceRes.text();
    const keyA = testidText(aliceHtml, "streaming-key-once")!;
    expect(typeof keyA).toBe("string");
    const bobRes = await setupGet(fx, bob);
    expect(bobRes.status).toBe(200);
    const bobHtml = await bobRes.text();
    const keyB = testidText(bobHtml, "streaming-key-once")!;
    expect(typeof keyB).toBe("string");
    fx.cf.failNextRotates(1);
    await setupAction(fx, alice, "rotate");
    fx.sdb.failAll = new Error("confinement outage");
    await setupGet(fx, alice);
    fx.sdb.failAll = null;

    for (const line of consoleCapture.lines) {
      expect(line).not.toContain(keyA);
      expect(line).not.toContain(keyB);
    }
    expect(consoleCapture.lines.length).toBeGreaterThan(0);
  });

  it("no recorded SQL statement or bound param carries key material", async () => {
    fx.sdb.seedSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const firstRes = await setupGet(fx, cookie);
    expect(firstRes.status).toBe(200);
    const firstHtml = await firstRes.text();
    const key1 = testidText(firstHtml, "streaming-key-once")!;
    expect(typeof key1).toBe("string");
    await setupGet(fx, cookie);
    const rotatePosted = await setupAction(fx, cookie, "rotate");
    const rotateHtml =
      rotatePosted.status === 200
        ? await rotatePosted.text()
        : await (
            await fx.request(rotatePosted.headers.get("location") ?? "/streaming/setup", {
              headers: { cookie },
            })
          ).text();
    const key2 = testidText(rotateHtml, "streaming-key-once")!;
    expect(typeof key2).toBe("string");
    await setupAction(fx, cookie, "disable");
    await setupAction(fx, cookie, "enable");

    expect(fx.sdb.queries.length).toBeGreaterThan(0);
    for (const query of fx.sdb.queries) {
      const serialized = `${query.sql}\n${JSON.stringify(query.params)}`;
      expect(serialized).not.toContain(key1);
      expect(serialized).not.toContain(key2);
    }
  });

  it("Cloudflare failure provisions nothing and answers a sanitized 5xx", async () => {
    fx.sdb.seedSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    fx.cf.failNextProvisions(1);

    const htmlRes = await setupGet(fx, cookie);
    fx.cf.failNextProvisions(1);
    const jsonRes = await setupGet(fx, cookie, "application/json");

    for (const res of [htmlRes, jsonRes]) {
      expect([500, 502, 503]).toContain(res.status);
      const body = await res.text();
      expect(body).not.toContain("fake-ingest-key-");
      expect(body).not.toContain("FakeCloudflare");
      expect(body).not.toContain("streaming-acceptance");
    }
    expect(fx.sdb.rowCount("stream_live_inputs")).toBe(0);
  });

  it("database outage fails closed before any Cloudflare call", async () => {
    fx.sdb.seedSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    fx.sdb.failAll = new Error("confinement outage");

    const res = await setupGet(fx, cookie);

    expect([500, 503]).toContain(res.status);
    expect(await res.text()).not.toContain("fake-ingest-key-");
    expect(fx.cf.calls).toHaveLength(0);
  });

  it("tampered ciphertext fails closed without leaking", async () => {
    fx.sdb.seedSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const firstRes = await setupGet(fx, cookie);
    expect(firstRes.status).toBe(200);
    const firstHtml = await firstRes.text();
    const key = testidText(firstHtml, "streaming-key-once")!;
    expect(typeof key).toBe("string");
    const stored = fx.sdb.row("stream_live_inputs", STREAMING_ALICE)!;
    const tampered = Buffer.from(stored.ingest_key_enc as Uint8Array);
    tampered[0] = (tampered[0] as number) ^ 0xff;
    fx.sdb.setRow("stream_live_inputs", STREAMING_ALICE, { ingest_key_enc: tampered });

    const htmlRes = await setupGet(fx, cookie);
    const jsonRes = await setupGet(fx, cookie, "application/json");

    for (const res of [htmlRes, jsonRes]) {
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await res.text()).not.toContain(key);
    }
  });

  it("ciphertext transplanted from another member fails closed", async () => {
    fx.sdb.seedSubscription(STREAMING_ALICE);
    fx.sdb.seedSubscription(STREAMING_BOB);
    const alice = await fx.cookieFor(STREAMING_ALICE, "alice");
    const bob = await fx.cookieFor(STREAMING_BOB, "bob");
    const resA = await setupGet(fx, alice);
    expect(resA.status).toBe(200);
    const keyA = testidText(await resA.text(), "streaming-key-once")!;
    expect(typeof keyA).toBe("string");
    const resB = await setupGet(fx, bob);
    expect(resB.status).toBe(200);
    const keyB = testidText(await resB.text(), "streaming-key-once")!;
    expect(typeof keyB).toBe("string");
    const rowA = fx.sdb.row("stream_live_inputs", STREAMING_ALICE)!;
    fx.sdb.setRow("stream_live_inputs", STREAMING_BOB, {
      ingest_key_enc: rowA.ingest_key_enc,
      ingest_key_iv: rowA.ingest_key_iv,
    });

    const res = await setupGet(fx, bob);

    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.text();
    expect(body).not.toContain(keyA);
    expect(body).not.toContain(keyB);
  });

  it("missing STREAM_KEYS_KEY fails closed with no provision", async () => {
    fx.sdb.seedSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const res = await setupGet(fx, cookie, "text/html", withoutEnv(fx, "STREAM_KEYS_KEY"));

    expect([500, 503]).toContain(res.status);
    expect(fx.cf.calls).toHaveLength(0);
    expect(fx.sdb.rowCount("stream_live_inputs")).toBe(0);
  });

  it("missing Cloudflare credentials fail closed with no provision", async () => {
    fx.sdb.seedSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const res = await setupGet(
      fx,
      cookie,
      "text/html",
      withoutEnv(fx, "CF_STREAM_ACCOUNT_ID", "CF_STREAM_API_TOKEN"),
    );

    expect([500, 503]).toContain(res.status);
    expect(fx.cf.calls).toHaveLength(0);
    expect(fx.sdb.rowCount("stream_live_inputs")).toBe(0);
  });
});

describe("storage shape and static guards", () => {
  it("stream_live_inputs persists bytea ciphertext + IV with a key version and no plaintext column", () => {
    const hits: string[] = [];
    for (const dir of ["src/db", "drizzle"]) {
      for (const path of walk(join(ROOT, dir))) {
        if (!/\.(ts|sql)$/.test(path)) continue;
        const text = readFileSync(path, "utf8");
        if (text.includes("stream_live_inputs")) hits.push(path);
      }
    }
    expect(hits.length).toBeGreaterThan(0);
    for (const path of hits) {
      const text = readFileSync(path, "utf8");
      if (!text.includes("bytea")) throw new Error(`${path} must store ciphertext as bytea`);
      if (!text.includes("key_version")) throw new Error(`${path} must carry key_version`);
      expect(text).not.toMatch(/ingest_key\s+text/i);
      expect(text).not.toMatch(/ingest_key['"]?\s*:\s*text/i);
    }
  });

  it("CONTROL: llms.txt carries no key material and does not list the setup page", async () => {
    fx.sdb.seedSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const firstHtml = await (await setupGet(fx, cookie)).text();
    const key = testidText(firstHtml, "streaming-key-once") ?? "no-route-yet";

    const res = await fx.request("/llms.txt");

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(key);
    expect(body).not.toContain("fake-ingest-key-");
    expect(body).not.toContain("/streaming/setup");
  });

  it("CONTROL: STREAM_KEYS_KEY never ships to client bundles", () => {
    for (const dir of ["assets", "public"]) {
      for (const path of walk(join(ROOT, dir))) {
        if (/\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|eot|mp4|webm)$/i.test(path)) continue;
        const text = readFileSync(path, "utf8");
        if (text.includes("STREAM_KEYS_KEY")) {
          throw new Error(`${path} must not reference the stream key name`);
        }
      }
    }
  });

  it("CONTROL: no .md snapshot alternate serves the setup page", () => {
    for (const path of walk(join(ROOT, "src/ai-friendly"))) {
      expect(readFileSync(path, "utf8")).not.toContain("streaming");
    }
  });

  it("CONTROL: anonymous requests never receive key material", async () => {
    fx.sdb.seedSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    await setupGet(fx, cookie);

    const anon = await fx.request("/streaming/setup");

    expect(anon.status).not.toBe(200);
    expect(await anon.text()).not.toContain("fake-ingest-key-");
  });
});
