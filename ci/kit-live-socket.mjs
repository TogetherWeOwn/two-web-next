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

function refusal(url, headers) {
  return new Promise((resolve, reject) => {
    const req = get(url, {
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
  });
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

  const sql = postgres(databaseUrl, { max: 1 });
  const token = `two_${randomBytes(32).toString("base64url")}`;
  const ref = createHash("sha256").update(token).digest("hex");
  const signed = await generateSignedCookie(SESSION_COOKIE, token, secret, { secure: true });
  const [cookie] = signed.split(";", 1);
  const sockets = [];
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
  } finally {
    for (const socket of sockets) socket.close();
    try {
      await sql`delete from web_sessions where token_hash = ${ref}`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}
