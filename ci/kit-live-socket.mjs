import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { get } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { WebSocket } from "undici";
import { SESSION_COOKIE } from "./parity/fixture.mjs";

const path = "/api/discord-live/v1";
const deadline = () => ({ signal: AbortSignal.timeout(5_000) });

function upgrade(url, headers) {
  return get(url, {
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

function refusal(url, headers) {
  return new Promise((resolve, reject) => {
    const req = upgrade(url, headers);
    req.on("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    req.on("error", reject);
  });
}

// Read the first frame directly so TCP teardown cannot pass as a policy Close.
export function openIdle(url, headers) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const req = upgrade(url, headers);
    req.on("response", (response) => {
      response.resume();
      reject(new Error(`Idle WebSocket upgrade refused (${response.statusCode})`));
    });
    req.on("upgrade", (response, socket, head) => {
      const accept = createHash("sha1") // RFC 6455 handshake.
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
      const upgradeMs = Math.ceil(performance.now() - started);
      const peer = { socket, first: null, at: null, error: null, upgradeMs };
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
  });
}

export async function awaitServerClose(peer, expiry, label) {
  assert.ok(Number.isFinite(expiry));
  while (!peer.first && !peer.error && !peer.socket.destroyed && Date.now() < expiry + 4_000) {
    await delay(25);
  }
  assert.equal(peer.first?.length, 4, `${label}: no complete frame before teardown or timeout`);
  assert.equal(peer.first[0], 0x88, `${label}: first frame must be Close`);
  assert.equal(peer.first[1], 2, `${label}: expected an unmasked Close with only a status`);
  assert.equal(peer.first.readUInt16BE(2), 1008, `${label}: expected policy close`);
  // The entire upgrade bounds the conservative SQL-read debit. Allow 2 ms for rounding.
  assert.ok(
    peer.at >= expiry - peer.upgradeMs - 2 && peer.at < expiry + 4_000,
    `${label}: closed ${peer.at - expiry} ms from DB expiry (upgrade ${peer.upgradeMs} ms)`,
  );
}

export async function finishIdle(peer) {
  const mask = randomBytes(4);
  const closed = once(peer.socket, "close", deadline());
  peer.socket.write(
    Buffer.from([0x88, 0x82, ...mask, peer.first[2] ^ mask[0], peer.first[3] ^ mask[1]]),
  );
  // Let the Close reply flush without waiting for a TCP FIN from the fixture proxy.
  peer.socket.destroySoon();
  await closed;
}

async function fixtureSession(secret) {
  const token = `two_${randomBytes(32).toString("base64url")}`;
  const ref = createHash("sha256").update(token).digest("hex");
  const signed = await generateSignedCookie(SESSION_COOKIE, token, secret, { secure: true });
  return { ref, cookie: signed.split(";", 1)[0] };
}

function send(socket, message, event) {
  const received = once(socket, event, deadline());
  socket.send(message);
  return received;
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
  const resync = JSON.stringify({ v: 1, type: "resync", topics: ["voice"] });
  const unavailable = { v: 1, type: "unavailable", topic: "voice" };
  try {
    const guest = await open(headers);
    assert.deepEqual(JSON.parse((await send(guest, subscribe, "message"))[0].data), unavailable);
    await delay(2_100);
    const [resynced] = await send(guest, resync.padEnd(512), "message");
    assert.deepEqual(JSON.parse(resynced.data), unavailable);
    assert.equal((await send(guest, subscribe, "close"))[0].code, 1008);
    for (const invalid of ["{", subscribe.padEnd(513)]) {
      const socket = await open(headers);
      assert.equal((await send(socket, invalid, "close"))[0].code, 1008);
    }

    await sql`insert into web_sessions (token_hash, user_id, username, member, expires_at)
      values (${ref}, '900000000000001377', 'Live socket fixture', true, now() + interval '10 minutes')`;
    const expiring = await open({ ...headers, Cookie: cookie });
    await sql`update web_sessions set expires_at = clock_timestamp() + interval '3 seconds' where token_hash = ${ref}`;
    const closing = once(expiring, "close", deadline());
    const [[message], [close]] = await Promise.all([send(expiring, subscribe, "message"), closing]);
    assert.deepEqual(JSON.parse(message.data), unavailable);
    assert.equal(close.code, 1008);

    await sql`update web_sessions set expires_at = clock_timestamp() + interval '10 minutes' where token_hash = ${ref}`;
    const signedIn = await open({ ...headers, Cookie: cookie });
    await sql`update web_sessions set revoked_at = clock_timestamp() where token_hash = ${ref}`;
    let deliveries = 0;
    signedIn.addEventListener("message", () => deliveries++);
    assert.equal((await send(signedIn, subscribe, "close"))[0].code, 1008);
    assert.equal(deliveries, 0);
    assert.equal(await refusal(url, { ...headers, Cookie: cookie }), 401);
    console.log("PASS Kit live socket upgrade, guest resync, frame limits, expiry, and revocation");

    await sql`update web_sessions set revoked_at = null where token_hash = ${ref}`;
    const lapsing = await open({ ...headers, Cookie: cookie });
    await sql`update web_sessions set expires_at = clock_timestamp() where token_hash = ${ref}`;
    lapsing.addEventListener("message", () => deliveries++);
    assert.equal((await send(lapsing, subscribe, "close"))[0].code, 1008);
    assert.equal(deliveries, 0, "a row expired after admission receives no frame");

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
      "PASS expired session refusal and staggered idle leases with wire-level 1008 Close frames",
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
