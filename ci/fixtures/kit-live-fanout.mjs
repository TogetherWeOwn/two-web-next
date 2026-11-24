import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { WebSocket } from "undici";
import { awaitServerClose, finishIdle, openIdle } from "../kit-live-socket.mjs";
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
  const socketUrl = `${origin}/api/discord-live/v1`;
  const url = socketUrl.replace(/^http:/, "ws:");
  const headers = { Origin: appOrigin };
  const control = async (options, query = "") => {
    const response = await fetch(`${origin}/__fixture/live-source${query}`, {
      ...deadline(),
      ...options,
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const source = async (doc, hold = false) =>
    (await control(doc ? { method: "POST", body: JSON.stringify(doc) } : {}, hold ? "?hold" : ""))
      .generation;
  await source(snapshot(40, 4));
  assert.equal(await ingest(origin, 40, leave("105")), 204, "cold signed snapshot");

  const token = `two_${randomBytes(32).toString("base64url")}`;
  const ref = createHash("sha256").update(token).digest("hex");
  const signed = await generateSignedCookie(SESSION_COOKIE, token, secret, { secure: true });
  const memberHeaders = { ...headers, Cookie: signed.split(";", 1)[0] };
  const sql = postgres(databaseUrl, { max: 1 });
  const guest = connect(url, headers);
  let member;
  let observer;
  let idleMember;
  try {
    await guest.ready;
    guest.subscribe(["voice", "channels", "members", "events"]);
    await guest.frame(frames.withdrawal);
    for (const topic of ["channels", "members", "events"]) await guest.frame(unavailable(topic));
    await guest.frame(frames.initial);

    await sql`insert into web_sessions (token_hash, user_id, username, member, expires_at)
      values (${ref}, '900000000000001377', 'Synthetic fan-out member', true, now() + interval '10 minutes')`;
    member = connect(url, memberHeaders);
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

    await source(snapshot(40, 4), true);
    let recovered = false;
    const heldIngress = ingest(origin, 46, leave("106")).finally(() => {
      recovered = true;
    });
    const [gapStatus] = await Promise.all([
      heldIngress,
      (async () => {
        try {
          await guest.frame(frames.withdrawal, 2_000);
          assert.equal(recovered, false, "withdrawal must beat the held recovery response");
        } finally {
          await control({ method: "DELETE" });
        }
      })(),
    ]);
    assert.equal(gapStatus, 409, "reject a behind snapshot");
    await source(snapshot(46, 5, new Date(Date.now() - 60_000).toISOString()));
    assert.equal(await ingest(origin, 46, leave("106")), 409, "reject a stale covering snapshot");
    const generation = await source(snapshot(46, 5));
    assert.equal(await ingest(origin, 46, leave("106")), 204, "recover with a fresh observation");
    await delay(5_100); // Leave time for the independent browser pull throttle.
    assert.deepEqual(guest.frames, [], "raw recovery must not publish a baseline");
    await source(snapshot(45, 5));
    guest.resyncVoice();
    await guest.frame(frames.withdrawal);
    await delay(5_100);
    assert.deepEqual(guest.frames, [], "a fresh raw state cannot replace a covering browser pull");
    const covering = snapshot(46, 5);
    assert.equal(await source(covering), generation);
    guest.resyncVoice();
    await guest.frame(frames.withdrawal);
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
    observer = connect(url, headers);
    await observer.ready;
    observer.subscribe(["voice"]);
    await observer.frame(projected("snapshot", 1, 5));
    const renewal = snapshot(48, 5, new Date(Date.now() + 5_000).toISOString());
    const renewedUntil = Date.parse(renewal.observed_at) + 30_000;
    // Keep the instance warm while resync renews only the requesting socket.
    const keepWarm = async () => {
      for (let i = 0; i < 8; i++) {
        await delay(4_000);
        assert.equal(await source(), generation);
        if (i === 1) {
          await source(renewal);
          guest.resyncVoice();
          const at = await guest.frame(projected("snapshot", 6, 5));
          assert.ok(at < sourceUntil, "warm resync uses the same active socket and revision");
        }
        if (i === 3) {
          assert.ok(Date.now() < sourceUntil, "restricted ingress must precede source expiry");
          assert.equal(await ingest(origin, 49, join("106", "11")), 204);
        }
      }
    };
    // Register withdrawal after the same-revision reply has been consumed.
    const [withdrawnAt] = await Promise.all([
      observer.frame(frames.withdrawal, 35_000),
      keepWarm(),
    ]);
    assert.ok(withdrawnAt >= sourceUntil, "the source alarm must not clear the baseline early");
    assert.ok(
      withdrawnAt < sourceUntil + 4_000,
      "another socket's resync must not renew the lease",
    );
    const renewedAt = await guest.frame(frames.withdrawal);
    assert.ok(renewedAt >= renewedUntil && renewedAt < renewedUntil + 4_000);
    assert.equal(await source(), generation, "lease alarm ran without a hibernation wake");
    assert.equal(
      guest.socket.readyState,
      WebSocket.OPEN,
      "source expiry keeps the guest socket open",
    );
    const renewed = snapshot(49, 5);
    assert.equal(await source(renewed), generation);
    const firstCommandAt = Date.now();
    guest.resyncVoice();
    await guest.frame(frames.withdrawal);
    await guest.frame(frames.warm);
    assert.equal(await source(), generation, "the socket resynced on the same hub without ingress");
    observer.resyncVoice();
    await observer.frame(frames.withdrawal);
    const secondReply = await observer.frame(projected("snapshot", 2, 5), 8_000);
    assert.ok(
      secondReply >= firstCommandAt + 5_000,
      "the second resync waited for the guild budget",
    );
    console.log(
      "PASS installed Kit public scope, wire shape, exact-row fan-out revocation, gap recovery, lease expiry, and socket resync",
    );

    const coldUntil = Date.parse(renewed.observed_at) + 30_000;
    const restricted = snapshot(50, 5);
    restricted.topics.voice.push(voice("106", "11"));
    assert.equal(await source(restricted), generation);
    // Workerd can hibernate after about 10 seconds idle. Leave all callers quiet
    // before waking the hub with producer ingress alone.
    await delay(15_000);
    assert.equal(guest.socket.readyState, WebSocket.OPEN);
    assert.ok(Date.now() < coldUntil, "restricted ingress must precede cold expiry");
    assert.equal(await ingest(origin, 50, join("106", "11")), 204);
    const woken = generation + 1;
    const cold = await control();
    assert.equal(cold.generation, woken, "restricted ingress woke a new hub instance");
    assert.equal(cold.firstEvent, "ingress", "the fixture probe did not wake the hub");
    assert.deepEqual(guest.frames, [], "cold restricted ingress preserves the quiet baseline");
    const coldWithdrawnAt = await guest.frame(frames.withdrawal, 20_000);
    assert.ok(coldWithdrawnAt >= coldUntil, "cold ingress must not withdraw early");
    assert.ok(coldWithdrawnAt < coldUntil + 4_000, "cold ingress must not postpone expiry");
    const coldObserverAt = await observer.frame(frames.withdrawal);
    assert.ok(coldObserverAt >= coldUntil && coldObserverAt < coldUntil + 4_000);
    observer.socket.close();
    assert.equal(guest.socket.readyState, WebSocket.OPEN, "cold expiry keeps the guest connected");

    const recovery = snapshot(51, 6);
    const recoveryGeneration = await source(recovery);
    assert.deepEqual(guest.frames, [], "cold expiry sends one withdrawal");
    guest.resyncVoice();
    await guest.frame(frames.withdrawal);
    await guest.frame(frames.cold);
    assert.equal(await source(), recoveryGeneration, "independent proof restores the same socket");
    console.log(
      "PASS installed Kit warm and hibernated restricted ingress preserves public expiry",
    );

    const guestExpiry = Date.parse(recovery.observed_at) + 30_000;
    const [lease] = await sql`update web_sessions set revoked_at = null,
      expires_at = clock_timestamp() + interval '16 seconds'
      where token_hash = ${ref} returning expires_at`;
    const sessionExpiry = new Date(lease.expires_at).getTime();
    assert.ok(
      sessionExpiry + 5_000 < guestExpiry,
      "session deadline precedes guest voice deadline",
    );
    idleMember = await openIdle(socketUrl, memberHeaders);
    await awaitServerClose(idleMember, sessionExpiry, "cold session alarm");
    assert.equal(guest.socket.readyState, WebSocket.OPEN);
    assert.deepEqual(guest.frames, [], "the first alarm leaves the guest baseline intact");
    const early = await control();
    assert.equal(early.generation, recoveryGeneration + 1);
    assert.equal(early.firstEvent, "alarm");
    const rearmedAt = await guest.frame(frames.withdrawal, 20_000);
    assert.ok(rearmedAt >= guestExpiry && rearmedAt < guestExpiry + 4_000);
    const { alarms } = await control();
    assert.ok(alarms[0].at <= idleMember.at && alarms[0].at < guestExpiry);
    assert.ok(alarms[1].at >= guestExpiry && alarms[1].at <= rearmedAt);
    await finishIdle(idleMember);
    console.log("PASS installed Kit cold policy alarm re-arms the original guest voice deadline");

    let cursor = 51;
    let revision = 8;
    for (const producerWake of [false, true]) {
      await delay(5_100);
      const initial = snapshot(++cursor, 5);
      const generation = await source(initial);
      guest.resyncVoice();
      await guest.frame(frames.withdrawal);
      await guest.frame(projected("snapshot", ++revision, 5));
      const idle = 20_000;
      const replacement = snapshot(
        cursor + 2,
        6,
        new Date(Date.now() + idle - 23_000).toISOString(),
      );
      const restricted = snapshot(cursor + 1, 5);
      restricted.topics.voice.push(voice("106", "11"));
      await source(producerWake ? restricted : replacement);
      await delay(idle);
      if (producerWake) {
        assert.equal(await ingest(origin, cursor + 1, join("106", "11")), 204);
        assert.deepEqual(guest.frames, [], "producer wake leaves the live baseline alone");
        await source(snapshot(cursor, 5));
        guest.resyncVoice();
        await guest.frame(frames.withdrawal);
        await delay(5_100);
        await source(replacement);
      }
      assert.deepEqual(guest.frames, [], "the baseline stays quiet before explicit resync");
      guest.resyncVoice();
      if (producerWake) await guest.frame(frames.withdrawal);
      const at = await guest.frame(projected("snapshot", ++revision, 6));
      const originalUntil = Date.parse(initial.observed_at) + 30_000;
      assert.ok(at < originalUntil, "resync beats the original alarm");
      const after = await control();
      assert.equal(after.generation, generation + 1, `woke via ${after.firstEvent}`);
      assert.equal(after.firstEvent, producerWake ? "ingress" : "message");
      assert.deepEqual(guest.frames, [], "one replacement snapshot");
      const withdrawnAt = await guest.frame(frames.withdrawal, 12_000);
      const replacementUntil = Date.parse(replacement.observed_at) + 30_000;
      assert.ok(
        withdrawnAt >= replacementUntil && withdrawnAt < originalUntil,
        "withdrawal follows the earlier replacement deadline",
      );
      cursor += 2;
    }
    console.log(
      "PASS installed Kit pre-expiry resync with warm, socket-woken and producer-woken hubs",
    );
  } finally {
    guest.socket.close();
    member?.socket.close();
    observer?.socket.close();
    idleMember?.socket.destroy();
    try {
      await sql`delete from web_sessions where token_hash = ${ref}`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}
