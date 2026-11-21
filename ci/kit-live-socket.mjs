import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { WebSocket } from "undici";
import { SESSION_COOKIE } from "./parity/fixture.mjs";

const path = "/api/discord-live/v1";
const deadline = () => ({ signal: AbortSignal.timeout(5_000) });
const awaitEvent = (socket, event, phase, timeout = 5_000) =>
  once(socket, event, { signal: AbortSignal.timeout(timeout) }).catch((cause) => {
    throw new Error(`${phase}: waiting for ${event} (readyState=${socket.readyState})`, { cause });
  });

function refusal(url, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url, {
      ...deadline(),
      headers: {
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
        ...headers,
      },
    });
    req.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
}

async function fixtureSession(secret) {
  const token = `two_${randomBytes(32).toString("base64url")}`;
  const ref = createHash("sha256").update(token).digest("hex");
  const cookie = (
    await generateSignedCookie(SESSION_COOKIE, token, secret, { secure: true, path: "/" })
  ).split(";", 1)[0];
  return { ref, cookie };
}

export async function verifyKitLiveSocket(origin, appOrigin, databaseUrl, secret) {
  const url = `${origin}${path}`;
  const headers = { Origin: appOrigin };
  assert.equal(await refusal(url, { Origin: "https://unexpected.invalid" }), 403);
  assert.equal(await refusal(`${url}?topic=voice`, headers), 400);
  assert.equal(await refusal(url, { ...headers, Cookie: `${SESSION_COOKIE}=malformed` }), 401);
  assert.equal((await fetch(url, { headers, ...deadline() })).status, 426);

  const { ref, cookie } = await fixtureSession(secret);
  const laterSession = await fixtureSession(secret);
  const sql = postgres(databaseUrl, { max: 1 });
  const sockets = [];
  const open = async (headers) => {
    const socket = new WebSocket(url.replace(/^http:/, "ws:"), { headers });
    sockets.push(socket);
    await awaitEvent(socket, "open", "session scenario upgrade"); // Undici verifies the 101.
    return socket;
  };
  const subscribe = JSON.stringify({ v: 1, type: "subscribe", topics: ["voice"] });
  try {
    const guest = await open(headers);
    const frame = awaitEvent(guest, "message", "guest subscribe");
    guest.send(subscribe);
    assert.deepEqual(JSON.parse((await frame)[0].data), {
      v: 1,
      type: "unavailable",
      topic: "voice",
    });
    const duplicate = awaitEvent(guest, "close", "duplicate subscribe");
    guest.send(subscribe);
    assert.equal((await duplicate)[0].code, 1008);

    await sql`insert into web_sessions (token_hash, user_id, username, member, expires_at)
      values (${ref}, '900000000000001377', 'Live socket fixture', true, now() + interval '10 minutes')`;
    const signedIn = await open({ ...headers, Cookie: cookie });
    await sql`update web_sessions set revoked_at = clock_timestamp() where token_hash = ${ref}`;
    const closed = awaitEvent(signedIn, "close", "revoked session subscribe");
    let deliveries = 0;
    signedIn.addEventListener("message", () => deliveries++);
    signedIn.send(subscribe);
    assert.equal((await closed)[0].code, 1008);
    assert.equal(deliveries, 0);
    assert.equal(await refusal(url, { ...headers, Cookie: cookie }), 401);

    await sql`update web_sessions set revoked_at = null where token_hash = ${ref}`;
    const expiring = await open({ ...headers, Cookie: cookie });
    await sql`update web_sessions set expires_at = clock_timestamp() where token_hash = ${ref}`;
    const expired = awaitEvent(expiring, "close", "expired session subscribe");
    expiring.addEventListener("message", () => deliveries++);
    expiring.send(subscribe);
    assert.equal((await expired)[0].code, 1008);
    assert.equal(deliveries, 0);

    await sql`insert into web_sessions (token_hash, user_id, username, member, expires_at)
      values (${laterSession.ref}, '900000000000001378', 'Later live socket', true,
        clock_timestamp() + interval '10 seconds')`;
    await sql`update web_sessions set expires_at = clock_timestamp() + interval '5 seconds'
      where token_hash = ${ref}`;
    const later = await open({ ...headers, Cookie: laterSession.cookie });
    const first = await open({ ...headers, Cookie: cookie });
    first.addEventListener("message", () => deliveries++);
    later.addEventListener("message", () => deliveries++);
    // Admit the later lease first so the early one must replace its pending alarm.
    // Neither socket sends a command; only the alarm can close it.
    const firstClosed = awaitEvent(first, "close", "first idle session alarm", 9_000);
    const laterClosed = awaitEvent(later, "close", "second idle session alarm", 15_000);
    const [firstEvent, laterEvent] = await Promise.all([
      firstClosed.then(([event]) => {
        assert.equal(later.readyState, WebSocket.OPEN);
        return event;
      }),
      laterClosed.then(([event]) => event),
    ]);
    assert.equal(firstEvent.code, 1008);
    assert.equal(laterEvent.code, 1008);
    assert.equal(deliveries, 0);
    console.log(
      "PASS installed Kit live socket 101, guest control, revocation, and staggered idle session expiry",
    );
  } finally {
    for (const socket of sockets) socket.close();
    try {
      await sql`delete from web_sessions where token_hash in (${ref}, ${laterSession.ref})`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}

const ingestPath = "/internal/discord-live/v1/ingest";
const guild = "326474832151838730";
const people = ["101", "102", "103", "104", "105", "106"];
const permissions = String((1 << 10) | (1 << 20));
const at = "2026-11-20T00:00:00Z";
const voice = (userId, channelId) => ({ userId, channelId });
const join = (id, channelId) => ({ topic: "voice", op: "upsert", id, value: voice(id, channelId) });
const leave = (id) => ({ topic: "voice", op: "remove", id });
const unavailable = { v: 1, type: "unavailable", topic: "voice" };
const projected = (type, seq, count) => ({ v: 1, type, topic: "voice", seq, value: { count } });

function snapshot(seq, count, observedAt = new Date().toISOString()) {
  const room = (id, overwrites) => ({
    id,
    name: "Fixture room",
    kind: "voice",
    parentId: null,
    position: null,
    overwrites,
  });
  return {
    v: 1,
    guild_id: guild,
    seq,
    observed_at: observedAt,
    topics: {
      guild: { ownerId: people[0], afkChannelId: null },
      channels: [
        room("10", []),
        room("11", [{ kind: "role", id: guild, allow: "0", deny: permissions }]),
      ],
      roles: [{ id: guild, permissions }],
      members: people.map((userId) => ({
        userId,
        nick: null,
        bot: false,
        pending: false,
        roleIds: [],
      })),
      voice: people.slice(0, count).map((id) => voice(id, "10")),
      events: [],
    },
  };
}

async function ingest(origin, seq, op) {
  const body = JSON.stringify({ v: 1, guild_id: guild, seq, occurred_at: at, ops: [op] });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const digest = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", "fixture-ingest-value")
    .update(`POST\n${ingestPath}\n${timestamp}\n${nonce}\n${digest}`)
    .digest("hex");
  const response = await fetch(`${origin}${ingestPath}`, {
    ...deadline(),
    method: "POST",
    body,
    headers: {
      "X-TWO-Key-Id": "fixture-ingest",
      "X-TWO-Timestamp": timestamp,
      "X-TWO-Nonce": nonce,
      "X-TWO-Signature": `sha256=${signature}`,
    },
  });
  await response.body?.cancel();
  return response.status;
}

export async function verifyKitLiveFanout(origin, appOrigin, databaseUrl, secret) {
  const control = `${origin}/__fixture/live-source`;
  const source = async (doc) => {
    const response = await fetch(control, {
      ...deadline(),
      ...(doc ? { method: "POST", body: JSON.stringify(doc) } : {}),
    });
    assert.equal(response.status, 200);
    return (await response.json()).generation;
  };
  await source(snapshot(40, 4));
  assert.equal(await ingest(origin, 40, leave("105")), 204, "cold signed snapshot");
  const socket = new WebSocket(`${origin}${path}`.replace(/^http:/, "ws:"), {
    headers: { Origin: appOrigin },
  });
  const frames = [];
  socket.addEventListener("message", ({ data }) => frames.push({ data, at: Date.now() }));
  const expectFrame = async (want, timeout = 5_000) => {
    if (!frames.length) await awaitEvent(socket, "message", JSON.stringify(want), timeout);
    const { data, at } = frames.shift();
    assert.equal(typeof data, "string");
    const actual = JSON.parse(data);
    assert.deepEqual(actual, want);
    return { actual, at };
  };
  const command = (type) => JSON.stringify({ v: 1, type, topics: ["voice"] });
  const send = (type) => socket.send(command(type));
  const { ref, cookie } = await fixtureSession(secret);
  const sql = postgres(databaseUrl, { max: 1 });
  let member;
  try {
    await awaitEvent(socket, "open", "guest fan-out upgrade");
    send("subscribe");
    await expectFrame(unavailable);
    await expectFrame(projected("snapshot", 1, null));
    await sql`insert into web_sessions (token_hash, user_id, username, member, expires_at)
      values (${ref}, '900000000000001377', 'Live fan-out fixture', true, now() + interval '10 minutes')`;
    member = new WebSocket(`${origin}${path}`.replace(/^http:/, "ws:"), {
      headers: { Origin: appOrigin, Cookie: cookie },
    });
    await awaitEvent(member, "open", "authenticated fan-out upgrade");
    const baseline = awaitEvent(member, "message", "authenticated fan-out baseline");
    member.send(command("subscribe"));
    assert.deepEqual(JSON.parse((await baseline)[0].data), projected("snapshot", 1, null));
    await sql`update web_sessions set revoked_at = clock_timestamp() where token_hash = ${ref}`;
    const memberClosed = awaitEvent(member, "close", "fan-out after session revocation");
    const revokedFrames = [];
    member.addEventListener("message", ({ data }) => revokedFrames.push(data));
    const [status, , [closure]] = await Promise.all([
      ingest(origin, 41, join("105", "10")),
      expectFrame(projected("patch", 2, 5)),
      memberClosed,
    ]);
    assert.equal(status, 204);
    assert.equal(closure.code, 1008);
    assert.deepEqual(revokedFrames, [], "fan-out must not send after session revocation");
    assert.equal(await ingest(origin, 42, join("106", "11")), 204);
    await delay(200);
    assert.deepEqual(frames, [], "a restricted-room update must be silent");
    assert.equal(await ingest(origin, 43, leave("105")), 204);
    await expectFrame(projected("patch", 3, null));

    assert.equal(await ingest(origin, 46, leave("106")), 409, "reject a behind snapshot");
    await expectFrame(unavailable);
    await source(snapshot(46, 5, new Date(Date.now() - 60_000).toISOString()));
    assert.equal(await ingest(origin, 46, leave("106")), 409, "reject a stale covering snapshot");
    await delay(5_100); // Browser recovery is throttled separately from producer ingress.
    await source(snapshot(46, 5));
    const beforeWake = await source();
    assert.equal(
      await ingest(origin, 46, leave("106")),
      204,
      "recover raw state from a covering snapshot",
    );
    assert.deepEqual(frames, [], "producer recovery must not restart the public lease");
    send("resync");
    await expectFrame(unavailable);
    await expectFrame(projected("snapshot", 4, 5));
    assert.equal(await source(), beforeWake);

    const publicRoom = snapshot(46, 5).topics.channels[0];
    const deny = [{ kind: "role", id: guild, allow: "0", deny: permissions }];
    const setRoom = (overwrites) => ({
      topic: "channels",
      op: "upsert",
      id: publicRoom.id,
      value: { ...publicRoom, overwrites },
    });
    assert.equal(await ingest(origin, 47, setRoom(deny)), 204);
    await expectFrame(projected("patch", 5, null));
    assert.equal(await ingest(origin, 48, setRoom([])), 204);
    await expectFrame(projected("patch", 6, 5));

    // The hibernation and warm controls each run with and without a restricted
    // update. Only the original deadline may withdraw an idle guest baseline.
    let cursor = 48;
    let revision = 6;
    for (const cold of [false, true]) {
      const traces = [];
      for (const restricted of [false, true]) {
        const doc = snapshot(cursor, 5, new Date(Date.now() - 9_000).toISOString());
        // Opening the next trial requires expiration of the prior public lease.
        // First trial: force a sequence gap without changing the public value.
        if (!cold && !restricted) {
          doc.seq = cursor += 2;
          await source(doc);
          assert.equal(await ingest(origin, cursor, leave("106")), 204);
          await expectFrame(unavailable);
          await delay(5_100);
          doc.observed_at = new Date(Date.now() - 9_000).toISOString();
        }
        const generation = await source(doc);
        send("resync");
        await expectFrame(unavailable);
        const baseline = await expectFrame(projected("snapshot", ++revision, 5));
        const expiresAt = Date.parse(doc.observed_at) + 30_000;
        if (cold && restricted) {
          // Stage a covering, still-fresh snapshot before idling the object.
          const recovered = snapshot(cursor + 1, 5);
          recovered.topics.voice.push(voice("106", "11"));
          assert.equal(await source(recovered), generation);
        }
        if (cold) await delay(15_000);
        if (restricted) {
          assert.equal(await ingest(origin, ++cursor, join("106", "11")), 204);
          assert.equal(
            await source(),
            generation + Number(cold),
            "restricted ingress reached the expected instance",
          );
          assert.deepEqual(
            frames,
            [],
            "restricted ingress must not withdraw or publish a baseline",
          );
        }
        if (!cold) {
          while (Date.now() + 4_000 < expiresAt) {
            await delay(4_000);
            assert.equal(await source(), generation, "warm expiry must not reconstruct the hub");
          }
        }
        const reset = await expectFrame(unavailable, 25_000);
        assert.ok(reset.at >= expiresAt, "restricted activity must not clear the baseline early");
        assert.ok(reset.at < expiresAt + 5_000, "restricted activity must not postpone expiry");
        assert.equal(await source(), generation + Number(cold));
        assert.equal(
          socket.readyState,
          WebSocket.OPEN,
          "source expiry must leave the guest connected",
        );
        assert.deepEqual(frames, [], "expiry emits exactly one control");
        traces.push([{ ...baseline.actual, seq: baseline.actual.seq - revision }, reset.actual]);
      }
      assert.deepEqual(traces[0], traces[1]);
    }
    // The last producer recovery is still fresh. It must not substitute for
    // the browser-triggered pull or revive the expired public lease by itself.
    await source(snapshot(cursor + 1, 4));
    send("resync");
    await expectFrame(unavailable);
    await expectFrame(projected("snapshot", revision + 1, null));
    console.log(
      "PASS installed Kit live counts, fan-out revocation, gap recovery, and warm/cold restricted-ingress silence",
    );
  } finally {
    socket.close();
    member?.close();
    try {
      await sql`delete from web_sessions where token_hash = ${ref}`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}
