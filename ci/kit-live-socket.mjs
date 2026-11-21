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

function upgradeRequest(url, headers) {
  return request(url, {
    ...deadline(),
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
      "Sec-WebSocket-Version": "13",
      ...headers,
    },
  });
}

// Observe the first frame on an idle socket, not a client event or TCP EOF.
function openIdle(url, headers) {
  return new Promise((resolve, reject) => {
    const req = upgradeRequest(url, headers);
    req.on("response", (response) => {
      response.resume();
      reject(new Error(`Idle WebSocket upgrade refused (${response.statusCode})`));
    });
    req.on("upgrade", (response, socket, head) => {
      const accept = createHash("sha1") // RFC 6455 handshake, not a signature.
        .update(`${req.getHeader("Sec-WebSocket-Key")}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      if (
        response.statusCode !== 101 ||
        response.headers.upgrade?.toLowerCase() !== "websocket" ||
        !response.headers.connection
          ?.toLowerCase()
          .split(/\s*,\s*/)
          .includes("upgrade") ||
        response.headersDistinct["sec-websocket-accept"]?.length !== 1 ||
        response.headers["sec-websocket-accept"] !== accept ||
        response.headers["sec-websocket-protocol"] !== undefined ||
        response.headers["sec-websocket-extensions"] !== undefined
      ) {
        socket.destroy();
        reject(new Error(`Invalid idle WebSocket upgrade (${response.statusCode})`));
        return;
      }
      const peer = { socket, first: null, at: null, error: null };
      socket.on("error", (error) => {
        peer.error = error;
      });
      if (head.length) socket.unshift(head);
      socket.on("readable", () => {
        if (peer.first === null) {
          peer.first = socket.read(4);
          if (peer.first !== null) peer.at = Date.now();
        }
      });
      resolve(peer);
    });
    req.on("error", reject);
    req.end();
  });
}

async function awaitServerClose(peer, expiry, label) {
  assert.ok(Number.isFinite(expiry));
  while (!peer.first && !peer.error && !peer.socket.destroyed && Date.now() < expiry + 4_000) {
    await delay(25);
  }
  assert.equal(
    peer.first?.length,
    4,
    `${label}: no complete Close frame before teardown or timeout`,
  );
  assert.equal(peer.first[0], 0x88, `${label}: first frame must be Close, not data`);
  assert.equal(peer.first[1], 2, `${label}: expected an unmasked Close with only a status`);
  assert.equal(peer.first.readUInt16BE(2), 1008, `${label}: expected policy close`);
  assert.ok(peer.at >= expiry && peer.at < expiry + 4_000, `${label}: close outside lease window`);
}

function refusal(url, headers) {
  return new Promise((resolve, reject) => {
    const req = upgradeRequest(url, headers);
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
  const idlePeers = [];
  const open = async (headers) => {
    const socket = new WebSocket(url.replace(/^http:/, "ws:"), { headers });
    sockets.push(socket);
    await once(socket, "open", deadline()); // Undici requires a valid HTTP 101 and accept key.
    return socket;
  };
  const subscribe = JSON.stringify({ v: 1, type: "subscribe", topics: ["voice"] });
  try {
    const guest = await open(headers);
    const frame = once(guest, "message", deadline());
    guest.send(subscribe);
    const unavailable = { v: 1, type: "unavailable", topic: "voice" };
    assert.deepEqual(JSON.parse((await frame)[0].data), unavailable);
    const duplicate = once(guest, "close", deadline());
    guest.send(subscribe);
    assert.equal((await duplicate)[0].code, 1008);

    await sql`insert into web_sessions (token_hash, user_id, username, member, expires_at)
      values (${ref}, '900000000000001377', 'Live socket fixture', true, now() + interval '10 minutes')`;
    const expiring = await open({ ...headers, Cookie: cookie });
    await sql`update web_sessions set expires_at = clock_timestamp() + interval '3 seconds' where token_hash = ${ref}`;
    const expiry = Promise.all([
      once(expiring, "message", deadline()),
      once(expiring, "close", deadline()),
    ]);
    expiring.send(subscribe);
    const [[message], [close]] = await expiry;
    assert.deepEqual(JSON.parse(message.data), unavailable);
    assert.equal(close.code, 1008);

    await sql`update web_sessions set expires_at = clock_timestamp() + interval '10 minutes' where token_hash = ${ref}`;
    const signedIn = await open({ ...headers, Cookie: cookie });
    await sql`update web_sessions set revoked_at = clock_timestamp() where token_hash = ${ref}`;
    const closed = once(signedIn, "close", deadline());
    let deliveries = 0;
    signedIn.addEventListener("message", () => deliveries++);
    signedIn.send(subscribe);
    assert.equal((await closed)[0].code, 1008);
    assert.equal(deliveries, 0);
    assert.equal(await refusal(url, { ...headers, Cookie: cookie }), 401);

    await sql`update web_sessions set revoked_at = null where token_hash = ${ref}`;
    const lapsing = await open({ ...headers, Cookie: cookie });
    await sql`update web_sessions set expires_at = clock_timestamp() where token_hash = ${ref}`;
    const expired = once(lapsing, "close", deadline());
    lapsing.addEventListener("message", () => deliveries++);
    lapsing.send(subscribe);
    assert.equal((await expired)[0].code, 1008);
    assert.equal(deliveries, 0);

    const [laterLease] =
      await sql`insert into web_sessions (token_hash, user_id, username, member, expires_at)
      values (${laterSession.ref}, '900000000000001378', 'Later live socket', true,
        clock_timestamp() + interval '10 seconds') returning expires_at`;
    const [firstLease] =
      await sql`update web_sessions set expires_at = clock_timestamp() + interval '5 seconds'
      where token_hash = ${ref} returning expires_at`;
    // Admit the later lease first. Neither client sends a frame before its alarm.
    const later = await openIdle(url, { ...headers, Cookie: laterSession.cookie });
    idlePeers.push(later);
    const first = await openIdle(url, { ...headers, Cookie: cookie });
    idlePeers.push(first);
    await awaitServerClose(first, new Date(firstLease.expires_at).getTime(), "first idle lease");
    assert.ok(
      !later.first && !later.error && !later.socket.destroyed && !later.socket.readableEnded,
      "later lease must stay open after the first alarm",
    );
    await awaitServerClose(later, new Date(laterLease.expires_at).getTime(), "later idle lease");
    console.log(
      "PASS installed Kit live socket 101, guest control, shortened and staggered idle expiry, and revocation",
    );
  } finally {
    for (const socket of sockets) socket.close();
    for (const peer of idlePeers) peer.socket.destroy();
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

function snapshot(seq, count) {
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
    observed_at: at,
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
  socket.addEventListener("message", ({ data }) => frames.push(JSON.parse(data)));
  const expectFrame = async (want, timeout = 5_000) => {
    if (!frames.length) await once(socket, "message", { signal: AbortSignal.timeout(timeout) });
    assert.deepEqual(frames.shift(), want);
  };
  const command = (type) => JSON.stringify({ v: 1, type, topics: ["voice"] });
  const send = (type) => socket.send(command(type));
  const { ref, cookie } = await fixtureSession(secret);
  const sql = postgres(databaseUrl, { max: 1 });
  let member;
  try {
    await once(socket, "open", deadline());
    send("subscribe");
    await expectFrame(projected("snapshot", 1, null));
    await sql`insert into web_sessions (token_hash, user_id, username, member, expires_at)
      values (${ref}, '900000000000001377', 'Live fan-out fixture', true, now() + interval '10 minutes')`;
    member = new WebSocket(`${origin}${path}`.replace(/^http:/, "ws:"), {
      headers: { Origin: appOrigin, Cookie: cookie },
    });
    await once(member, "open", deadline());
    const baseline = once(member, "message", deadline());
    member.send(command("subscribe"));
    assert.deepEqual(JSON.parse((await baseline)[0].data), projected("snapshot", 1, null));
    await sql`update web_sessions set revoked_at = clock_timestamp() where token_hash = ${ref}`;
    const memberClosed = once(member, "close", deadline());
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
    const beforeWake = await source(snapshot(46, 5));
    assert.equal(await ingest(origin, 46, leave("106")), 204, "recover from a covering snapshot");
    await expectFrame(projected("snapshot", 4, 5));
    assert.equal(await source(), beforeWake);

    // Workerd hibernates an idle hibernatable object after about ten seconds.
    // Do not issue any network operation during this window or reconnect the client.
    await delay(15_000);
    send("resync");
    await expectFrame(unavailable); // Constructor clears the old baseline on this socket.
    await expectFrame(unavailable); // Resync cannot use old in-memory data.
    await expectFrame(projected("snapshot", 5, 5));
    assert.equal(await source(), beforeWake + 1, "the same socket woke a new hub instance");

    const publicRoom = snapshot(46, 5).topics.channels[0];
    const deny = [{ kind: "role", id: guild, allow: "0", deny: permissions }];
    const setRoom = (overwrites) => ({
      topic: "channels",
      op: "upsert",
      id: publicRoom.id,
      value: { ...publicRoom, overwrites },
    });
    assert.equal(await ingest(origin, 47, setRoom(deny)), 204);
    await expectFrame(projected("patch", 6, null));
    assert.equal(await ingest(origin, 48, setRoom([])), 204);
    await expectFrame(projected("patch", 7, 5));

    // No caller touches the Worker while waiting: only the source alarm can clear it.
    await expectFrame(unavailable, 40_000);
    assert.equal(socket.readyState, WebSocket.OPEN, "source expiry is not connection expiry");
    console.log(
      "PASS installed Kit live counts, silence, fan-out revocation, gap recovery, hibernation, and lease expiry",
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
