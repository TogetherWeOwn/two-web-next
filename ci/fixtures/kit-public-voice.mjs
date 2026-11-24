import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import postgres from "postgres";
import { fixtureSession } from "../kit-live-socket.mjs";
import { SESSION_COOKIE } from "../parity/fixture.mjs";
import { ingest, liveFixtureSnapshot } from "./kit-live-fanout.mjs";
import frames from "./kit-live-frames.json" with { type: "json" };

const socketPath = "/api/discord-live/v1";
const scriptPath = "/islands/kit-public-voice.js";
const memberId = "900000000000001391";
const withheld = "Voice count withheld.";
const unavailable = "Voice numbers are not available right now.";
const voice = (count) => `${count} in voice right now.`;
const subscribe = { v: 1, type: "subscribe", topics: ["voice"] };
const resync = { ...subscribe, type: "resync" };
const upsert = (id) => ({
  topic: "voice",
  op: "upsert",
  id,
  value: { userId: id, channelId: "10" },
});

async function capture(page, state) {
  const directory = process.env.KIT_PUBLIC_VOICE_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: join(directory, `${state}-${width}x${height}.png`) });
  }
}

function observe(page) {
  const sockets = [];
  page.on("websocket", (socket) => {
    const trace = { url: socket.url(), sent: [], received: [], closed: false };
    sockets.push(trace);
    socket.on("framesent", ({ payload }) => trace.sent.push(JSON.parse(payload)));
    socket.on("framereceived", ({ payload }) => trace.received.push(JSON.parse(payload)));
    socket.on("close", () => {
      trace.closed = true;
    });
  });
  return sockets;
}

async function openHome(page, origin) {
  const response = await page.goto(origin);
  assert.equal(response.status(), 200);
  assert.equal(response.headers()["x-two-renderer"], "kit");
  assert.equal(response.headers()["cache-control"], "private, no-store");
  return response.text();
}

async function setSession(page, origin, cookie) {
  await page.context().addCookies([
    {
      name: SESSION_COOKIE,
      value: cookie.slice(SESSION_COOKIE.length + 1),
      domain: new URL(origin).hostname,
      path: "/",
      secure: true,
      httpOnly: true,
    },
  ]);
}

async function verifyRefusedRetries(sql, sockets, first, count, reason) {
  async function scans() {
    // This phase has no session writers or other session-bearing pages.
    // Include sequential scans so the assertion is independent of the plan.
    const [row] = await sql`select (seq_scan + idx_scan)::float8 as scans
      from pg_stat_user_tables where relid = 'web_sessions'::regclass`;
    return row.scans;
  }
  // The second refusal gives the initial database connection time to exit and
  // flush its stats. Compare completed retries while the cookie is unchanged.
  await expect.poll(() => sockets[first + 1]?.closed, { timeout: 12_000 }).toBe(true);
  const before = await scans();
  await expect.poll(() => sockets[first + 2]?.closed, { timeout: 12_000 }).toBe(true);
  await expect.poll(() => sockets[first + 3]?.closed, { timeout: 12_000 }).toBe(true);
  assert.equal(await scans(), before, `${reason} cookie retries should reuse the refusal`);
  for (const attempt of sockets.slice(first, first + 4)) {
    assert.deepEqual(attempt.sent, []);
    assert.deepEqual(attempt.received, []);
  }
  await expect(count).toHaveText(unavailable);
}

export async function verifyKitPublicVoice(offOrigin, liveOrigin, databaseUrl, secret) {
  const source = async (seq, count) => {
    const response = await fetch(`${liveOrigin}/__fixture/live-source`, {
      method: "POST",
      body: JSON.stringify(liveFixtureSnapshot(seq, count)),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    await response.body?.cancel();
  };
  const browser = await chromium.launch();
  const sql = postgres(databaseUrl, { max: 1 });
  async function mintSession(lifetime) {
    const { ref, cookie } = await fixtureSession(secret);
    await sql`insert into web_sessions (token_hash, user_id, username, member, expires_at)
      values (${ref}, ${memberId}, 'Synthetic homepage member', true,
        clock_timestamp() + ${lifetime}::interval)`;
    return cookie;
  }
  try {
    const guest = await browser.newPage();
    const offSockets = observe(guest);
    const offHtml = await openHome(guest, offOrigin);
    assert.ok(!offHtml.includes(scriptPath));
    await expect(guest.locator("#home-public-voice")).toHaveCount(0);
    await expect(guest.getByTestId("join")).toBeVisible();
    const disabled = await guest.request.get(offOrigin + socketPath);
    assert.equal(disabled.status(), 503);
    assert.equal(disabled.headers()["cache-control"], "no-store");
    await capture(guest, "off");
    assert.deepEqual(offSockets, []);
    await guest.close();

    const page = await browser.newPage();
    const sockets = observe(page);
    await source(100, 4);
    const html = await openHome(page, liveOrigin);
    assert.ok(html.includes(scriptPath));
    assert.match(html, /Voice numbers are not available right now/);
    const count = page.locator("#home-public-voice");
    await expect(count).toHaveText(withheld, { timeout: 12_000 });
    assert.deepEqual(sockets[0].sent, [subscribe]);
    assert.deepEqual(sockets[0].received.at(-1), frames.initial);
    await capture(page, "suppressed");

    assert.equal(await ingest(liveOrigin, 101, upsert("105")), 204);
    await expect(count).toHaveText(voice(5));
    assert.deepEqual(sockets[0].received.at(-1), frames.five);
    await capture(page, "live");

    const member = await browser.newPage();
    const memberSockets = observe(member);
    await setSession(member, liveOrigin, await mintSession("10 minutes"));
    await source(101, 5);
    const memberHtml = await openHome(member, liveOrigin);
    await expect(member.locator("#discord-heading")).toBeVisible();
    assert.doesNotMatch(memberHtml, /Synthetic room|Synthetic occupant/);
    const memberCount = member.locator("#home-public-voice");
    await expect(memberCount).toHaveText(voice(5), { timeout: 12_000 });
    assert.deepEqual(memberSockets[0].sent, [subscribe]);
    const publicBaseline = { ...frames.initial, value: { count: 5 } };
    assert.deepEqual(memberSockets[0].received.at(-1), publicBaseline);

    // Revoke all synthetic rows for this viewer, including any document rotation.
    await sql`update web_sessions set revoked_at = clock_timestamp() where user_id = ${memberId}`;
    await source(102, 6);
    assert.equal(await ingest(liveOrigin, 102, upsert("106")), 204);
    await expect(count).toHaveText(voice(6));
    await expect(memberCount).toHaveText(unavailable);
    assert.deepEqual(memberSockets[0].received.at(-1), publicBaseline);
    await verifyRefusedRetries(sql, memberSockets, 1, memberCount, "revoked");
    await setSession(member, liveOrigin, await mintSession("10 minutes"));
    await expect(memberCount).toHaveText(voice(6), { timeout: 20_000 });
    assert.deepEqual(memberSockets.at(-1).received.at(-1), {
      ...publicBaseline,
      value: { count: 6 },
    });
    await member.close();

    // A producer gap withdraws the old value before the covering source is available.
    const heading = await page.locator("#home-heading").textContent();
    assert.equal(await ingest(liveOrigin, 104, upsert("106")), 409);
    await expect(count).toHaveText(unavailable);
    assert.deepEqual(sockets[0].received.at(-1), frames.withdrawal);
    await expect(page.locator("#home-heading")).toHaveText(heading.trim());
    await expect(page.getByTestId("join")).toBeVisible();
    await capture(page, "unavailable");
    await source(104, 5);
    await expect(count).toHaveText(voice(5), { timeout: 12_000 });
    assert.equal(sockets.length, 1);
    assert.deepEqual(sockets[0].sent, [subscribe, resync]);
    assert.deepEqual(sockets[0].received.at(-1), frames.covering);

    // Deliver the events of a persisted traversal explicitly so browser cache
    // eligibility does not determine whether these handlers are exercised.
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })),
    );
    await expect(count).toHaveText(unavailable);
    await expect.poll(() => sockets[0].closed).toBe(true);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await expect(count).toHaveText(voice(5), { timeout: 12_000 });
    assert.equal(sockets.length, 2);
    assert.deepEqual(sockets[1].sent, [subscribe]);
    assert.deepEqual(sockets[1].received.at(-1), publicBaseline);

    const expired = await browser.newPage();
    const expiredSockets = observe(expired);
    await setSession(expired, liveOrigin, await mintSession("-1 minute"));
    await openHome(expired, liveOrigin);
    const expiredCount = expired.locator("#home-public-voice");
    await verifyRefusedRetries(sql, expiredSockets, 0, expiredCount, "expired");
    await expired.context().clearCookies();
    await expect(expiredCount).toHaveText(voice(5), { timeout: 20_000 });
    assert.deepEqual(expiredSockets.at(-1).received.at(-1), publicBaseline);

    const socketUrl = new URL(socketPath, liveOrigin.replace(/^http:/, "ws:")).href;
    assert.ok(
      [...sockets, ...memberSockets, ...expiredSockets].every(({ url }) => url === socketUrl),
    );
    console.log(
      "PASS installed Kit home: default off, public-only updates, bounded revoked and expired admission reads, reconnect, gap withdrawal/resync and page lifecycle",
    );
  } finally {
    await browser.close();
    try {
      await sql`delete from web_sessions where user_id = ${memberId}`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}
