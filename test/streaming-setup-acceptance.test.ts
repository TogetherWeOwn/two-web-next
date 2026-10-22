// Streaming S3 acceptance: live input provisioning + ingest setup page.
// Failing-first contract for the design slice "live input provisioning +
// ingest setup page" (spec section 9 S3): lazy provision of one Cloudflare
// Stream live input per subscriber on first /streaming/setup visit, the
// RTMPS URL + key shown once then masked, rotate (old dies immediately),
// and member self disable/enable. The companion confinement suite
// (test/streaming-key-confinement-acceptance.test.ts) pins that plaintext
// keys never leave the show-once response.
//
// RED on arrival: no /streaming route exists, so every behavior test below
// fails with 404 until the Builder wires the slice. Tests marked CONTROL
// pass before and after; they pin the fake's fidelity.
//
// Locked contract the Builder must satisfy without editing this file:
// - Routes (main app): GET /streaming/setup provisions lazily and renders
//   the setup page; POST /streaming/setup/rotate reveals a new key once;
//   POST /streaming/setup/disable and POST /streaming/setup/enable flip
//   the input. Action POSTs carry an empty urlencoded form + Origin and
//   answer 200 or 303 (tests follow the redirect); rotate's 200 carries
//   the new show-once key directly.
// - Testids (string literals on purpose): streaming-setup (page root),
//   streaming-rtmps-url (exact RTMPS URL text), streaming-key-once (full
//   key, present only on show-once responses), streaming-key-masked
//   (present on every later view), streaming-status (connection region),
//   streaming-rotate / streaming-disable / streaming-enable (action
//   forms), streaming-disabled (disabled-state marker),
//   streaming-subscribe (subscribe gate link, href exactly /streaming).
// - Cloudflare wire (docs-verified 2026-10-22): provision is POST
//   .../stream/live_inputs with meta.name `two:<user_id>` and
//   recording.mode `off`; rotate is POST :uid/rotate_keys; disable and
//   enable are PUT :uid with {enabled: false/true}; connection status
//   reads GET https://<customer>.cloudflarestream.com/<uid>/lifecycle
//   ({live: bool}), live on every page load (the S5 status cache does
//   not exist yet). Auth goes on every api.cloudflare.com call.
// - Env: STREAM_KEYS_KEY (`v1:<base64-32B>`; rotation lists are
//   comma-separated with the current key first, decrypt tries current
//   then previous), CF_STREAM_ACCOUNT_ID, CF_STREAM_API_TOKEN, plus the
//   existing SESSION_STORE / ADMIN_DB / THROTTLE_STORE seams.
// - Store one row per subscriber in stream_live_inputs: cf_input_uid,
//   bytea ingest_key_enc + ingest_key_iv, enabled, recording_mode 'off',
//   key_version of the encrypting key.
// - Entitlement: subscriptions.status active always; past_due within a
//   3-day grace after current_period_end; canceled, paused, stale
//   past_due, and missing rows get 403 + the subscribe gate. Nothing
//   provisions and no row is written for non-entitled viewers.
// - Gates mirror the member slices: guest GET 302s to /auth/discord,
//   guest POST redirects with no side effects, non-members get 403, the
//   POST actions share the 30/min throttle middleware (reads never
//   consult it), and every setup response is private, no-store.
// - Spec errata found while pinning (docs-verified, for the build card
//   and the CEO): E1 disable/enable is PUT {enabled}, not
//   POST .../disable (runbook K1 step 3a needs the same fix for S7);
//   E2 connection status comes from the lifecycle endpoint, not
//   GET live_input.status (section 2.4; S5 takes note).
//
// Hermetic: recorded-shape Cloudflare fake, pg-proxy DB fake, memory
// sessions, in-memory throttle counter. No DATABASE_URL, no network.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  STREAMING_ALICE,
  STREAMING_APP_URL,
  STREAMING_BOB,
  STREAMING_CF_ACCOUNT,
  STREAMING_RTMPS_URL,
  captureConsole,
  countOccurrences,
  formFor,
  hasTestid,
  rotatedStreamKeysKey,
  setupAction,
  setupGet,
  setupStreaming,
  testidText,
  withEnv,
  type StreamingFixture,
} from "./helpers/streaming-acceptance";

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

function activeSubscription(userId: string): void {
  fx.sdb.seedSubscription(userId);
}

/** Rotate, following a 303 back to the setup page; returns the final HTML. */
async function rotateHtml(cookie: string): Promise<{ status: number; html: string }> {
  const posted = await setupAction(fx, cookie, "rotate");
  if (posted.status === 303 || posted.status === 302) {
    const location = posted.headers.get("location") ?? "/streaming/setup";
    const followed = await fx.request(location, { headers: { cookie } });
    return { status: followed.status, html: await followed.text() };
  }
  return { status: posted.status, html: await posted.text() };
}

/** Disable/enable, following a 303; returns the settled setup HTML. */
async function flipAndRead(cookie: string, action: "disable" | "enable"): Promise<string> {
  const posted = await setupAction(fx, cookie, action);
  expect([200, 303, 302]).toContain(posted.status);
  if (posted.status === 200) {
    const html = await posted.text();
    if (hasTestid(html, "streaming-setup")) return html;
  }
  const res = await setupGet(fx, cookie);
  expect(res.status).toBe(200);
  return res.text();
}

describe("lazy provisioning", () => {
  it("first visit provisions one live input with recording off and the member-scoped name", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");

    const res = await setupGet(fx, cookie);

    expect(res.status).toBe(200);
    expect(fx.cf.provisions()).toHaveLength(1);
    const provision = fx.cf.provisions()[0]!;
    expect(provision.authorization).toBeTruthy();
    expect(new URL(provision.url).hostname).toBe("api.cloudflare.com");
    expect(provision.url).toContain(`/accounts/${STREAMING_CF_ACCOUNT}/stream/live_inputs`);
    const body = provision.body as { meta?: { name?: unknown }; recording?: { mode?: unknown } };
    expect(body.recording?.mode).toBe("off");
    expect(body.meta?.name).toBe(`two:${STREAMING_ALICE}`);
    const row = fx.sdb.row("stream_live_inputs", STREAMING_ALICE);
    expect(row?.cf_input_uid).toBe(fx.cf.firstUid());
    expect(row?.enabled).toBe(true);
    expect(row?.recording_mode).toBe("off");
    expect(row?.key_version).toBe(1);
    expect(row?.ingest_key_enc).toBeInstanceOf(Uint8Array);
    expect(row?.ingest_key_iv).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(row?.ingest_key_enc as Uint8Array).toString("utf8")).not.toContain(
      "fake-ingest-key-",
    );
  });

  it("first visit shows the RTMPS URL and the full key once with pinned testids", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");

    const res = await setupGet(fx, cookie);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/private/);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const html = await res.text();
    expect(hasTestid(html, "streaming-setup")).toBe(true);
    expect(testidText(html, "streaming-rtmps-url")).toBe(STREAMING_RTMPS_URL);
    const uid = fx.cf.firstUid()!;
    expect(testidText(html, "streaming-key-once")).toBe(fx.cf.currentKey(uid));
    expect(hasTestid(html, "streaming-key-masked")).toBe(false);
    expect(hasTestid(html, "streaming-status")).toBe(true);
    expect(formFor(html, "streaming-rotate")).not.toBeNull();
  });

  it("reload masks the key and never provisions a second input", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const first = await setupGet(fx, cookie);
    expect(first.status).toBe(200);
    const key = testidText(await first.text(), "streaming-key-once")!;
    expect(typeof key).toBe("string");

    const second = await setupGet(fx, cookie);
    const third = await setupGet(fx, cookie);

    for (const res of [second, third]) {
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(hasTestid(html, "streaming-key-once")).toBe(false);
      expect(hasTestid(html, "streaming-key-masked")).toBe(true);
      expect(html).not.toContain(key);
    }
    expect(fx.cf.provisions()).toHaveLength(1);
    expect(fx.sdb.rowCount("stream_live_inputs")).toBe(1);
  });

  it("per-row IVs and ciphertexts are unique across members", async () => {
    activeSubscription(STREAMING_ALICE);
    activeSubscription(STREAMING_BOB);
    const alice = await fx.cookieFor(STREAMING_ALICE, "alice");
    const bob = await fx.cookieFor(STREAMING_BOB, "bob");

    const resAlice = await setupGet(fx, alice);
    const resBob = await setupGet(fx, bob);
    expect(resAlice.status).toBe(200);
    expect(resBob.status).toBe(200);

    const rowA = fx.sdb.row("stream_live_inputs", STREAMING_ALICE)!;
    const rowB = fx.sdb.row("stream_live_inputs", STREAMING_BOB)!;
    const ivA = Buffer.from(rowA.ingest_key_iv as Uint8Array);
    const ivB = Buffer.from(rowB.ingest_key_iv as Uint8Array);
    expect(ivA.equals(ivB)).toBe(false);
    const encA = Buffer.from(rowA.ingest_key_enc as Uint8Array);
    const encB = Buffer.from(rowB.ingest_key_enc as Uint8Array);
    expect(encA.equals(encB)).toBe(false);
  });

  it("rotation window: decrypt tries the current key then the previous one", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const first = await setupGet(fx, cookie);
    expect(first.status).toBe(200);
    const oldKey = testidText(await first.text(), "streaming-key-once")!;
    expect(typeof oldKey).toBe("string");
    const rotatedEnv = withEnv(fx, { STREAM_KEYS_KEY: rotatedStreamKeysKey(fx.streamKeysKey) });

    const posted = await setupAction(fx, cookie, "rotate", rotatedEnv);
    expect([200, 303, 302]).toContain(posted.status);
    const html =
      posted.status === 200
        ? await posted.text()
        : await (await fx.request("/streaming/setup", { headers: { cookie } }, rotatedEnv)).text();

    const fresh = testidText(html, "streaming-key-once");
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(oldKey);
    expect(fx.sdb.row("stream_live_inputs", STREAMING_ALICE)?.key_version).toBe(2);
  });

  it("dropping the previous key fails rotation closed before any Cloudflare call", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const first = await setupGet(fx, cookie);
    expect(first.status).toBe(200);
    const oldKey = testidText(await first.text(), "streaming-key-once")!;
    expect(typeof oldKey).toBe("string");
    const rotatedEnv = withEnv(fx, {
      STREAM_KEYS_KEY: rotatedStreamKeysKey(fx.streamKeysKey).split(",")[0] as string,
    });

    const res = await setupAction(fx, cookie, "rotate", rotatedEnv);

    expect([500, 503]).toContain(res.status);
    expect(await res.text()).not.toContain(oldKey);
    expect(fx.cf.rotates()).toHaveLength(0);
    expect(fx.sdb.row("stream_live_inputs", STREAMING_ALICE)?.key_version).toBe(1);
  });
});

describe("rotate, disable, and enable", () => {
  it("rotate calls rotate_keys, shows the new key once, and kills the old key", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const first = await setupGet(fx, cookie);
    expect(first.status).toBe(200);
    const oldKey = testidText(await first.text(), "streaming-key-once")!;
    expect(typeof oldKey).toBe("string");
    const uid = fx.cf.firstUid()!;

    const { status, html } = await rotateHtml(cookie);

    expect(status).toBe(200);
    expect(fx.cf.rotates()).toHaveLength(1);
    expect(fx.cf.rotates()[0]!.url).toContain(`/stream/live_inputs/${uid}/rotate_keys`);
    const fresh = testidText(html, "streaming-key-once");
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(oldKey);
    expect(fx.cf.currentKey(uid)).toBe(fresh);
    expect(fx.cf.isDead(oldKey)).toBe(true);
    const reload = await (await setupGet(fx, cookie)).text();
    expect(reload).not.toContain(oldKey);
    expect(reload).not.toContain(fresh as string);
    expect(hasTestid(reload, "streaming-key-masked")).toBe(true);
  });

  it("disable calls the Cloudflare update with enabled=false and marks the page", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const first = await setupGet(fx, cookie);
    expect(first.status).toBe(200);
    const key = testidText(await first.text(), "streaming-key-once")!;
    expect(typeof key).toBe("string");
    const uid = fx.cf.firstUid()!;

    const html = await flipAndRead(cookie, "disable");

    expect(fx.cf.updates()).toHaveLength(1);
    expect(fx.cf.updates()[0]!.url).toContain(`/stream/live_inputs/${uid}`);
    expect((fx.cf.updates()[0]!.body as { enabled?: unknown }).enabled).toBe(false);
    expect(fx.sdb.row("stream_live_inputs", STREAMING_ALICE)?.enabled).toBe(false);
    expect(hasTestid(html, "streaming-disabled")).toBe(true);
    expect(html).not.toContain(key);
  });

  it("enable calls the Cloudflare update with enabled=true and restores the page", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const first = await setupGet(fx, cookie);
    expect(first.status).toBe(200);
    await flipAndRead(cookie, "disable");

    const html = await flipAndRead(cookie, "enable");

    expect(fx.cf.updates()).toHaveLength(2);
    expect((fx.cf.updates()[1]!.body as { enabled?: unknown }).enabled).toBe(true);
    expect(fx.sdb.row("stream_live_inputs", STREAMING_ALICE)?.enabled).toBe(true);
    expect(hasTestid(html, "streaming-disabled")).toBe(false);
    expect(hasTestid(html, "streaming-key-masked")).toBe(true);
  });

  it("full lifecycle order is provision, rotate, disable, enable on one input", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");

    const first = await setupGet(fx, cookie);
    expect(first.status).toBe(200);
    await rotateHtml(cookie);
    await flipAndRead(cookie, "disable");
    await flipAndRead(cookie, "enable");

    const uid = fx.cf.firstUid()!;
    const kinds = fx.cf.calls
      .filter((call) => new URL(call.url).hostname === "api.cloudflare.com")
      .map((call) => `${call.method} ${new URL(call.url).pathname}`);
    expect(kinds).toEqual([
      `POST /client/v4/accounts/${STREAMING_CF_ACCOUNT}/stream/live_inputs`,
      `POST /client/v4/accounts/${STREAMING_CF_ACCOUNT}/stream/live_inputs/${uid}/rotate_keys`,
      `PUT /client/v4/accounts/${STREAMING_CF_ACCOUNT}/stream/live_inputs/${uid}`,
      `PUT /client/v4/accounts/${STREAMING_CF_ACCOUNT}/stream/live_inputs/${uid}`,
    ]);
    expect(countOccurrences(JSON.stringify(fx.cf.calls), uid)).toBeGreaterThanOrEqual(3);
  });

  it("connection status reflects the current lifecycle on every load", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const first = await setupGet(fx, cookie);
    expect(first.status).toBe(200);
    const uid = fx.cf.firstUid()!;

    fx.cf.setLive(uid, true);
    const liveHtml = await (await setupGet(fx, cookie)).text();
    fx.cf.setLive(uid, false);
    const idleHtml = await (await setupGet(fx, cookie)).text();

    const liveText = testidText(liveHtml, "streaming-status") ?? "";
    const idleText = testidText(idleHtml, "streaming-status") ?? "";
    expect(liveText).toMatch(/connect|live/i);
    expect(idleText).toMatch(/offline|not connected|idle/i);
    expect(liveText).not.toBe(idleText);
  });
});

describe("gates", () => {
  it("guest GET bounces to Discord login with no side effects", async () => {
    const res = await fx.request("/streaming/setup");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expect(fx.cf.calls).toHaveLength(0);
    expect(fx.sdb.rowCount("stream_live_inputs")).toBe(0);
  });

  it("guest POST redirects with no side effects", async () => {
    const res = await fx.request("/streaming/setup/rotate", {
      method: "POST",
      headers: {
        origin: STREAMING_APP_URL,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    });

    expect([302, 303]).toContain(res.status);
    expect(res.headers.get("location")).toBeTruthy();
    expect(fx.cf.calls).toHaveLength(0);
    expect(fx.sdb.rowCount("stream_live_inputs")).toBe(0);
  });

  it("signed-in non-member gets 403 with no side effects", async () => {
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice", false);

    const res = await setupGet(fx, cookie);

    expect(res.status).toBe(403);
    expect(fx.cf.calls).toHaveLength(0);
    expect(fx.sdb.rowCount("stream_live_inputs")).toBe(0);
  });

  it("member without a subscription gets the subscribe gate, not a provision", async () => {
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");

    const res = await setupGet(fx, cookie);

    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html.toLowerCase()).toContain("subscri");
    expect(hasTestid(html, "streaming-subscribe")).toBe(true);
    expect(/<a\b[^>]*data-testid="streaming-subscribe"[^>]*href="\/streaming"/.test(html)).toBe(
      true,
    );
    expect(fx.cf.calls).toHaveLength(0);
    expect(fx.sdb.rowCount("stream_live_inputs")).toBe(0);
  });

  it.each([
    { name: "active", status: "active", periodEndAgoDays: -30, admitted: true },
    { name: "fresh past_due", status: "past_due", periodEndAgoDays: 1, admitted: true },
    { name: "stale past_due", status: "past_due", periodEndAgoDays: 4, admitted: false },
    { name: "canceled", status: "canceled", periodEndAgoDays: 1, admitted: false },
    { name: "paused", status: "paused", periodEndAgoDays: 1, admitted: false },
  ])("entitlement: $name admitted=$admitted", async ({ status, periodEndAgoDays, admitted }) => {
    fx.sdb.seedSubscription(STREAMING_ALICE, {
      status,
      current_period_end: new Date(Date.now() - periodEndAgoDays * 86_400_000),
    });
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");

    const res = await setupGet(fx, cookie);

    expect(res.status).toBe(admitted ? 200 : 403);
    expect(fx.cf.provisions()).toHaveLength(admitted ? 1 : 0);
    expect(fx.sdb.rowCount("stream_live_inputs")).toBe(admitted ? 1 : 0);
  });

  it("owner-only: a second member provisions their own input and never sees the first key", async () => {
    activeSubscription(STREAMING_ALICE);
    activeSubscription(STREAMING_BOB);
    const alice = await fx.cookieFor(STREAMING_ALICE, "alice");
    const bob = await fx.cookieFor(STREAMING_BOB, "bob");
    const aliceRes = await setupGet(fx, alice);
    expect(aliceRes.status).toBe(200);
    const aliceFirst = await aliceRes.text();
    const aliceKey = testidText(aliceFirst, "streaming-key-once")!;
    expect(typeof aliceKey).toBe("string");

    const bobRes = await setupGet(fx, bob);
    expect(bobRes.status).toBe(200);
    const bobFirst = await bobRes.text();
    const bobReload = await (await setupGet(fx, bob)).text();
    const aliceReload = await (await setupGet(fx, alice)).text();

    expect(fx.cf.provisions()).toHaveLength(2);
    expect((fx.cf.provisions()[1]!.body as { meta?: { name?: unknown } }).meta?.name).toBe(
      `two:${STREAMING_BOB}`,
    );
    const bobKey = testidText(bobFirst, "streaming-key-once")!;
    expect(typeof bobKey).toBe("string");
    expect(bobKey).not.toBe(aliceKey);
    expect(bobFirst).not.toContain(aliceKey);
    expect(bobReload).not.toContain(aliceKey);
    expect(aliceReload).not.toContain(bobKey);
  });

  it("writes share the 30/min throttle: the 31st rotate is refused with no Cloudflare call", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const first = await setupGet(fx, cookie);
    expect(first.status).toBe(200);

    for (let n = 0; n < 30; n++) {
      const res = await setupAction(fx, cookie, "rotate");
      expect([200, 303, 302]).toContain(res.status);
    }
    const refused = await setupAction(fx, cookie, "rotate");

    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();
    expect(fx.cf.rotates()).toHaveLength(30);
    const uid = fx.cf.firstUid()!;
    const current = fx.cf.currentKey(uid)!;
    const reload = await (await setupGet(fx, cookie)).text();
    expect(reload).not.toContain(current);
  });

  it("reads never consult the throttle store", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");

    for (let n = 0; n < 3; n++) {
      const res = await setupGet(fx, cookie);
      expect(res.status).toBe(200);
    }

    expect(fx.throttle.checks).toHaveLength(0);
  });

  it("disable and enable consult the throttle store", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");
    const first = await setupGet(fx, cookie);
    expect(first.status).toBe(200);

    await flipAndRead(cookie, "disable");
    await flipAndRead(cookie, "enable");

    expect(fx.throttle.checks.length).toBeGreaterThanOrEqual(2);
  });

  it("setup responses are never cached", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");

    const get = await setupGet(fx, cookie);
    expect(get.status).toBe(200);
    const rotate = await setupAction(fx, cookie, "rotate");
    expect([200, 303, 302]).toContain(rotate.status);

    for (const res of [get, rotate]) {
      expect(res.headers.get("cache-control")).toMatch(/private/);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
    }
  });
});

describe("page shape", () => {
  it("setup page has one h1 and labelled rotate/disable actions", async () => {
    activeSubscription(STREAMING_ALICE);
    const cookie = await fx.cookieFor(STREAMING_ALICE, "alice");

    const res = await setupGet(fx, cookie);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(countOccurrences(html, "<h1")).toBe(1);
    const rotateForm = formFor(html, "streaming-rotate");
    expect(rotateForm).not.toBeNull();
    expect(rotateForm as string).toMatch(/rotat/i);
    const disableForm = formFor(html, "streaming-disable");
    expect(disableForm).not.toBeNull();
    expect(disableForm as string).toMatch(/disabl/i);
  });
});

describe("CONTROL: fake fidelity", () => {
  it("fake Cloudflare mirrors the recorded provision, rotate, update, and lifecycle shapes", async () => {
    const provisioned = await fx.cf.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${STREAMING_CF_ACCOUNT}/stream/live_inputs`,
      {
        method: "POST",
        headers: { authorization: "Bearer fixture" },
        body: JSON.stringify({ meta: { name: "two:1" }, recording: { mode: "off" } }),
      },
    );
    expect(provisioned.status).toBe(200);
    const created = (await provisioned.json()) as {
      success: boolean;
      result: {
        uid: string;
        rtmps: { url: string; streamKey: string };
        recording: { mode: string };
      };
    };
    expect(created.success).toBe(true);
    expect(created.result.rtmps.url).toBe(STREAMING_RTMPS_URL);
    expect(created.result.recording.mode).toBe("off");

    const uid = created.result.uid;
    const oldKey = created.result.rtmps.streamKey;
    const rotated = await fx.cf.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${STREAMING_CF_ACCOUNT}/stream/live_inputs/${uid}/rotate_keys`,
      { method: "POST", body: "" },
    );
    const rotatedBody = (await rotated.json()) as {
      result: { uid: string; rtmps: { streamKey: string } };
    };
    expect(rotatedBody.result.uid).toBe(uid);
    expect(rotatedBody.result.rtmps.streamKey).not.toBe(oldKey);
    expect(fx.cf.isDead(oldKey)).toBe(true);

    const disabled = await fx.cf.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${STREAMING_CF_ACCOUNT}/stream/live_inputs/${uid}`,
      { method: "PUT", body: JSON.stringify({ enabled: false }) },
    );
    expect(((await disabled.json()) as { result: { enabled: boolean } }).result.enabled).toBe(
      false,
    );

    const idle = (await (
      await fx.cf.fetch(`https://customer-fixture.cloudflarestream.com/${uid}/lifecycle`)
    ).json()) as { live: boolean };
    expect(idle.live).toBe(false);
    fx.cf.setLive(uid, true);
    const live = (await (
      await fx.cf.fetch(`https://customer-fixture.cloudflarestream.com/${uid}/lifecycle`)
    ).json()) as { live: boolean };
    expect(live.live).toBe(true);

    const missing = await fx.cf.fetch(
      `https://api.cloudflare.com/client/v4/accounts/${STREAMING_CF_ACCOUNT}/stream/live_inputs/nope/rotate_keys`,
      { method: "POST", body: "" },
    );
    expect(missing.status).toBe(404);

    expect(consoleCapture.lines.join("\n")).not.toContain("fake-ingest-key-");
  });
});
