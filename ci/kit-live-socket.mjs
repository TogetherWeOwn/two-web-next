import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { request } from "node:http";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { WebSocket } from "undici";
import { SESSION_COOKIE } from "./parity/fixture.mjs";

const path = "/api/discord-live/v1";
const deadline = () => ({ signal: AbortSignal.timeout(5_000) });

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
  const cookie = (
    await generateSignedCookie(SESSION_COOKIE, token, secret, { secure: true, path: "/" })
  ).split(";", 1)[0];
  const sockets = [];
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
    console.log("PASS Kit live socket upgrade, guest control, shortened expiry, and revocation");
  } finally {
    for (const socket of sockets) socket.close();
    try {
      await sql`delete from web_sessions where token_hash = ${ref}`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}
