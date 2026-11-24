import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { WebSocket } from "undici";
import { SESSION_COOKIE } from "../parity/fixture.mjs";
import frames from "./kit-live-frames.json" with { type: "json" };

const ingestPath = "/internal/discord-live/v1/ingest";
const guild = "326474832151838730";
const people = ["101", "102", "103", "104", "105", "106", "107"];
const permissions = String((1 << 10) | (1 << 20));
const deadline = (ms = 5_000) => ({ signal: AbortSignal.timeout(ms) });
const unavailable = (topic) => ({ v: 1, type: "unavailable", topic });
const projected = (type, seq, count) => ({ v: 1, type, topic: "voice", seq, value: { count } });
const voice = (userId, channelId) => ({ userId, channelId });
const join = (id, channelId) => ({ topic: "voice", op: "upsert", id, value: voice(id, channelId) });
const leave = (id) => ({ topic: "voice", op: "remove", id });

function room(id, restricted) {
  return {
    id,
    name: "Synthetic room",
    kind: "voice",
    parentId: null,
    position: null,
    overwrites: restricted ? [{ kind: "role", id: guild, allow: "0", deny: permissions }] : [],
  };
}

function snapshot(seq, count, observedAt = new Date().toISOString()) {
  return {
    v: 1,
    guild_id: guild,
    seq,
    observed_at: observedAt,
    topics: {
      guild: { ownerId: people[0], afkChannelId: null },
      channels: [room("10", false), room("11", true), room("12", false)],
      roles: [{ id: guild, permissions }],
      members: people.map((userId) => ({
        userId,
        nick: "Synthetic occupant",
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
  const body = JSON.stringify({
    v: 1,
    guild_id: guild,
    seq,
    occurred_at: new Date().toISOString(),
    ops: [op],
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomBytes(16).toString("hex");
  const digest = createHash("sha256").update(body).digest("hex");
  const signature = createHmac("sha256", "fixture-ingest-value")
    .update(`POST\n${ingestPath}\n${timestamp}\n${nonce}\n${digest}`)
    .digest("hex");
  const response = await fetch(origin + ingestPath, {
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

function connect(url, headers) {
  const socket = new WebSocket(url, { headers });
  const frames = [];
  socket.addEventListener("message", ({ data }) => frames.push({ data, at: Date.now() }));
  return {
    socket,
    frames,
    ready: once(socket, "open", deadline()),
    async frame(want, timeout = 5_000) {
      const label = `${want.topic} ${want.type}${want.seq === undefined ? "" : ` ${want.seq}`}`;
      if (!frames.length) {
        await once(socket, "message", deadline(timeout)).catch((cause) => {
          throw new Error(`Waiting for ${label} (readyState=${socket.readyState})`, { cause });
        });
      }
      const { data, at } = frames.shift();
      assert.equal(typeof data, "string", `${label} must be a text frame`);
      assert.ok(Buffer.byteLength(data) <= 128, "public frames are bounded");
      assert.deepEqual(JSON.parse(data), want, label);
      return at;
    },
    subscribe(topics) {
      socket.send(JSON.stringify({ v: 1, type: "subscribe", topics }));
    },
    resyncVoice() {
      socket.send(JSON.stringify({ v: 1, type: "resync", topics: ["voice"] }));
    },
  };
}

export async function verifyPublicFanout(origin, appOrigin, databaseUrl, secret) {
  const url = `${origin.replace(/^http:/, "ws:")}/api/discord-live/v1`;
  const headers = { Origin: appOrigin };
  const source = async (doc) => {
    const response = await fetch(`${origin}/__fixture/live-source`, {
      ...deadline(),
      ...(doc ? { method: "POST", body: JSON.stringify(doc) } : {}),
    });
    assert.equal(response.status, 200);
    return (await response.json()).generation;
  };
  await source(snapshot(40, 4));
  assert.equal(await ingest(origin, 40, leave("105")), 204, "cold signed snapshot");

  const token = `two_${randomBytes(32).toString("base64url")}`;
  const ref = createHash("sha256").update(token).digest("hex");
  const signed = await generateSignedCookie(SESSION_COOKIE, token, secret, { secure: true });
  const sql = postgres(databaseUrl, { max: 1 });
  const guest = connect(url, headers);
  let member;
  try {
    await guest.ready;
    guest.subscribe(["voice", "channels", "members", "events"]);
    await guest.frame(frames.initial);
    for (const topic of ["channels", "members", "events"]) await guest.frame(unavailable(topic));

    await sql`insert into web_sessions (token_hash, user_id, username, member, expires_at)
      values (${ref}, '900000000000001377', 'Synthetic fan-out member', true, now() + interval '10 minutes')`;
    member = connect(url, { ...headers, Cookie: signed.split(";", 1)[0] });
    await member.ready;
    member.subscribe(["voice"]);
    await member.frame(frames.initial);
    await sql`update web_sessions set revoked_at = clock_timestamp() where token_hash = ${ref}`;
    const [status, , [closed]] = await Promise.all([
      ingest(origin, 41, join("105", "10")),
      guest.frame(frames.five),
      once(member.socket, "close", deadline()),
    ]);
    assert.equal(status, 204);
    assert.equal(closed.code, 1008);
    assert.deepEqual(member.frames, [], "revoked exact row receives no fan-out");

    assert.equal(await ingest(origin, 42, join("106", "11")), 204);
    assert.equal(await ingest(origin, 43, join("107", "12")), 204);
    assert.equal(await ingest(origin, 44, leave("105")), 204);
    // No extra revision from either the restricted allowlisted room or the unlisted room.
    await guest.frame(frames.suppressed);

    assert.equal(await ingest(origin, 46, leave("106")), 409, "reject a behind snapshot");
    await guest.frame(frames.withdrawal);
    await source(snapshot(46, 5, new Date(Date.now() - 60_000).toISOString()));
    assert.equal(await ingest(origin, 46, leave("106")), 409, "reject a stale covering snapshot");
    const covering = snapshot(46, 5);
    const generation = await source(covering);
    assert.equal(await ingest(origin, 46, leave("106")), 204, "recover with a fresh observation");
    await guest.frame(frames.covering);
    const roomPolicy = (restricted) => ({
      topic: "channels",
      op: "upsert",
      id: "10",
      value: room("10", restricted),
    });
    assert.equal(await ingest(origin, 47, roomPolicy(true)), 204);
    await guest.frame(projected("patch", 5, null));
    assert.equal(await ingest(origin, 48, roomPolicy(false)), 204);
    await guest.frame(projected("patch", 6, 5));

    const sourceUntil = Date.parse(covering.observed_at) + 30_000;
    // Keep the same instance warm and send a restricted delta late in the lease.
    const keepWarm = async () => {
      for (let i = 0; i < 7; i++) {
        await delay(4_000);
        assert.equal(await source(), generation);
        if (i === 3) {
          assert.ok(Date.now() < sourceUntil, "restricted ingress must precede source expiry");
          assert.equal(await ingest(origin, 49, join("106", "11")), 204);
        }
      }
    };
    const [withdrawnAt] = await Promise.all([guest.frame(frames.withdrawal, 35_000), keepWarm()]);
    assert.ok(withdrawnAt >= sourceUntil, "the source alarm must not clear the baseline early");
    assert.ok(withdrawnAt < sourceUntil + 4_000, "restricted ingress must not renew the lease");
    assert.equal(await source(), generation, "lease alarm ran without a hibernation wake");
    assert.equal(
      guest.socket.readyState,
      WebSocket.OPEN,
      "source expiry keeps the guest socket open",
    );
    assert.equal(await source(snapshot(49, 5)), generation);
    const warmResyncAt = performance.now();
    guest.resyncVoice();
    await guest.frame(frames.withdrawal);
    await guest.frame(frames.warm);
    assert.equal(await source(), generation, "the socket resynced on the same hub without ingress");
    console.log(
      "PASS installed Kit public scope, wire shape, exact-row fan-out revocation, gap recovery, lease expiry, and socket resync",
    );

    // Change the fixture response to the next signed pull. The warm hub still has five.
    assert.equal(await source(snapshot(50, 6)), generation);
    // Workerd can hibernate after about 10 seconds idle. Leave all callers quiet
    // until the same guest sends resync, before the renewed 30-second source alarm.
    await delay(15_000);
    assert.equal(guest.socket.readyState, WebSocket.OPEN);
    assert.deepEqual(guest.frames, [], "the warm baseline stayed quiet before resync");
    guest.resyncVoice();
    await guest.frame(frames.withdrawal); // Reconstructed hub clears the previous baseline.
    await guest.frame(frames.withdrawal); // The resync starts without an in-memory snapshot.
    await guest.frame(frames.cold);
    assert.ok(performance.now() - warmResyncAt < 25_000, "the source alarm was not due yet");
    assert.equal(await source(), generation + 1, "resync woke a new hub on the original socket");
    console.log("PASS installed Kit same-socket hibernation wake and snapshot recovery");
  } finally {
    guest.socket.close();
    member?.socket.close();
    try {
      await sql`delete from web_sessions where token_hash = ${ref}`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}
