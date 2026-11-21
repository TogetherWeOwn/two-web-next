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
  const started = performance.now();
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
      const upgradeMs = Math.ceil(performance.now() - started); // Bounds the full SQL debit.
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
  assert.ok(
    peer.at >= expiry - peer.upgradeMs - 2 && peer.at < expiry + 4_000, // 2 ms for rounding.
    `${label}: closed ${peer.at - expiry} ms from DB expiry (upgrade ${peer.upgradeMs} ms)`,
  );
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
    await awaitEvent(socket, "open", "session scenario upgrade"); // Undici verifies the 101.
    return socket;
  };
  const subscribe = JSON.stringify({ v: 1, type: "subscribe", topics: ["voice"] });
  try {
    const guest = await open(headers);
    const frame = awaitEvent(guest, "message", "guest subscribe");
    guest.send(subscribe);
    const unavailable = { v: 1, type: "unavailable", topic: "voice" };
    assert.deepEqual(JSON.parse((await frame)[0].data), unavailable);
    const duplicate = awaitEvent(guest, "close", "duplicate subscribe");
    guest.send(subscribe);
    assert.equal((await duplicate)[0].code, 1008);

    await sql`insert into web_sessions (token_hash, user_id, username, member, expires_at)
      values (${ref}, '900000000000001377', 'Live socket fixture', true, now() + interval '10 minutes')`;
    const expiring = await open({ ...headers, Cookie: cookie });
    await sql`update web_sessions set expires_at = clock_timestamp() + interval '3 seconds' where token_hash = ${ref}`;
    const expiry = Promise.all([
      awaitEvent(expiring, "message", "shortened session subscribe"),
      awaitEvent(expiring, "close", "shortened session alarm"),
    ]);
    expiring.send(subscribe);
    const [[message], [close]] = await expiry;
    assert.deepEqual(JSON.parse(message.data), unavailable);
    assert.equal(close.code, 1008);

    await sql`update web_sessions set expires_at = clock_timestamp() + interval '10 minutes' where token_hash = ${ref}`;
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
    const lapsing = await open({ ...headers, Cookie: cookie });
    await sql`update web_sessions set expires_at = clock_timestamp() where token_hash = ${ref}`;
    const expired = awaitEvent(lapsing, "close", "expired session subscribe");
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
  const controlRequest = async (options, url = control) => {
    const response = await fetch(url, { ...deadline(), ...options });
    assert.equal(response.status, 200);
    return response.json();
  };
  const source = async (doc, hold = false) =>
    (
      await controlRequest(
        doc ? { method: "POST", body: JSON.stringify(doc) } : {},
        hold ? `${control}?hold` : control,
      )
    ).generation;
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
  let idleMember;
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
        const age = cold ? 5_000 : 9_000;
        const doc = snapshot(cursor, 5, new Date(Date.now() - age).toISOString());
        // Start with a warm gap whose covering snapshot cannot return until
        // the guest has observed the old baseline being withdrawn.
        if (!cold && !restricted) {
          doc.seq = cursor += 2;
          const generation = await source(doc, true);
          let finished = false;
          const ingress = ingest(origin, cursor, leave("106")).finally(() => {
            finished = true;
          });
          const [status] = await Promise.all([
            ingress,
            (async () => {
              try {
                await expectFrame(unavailable, 2_000);
                assert.equal(finished, false, "withdrawal must beat the held recovery response");
              } finally {
                await controlRequest({ method: "DELETE" });
              }
            })(),
          ]);
          assert.equal(status, 204, "the released covering snapshot restores raw state");
          assert.equal(await source(), generation, "gap recovery stays on the warm hub");
          assert.deepEqual(frames, [], "gap recovery does not publish another baseline");
          await delay(5_100);
          doc.observed_at = new Date(Date.now() - age).toISOString();
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
        let sessionExpiry;
        if (cold && !restricted) {
          const [lease] = await sql`update web_sessions set revoked_at = null,
            expires_at = clock_timestamp() + interval '16 seconds'
            where token_hash = ${ref} returning expires_at`;
          sessionExpiry = new Date(lease.expires_at).getTime();
          assert.ok(sessionExpiry + 5_000 < expiresAt, "session deadline precedes voice deadline");
          idleMember = await openIdle(`${origin}${path}`, { Origin: appOrigin, Cookie: cookie });
          await awaitServerClose(idleMember, sessionExpiry, "cold session alarm");
          assert.equal(socket.readyState, WebSocket.OPEN);
          assert.deepEqual(frames, [], "earlier cold alarm must preserve the guest baseline");
        }
        if (cold && restricted) await delay(15_000);
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
        const after = await controlRequest();
        assert.equal(after.generation, generation + Number(cold));
        if (sessionExpiry !== undefined) {
          const [early, voiceAlarm] = after.alarms;
          assert.equal(early.generation, generation + 1, "session alarm reconstructs the hub");
          assert.ok(early.at >= sessionExpiry - idleMember.upgradeMs - 2);
          assert.ok(early.at <= idleMember.at && early.at < expiresAt);
          assert.ok(voiceAlarm.at >= expiresAt, "cold alarm re-arms the original voice deadline");
          // The wire peer doesn't auto-reply like Undici. Finish its close
          // handshake before the remaining trials measure idle reconstruction.
          const mask = randomBytes(4);
          const close = once(idleMember.socket, "close", deadline());
          idleMember.socket.end(
            Buffer.from([
              0x88,
              0x82,
              ...mask,
              idleMember.first[2] ^ mask[0],
              idleMember.first[3] ^ mask[1],
            ]),
          );
          await close;
        }
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
    await source(snapshot(++cursor, 4, new Date(Date.now() - 23_000).toISOString()));
    send("resync");
    await expectFrame(unavailable);
    await expectFrame(projected("snapshot", ++revision, null));
    await expectFrame(unavailable, 12_000);

    // End each trial at its lease deadline so a leftover alarm cannot wake
    // the hub before the next trial's command or ingress.
    for (const mode of ["warm", "cold", "producer wake"]) {
      await delay(5_100);
      const initial = snapshot(++cursor, 5);
      const generation = await source(initial);
      send("resync");
      await expectFrame(unavailable);
      await expectFrame(projected("snapshot", ++revision, 5));
      // Give idle eviction headroom while keeping the resync strictly before
      // the initial 30-second lease expires.
      const idle = mode === "warm" ? 5_100 : 20_000;
      const next = snapshot(cursor + 2, 6, new Date(Date.now() + idle - 23_000).toISOString());
      if (mode === "producer wake") {
        const recovered = snapshot(cursor + 1, 5);
        recovered.topics.voice.push(voice("106", "11"));
        await source(recovered);
      } else {
        await source(next);
      }
      await delay(idle);
      if (mode === "producer wake") {
        assert.equal(await ingest(origin, cursor + 1, join("106", "11")), 204);
        const afterIngress = await controlRequest({ method: "POST", body: JSON.stringify(next) });
        assert.equal(
          afterIngress.generation,
          generation + 1,
          `producer ingress must reconstruct the hub (first event: ${afterIngress.firstEvent})`,
        );
        assert.equal(afterIngress.firstEvent, "ingress", "the probe did not wake the hub");
      }
      assert.deepEqual(frames, [], `${mode}: no frame before resync`);
      send("resync");
      const result = await expectFrame(projected("snapshot", ++revision, 6));
      assert.ok(result.at < Date.parse(initial.observed_at) + 30_000, `${mode}: pre-expiry`);
      const afterResync = await controlRequest();
      assert.equal(afterResync.generation, generation + Number(mode !== "warm"), mode);
      if (mode === "cold") assert.equal(afterResync.firstEvent, "message", "resync wakes the hub");
      assert.deepEqual(frames, [], `${mode}: exactly one snapshot`);
      await expectFrame(unavailable, 12_000);
      cursor += 2;
    }
    console.log("PASS installed Kit warm-gap withdrawal and cold alarm re-arm");
    console.log("PASS installed Kit pre-expiry resync on the warm and hibernating socket");
    console.log(
      "PASS installed Kit live counts, fan-out revocation, gap recovery, and warm/cold restricted-ingress silence",
    );
  } finally {
    socket.close();
    member?.close();
    idleMember?.socket.destroy();
    try {
      await sql`delete from web_sessions where token_hash = ${ref}`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}
