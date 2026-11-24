import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";
import postgres from "postgres";
import { fixtureSession, refusal } from "../kit-live-socket.mjs";
import { SESSION_COOKIE } from "../parity/fixture.mjs";
import { ingest, liveFixtureSnapshot } from "./kit-live-fanout.mjs";
import frames from "./kit-live-frames.json" with { type: "json" };

const socketPath = "/api/discord-live/v1";
const scriptPath = "/islands/kit-public-voice.js";
const memberId = "900000000000001391";
const eventKey = "01J00000000000000000000666";
const eventTitle = "Synthetic Voice Night";
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
  const event = state.startsWith("event-");
  if (!directory && !event) return;
  if (directory) await mkdir(directory, { recursive: true });
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    if (event) {
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    if (state === "event-live") {
      const panel = page.getByRole("complementary", { name: "Community voice" });
      await expect(panel).toHaveCSS("border-top-width", "1px");
      await expect(panel).toHaveCSS("padding-inline-start", "6px");
      await expect(panel.getByRole("heading")).toHaveCSS("font-size", "15px");
    }
    if (directory) {
      await page.screenshot({
        path: join(directory, `${state}-${width}x${height}.png`),
        fullPage: event,
      });
    }
  }
}

function observe(page) {
  const sockets = [];
  page.on("websocket", (socket) => {
    const trace = { url: socket.url(), sent: [], received: [], errors: [], closed: false };
    sockets.push(trace);
    socket.on("framesent", ({ payload }) => trace.sent.push(JSON.parse(payload)));
    socket.on("framereceived", ({ payload }) => trace.received.push(JSON.parse(payload)));
    socket.on("socketerror", (error) => trace.errors.push(error));
    socket.on("close", () => {
      trace.closed = true;
    });
  });
  return sockets;
}

async function openDocument(page, url) {
  const response = await page.goto(url);
  assert.equal(response.status(), 200);
  assert.equal(response.headers()["x-two-renderer"], "kit");
  assert.equal(response.headers()["cache-control"], "private, no-store");
  return response.text();
}

async function verifyEventVoice(browser, offOrigin, liveOrigin, source, mintSession) {
  const path = `/e/${eventKey}`;
  const panelSelector = "[data-public-voice-panel]";
  const guest = await browser.newPage();
  const sockets = observe(guest);
  const panel = guest.locator(panelSelector);
  const count = panel.locator("[data-public-voice-count]");
  const seat = guest.getByTestId("kit-seat-card");
  const rsvp = seat.getByRole("link", { name: "Log in with Discord" });

  const offHtml = await openDocument(guest, offOrigin + path);
  assert.ok(!offHtml.includes(scriptPath));
  await expect(panel).toHaveCount(0);
  await expect(rsvp).toBeVisible();
  await capture(guest, "event-off");
  assert.deepEqual(sockets, []);

  await source(104, 5);
  const html = await openDocument(guest, liveOrigin + path);
  assert.ok(html.includes(scriptPath));
  assert.doesNotMatch(html, /Synthetic room|Synthetic occupant|Pull me in/);
  await expect(guest.getByRole("heading", { level: 1 })).toHaveText(eventTitle);
  await expect(count).toHaveText(voice(5), { timeout: 12_000 });
  await expect(panel).toHaveAccessibleName("Community voice");
  await expect(panel.locator("a, button, [tabindex]")).toHaveCount(0);
  assert.ok(
    await guest.getByTestId("kit-event-facts").evaluate((facts) => {
      const panel = document.querySelector("[data-public-voice-panel]");
      return Boolean(facts.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING);
    }),
  );
  assert.deepEqual(sockets[0].sent, [subscribe]);
  await capture(guest, "event-live");

  assert.equal(await ingest(liveOrigin, 105, { topic: "voice", op: "remove", id: "105" }), 204);
  await expect(panel).toBeHidden();
  await expect(count).toBeEmpty();
  await capture(guest, "event-suppressed");
  assert.equal(await ingest(liveOrigin, 106, upsert("105")), 204);
  await expect(count).toHaveText(voice(5));

  await source(108, 6, true);
  assert.equal(await ingest(liveOrigin, 108, upsert("106")), 409);
  await expect(panel).toBeHidden();
  await expect(rsvp).toBeVisible();
  await capture(guest, "event-recovering");
  await source(108, 6);
  await expect(count).toHaveText(voice(6), { timeout: 12_000 });
  assert.deepEqual(sockets[0].sent, [subscribe, resync]);
  assert.ok(
    sockets[0].received.every(
      (frame) => !frame.value || Object.keys(frame.value).join() === "count",
    ),
  );
  await guest.close();

  const member = await browser.newPage();
  const memberSockets = observe(member);
  await setSession(member, liveOrigin, await mintSession("10 minutes"));
  const memberHtml = await openDocument(member, liveOrigin + path);
  assert.match(memberHtml, /Synthetic voice viewer/);
  assert.ok(!memberHtml.includes(scriptPath));
  assert.doesNotMatch(memberHtml, /Synthetic room|Synthetic occupant|Pull me in/);
  await expect(member.locator(panelSelector)).toHaveCount(0);
  await capture(member, "event-member-without-proof");
  assert.deepEqual(memberSockets, []);
  await member.close();

  const signedIn = await browser.newPage();
  await setSession(signedIn, liveOrigin, await mintSession("10 minutes", false));
  assert.match(await openDocument(signedIn, liveOrigin + path), /Synthetic voice viewer/);
  await expect(signedIn.locator("[data-public-voice-count]")).toHaveText(voice(6), {
    timeout: 12_000,
  });
  await signedIn.close();
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

async function pauseRetryClock(page) {
  const time = new Date();
  await page.clock.install({ time });
  await page.clock.pauseAt(time.getTime() + 60_000);
}

async function verifyRefusedRetries(sql, sockets, first, checkUncached, count, reason) {
  async function assertRefusal(index) {
    await expect.poll(() => sockets[index]?.closed, { timeout: 12_000 }).toBe(true);
    const trace = sockets[index];
    assert.match(
      trace.errors.join("\n"),
      /\b401\b|^HTTP Authentication failed\b/m,
      `${reason} cookie upgrade ${index}`,
    );
    assert.deepEqual(trace.sent, []);
    assert.deepEqual(trace.received, []);
  }

  const { clock } = count.page();
  const nextDelay = first === 0 ? 1000 : 2000;
  async function retryUnderLock() {
    for (const [index, delay] of [nextDelay, nextDelay * 2].entries()) {
      await clock.runFor(delay);
      await assertRefusal(first + index + 1);
    }
  }

  await assertRefusal(first);
  // With the disposable session table locked, a fresh read times out with
  // 503. The same browser bearer must still receive 401 on each retry.
  await sql.begin(async (tx) => {
    await tx`set local lock_timeout = '2s'`;
    await tx`set local idle_in_transaction_session_timeout = '20s'`;
    await tx`lock table web_sessions in access exclusive mode`;
    assert.equal(sockets.length, first + 1, `${reason} fixture must lock before the next retry`);
    await Promise.all([retryUnderLock(), checkUncached()]);
  });
  await expect(count).toHaveText(unavailable);
  return nextDelay * 4;
}

export async function verifyKitPublicVoice(offOrigin, liveOrigin, databaseUrl, secret) {
  const source = async (seq, count, hold = false) => {
    const response = await fetch(`${liveOrigin}/__fixture/live-source${hold ? "?hold" : ""}`, {
      method: "POST",
      body: JSON.stringify(liveFixtureSnapshot(seq, count)),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    await response.body?.cancel();
  };
  const browser = await chromium.launch();
  const sql = postgres(databaseUrl, { max: 1 });
  async function mintSession(lifetime, member = true) {
    const { ref, cookie } = await fixtureSession(secret);
    await sql`insert into web_sessions (token_hash, user_id, username, member, expires_at)
      values (${ref}, ${memberId}, 'Synthetic voice viewer', ${member},
        clock_timestamp() + ${lifetime}::interval)`;
    return cookie;
  }
  try {
    const probe = await fixtureSession(secret);
    const checkUncached = async () => {
      const status = await refusal(liveOrigin + socketPath, {
        Origin: liveOrigin,
        Cookie: probe.cookie,
      });
      assert.equal(status, 503, "a different bearer needs the blocked session read");
    };
    const guest = await browser.newPage();
    const offSockets = observe(guest);
    const offHtml = await openDocument(guest, offOrigin);
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
    const html = await openDocument(page, liveOrigin);
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
    await pauseRetryClock(member);
    await setSession(member, liveOrigin, await mintSession("10 minutes"));
    await source(101, 5);
    const memberHtml = await openDocument(member, liveOrigin);
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
    await member.clock.runFor(1000);
    const memberRetry = await verifyRefusedRetries(
      sql,
      memberSockets,
      1,
      checkUncached,
      memberCount,
      "revoked",
    );
    await setSession(member, liveOrigin, await mintSession("10 minutes"));
    await member.clock.runFor(memberRetry);
    await expect(memberCount).toHaveText(voice(6), { timeout: 20_000 });
    assert.deepEqual(memberSockets.at(-1).received.at(-1), {
      ...publicBaseline,
      value: { count: 6 },
    });
    await member.close();

    // A producer gap withdraws the old value before the covering source is available.
    const heading = await page.locator("#home-heading").textContent();
    await source(104, 5, true);
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
    await pauseRetryClock(expired);
    await setSession(expired, liveOrigin, await mintSession("-1 minute"));
    await openDocument(expired, liveOrigin);
    const expiredCount = expired.locator("#home-public-voice");
    const expiredRetry = await verifyRefusedRetries(
      sql,
      expiredSockets,
      0,
      checkUncached,
      expiredCount,
      "expired",
    );
    await expired.context().clearCookies();
    await expired.clock.runFor(expiredRetry);
    await expect(expiredCount).toHaveText(voice(5), { timeout: 20_000 });
    assert.deepEqual(expiredSockets.at(-1).received.at(-1), publicBaseline);

    const socketUrl = new URL(socketPath, liveOrigin.replace(/^http:/, "ws:")).href;
    assert.ok(
      [...sockets, ...memberSockets, ...expiredSockets].every(({ url }) => url === socketUrl),
    );
    await page.close();
    await sql`insert into events (event_key, title, game, starts_at, ends_at, timezone, status, capacity, rsvp_open)
      values (${eventKey}, ${eventTitle}, 'Valheim', '2099-01-01T18:00:00Z',
        '2099-01-01T20:00:00Z', 'UTC', 'published', 10, true)`;
    try {
      await verifyEventVoice(browser, offOrigin, liveOrigin, source, mintSession);

      // Keep the status published to exercise the elapsed time boundary.
      await sql`update events set starts_at = '2020-01-01T18:00:00Z',
        ends_at = '2020-01-01T20:00:00Z' where event_key = ${eventKey}`;
      const ended = await browser.newPage();
      const endedSockets = observe(ended);
      assert.ok(!(await openDocument(ended, `${liveOrigin}/e/${eventKey}`)).includes(scriptPath));
      await expect(ended.getByTestId("event-past")).toBeVisible();
      await expect(ended.locator("[data-public-voice-panel]")).toHaveCount(0);
      await capture(ended, "event-ended");
      assert.deepEqual(endedSockets, []);
      await ended.close();
    } finally {
      await sql`delete from events where event_key = ${eventKey}`;
    }
    console.log(
      "PASS installed Kit home and event detail: default off, public-only updates, member isolation, bounded refused retries, gap recovery and page lifecycle",
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
