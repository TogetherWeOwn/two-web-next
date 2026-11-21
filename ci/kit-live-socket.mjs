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
    assert.deepEqual(JSON.parse((await frame)[0].data), {
      v: 1,
      type: "unavailable",
      topic: "voice",
    });
    const duplicate = once(guest, "close", deadline());
    guest.send(subscribe);
    assert.equal((await duplicate)[0].code, 1008);

    await sql`insert into web_sessions (token_hash, user_id, username, member, expires_at)
      values (${ref}, '900000000000001377', 'Live socket fixture', true, now() + interval '10 minutes')`;
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
    const expiring = await open({ ...headers, Cookie: cookie });
    await sql`update web_sessions set expires_at = clock_timestamp() where token_hash = ${ref}`;
    const expired = once(expiring, "close", deadline());
    expiring.addEventListener("message", () => deliveries++);
    expiring.send(subscribe);
    assert.equal((await expired)[0].code, 1008);
    assert.equal(deliveries, 0);
    console.log(
      "PASS installed Kit live socket 101, guest control, revocation, and session expiry",
    );
  } finally {
    for (const socket of sockets) socket.close();
    try {
      await sql`delete from web_sessions where token_hash = ${ref}`;
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

export async function verifyKitLiveFanout(origin, appOrigin) {
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
  const send = (type) => socket.send(JSON.stringify({ v: 1, type, topics: ["voice"] }));
  try {
    await once(socket, "open", deadline());
    send("subscribe");
    await expectFrame(projected("snapshot", 1, null));
    assert.equal(await ingest(origin, 41, join("105", "10")), 204);
    await expectFrame(projected("patch", 2, 5));
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
      "PASS installed Kit live counts, silence, gap recovery, hibernation, and lease expiry",
    );
  } finally {
    socket.close();
  }
}
