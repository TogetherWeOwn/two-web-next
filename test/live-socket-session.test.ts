import { serializeSigned } from "hono/utils/cookie";
import { expect, it, vi } from "vitest";
import { cacheSocketAdmissionRefusals, resolveLiveSocketSession } from "../src/live/socket-session";
import { SESSION_COOKIE } from "../src/session-cookie";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  SESSION_ABSOLUTE_MAX_AGE_SECONDS,
} from "../src/sessions";

const signingKey = "local fixture session signing key";
const signed = async (token: string, key = signingKey) =>
  (await serializeSigned(SESSION_COOKIE, token, key, { secure: true, path: "/" })).split(";")[0]!;
const denied = { kind: "refused", status: 401 };
const unavailable = { kind: "refused", status: 503 };

it("allows only absent session cookies to become guests without a session lookup", async () => {
  const getLive = vi.fn(async () => null);
  const token = newSessionToken();
  const cookie = await signed(token);
  for (const raw of ["", "theme=dark", `${SESSION_COOKIE}-other=${token}`, `theme=${cookie}`]) {
    expect(await resolveLiveSocketSession(raw, undefined, getLive)).toEqual({ kind: "guest" });
  }
  const atLimit = "theme=".padEnd(8192, "x");
  expect(await resolveLiveSocketSession(atLimit, signingKey, getLive)).toEqual({ kind: "guest" });
  for (const raw of [
    SESSION_COOKIE,
    `${SESSION_COOKIE}=`,
    `${SESSION_COOKIE}=${token}`,
    `${cookie}; ${cookie}`,
    `theme=dark, ${cookie}`,
    await signed(token, "different fixture key"),
    await signed("wrong bearer shape"),
    `${atLimit}x`,
  ]) {
    expect(await resolveLiveSocketSession(raw, signingKey, getLive)).toEqual(denied);
  }
  expect(await resolveLiveSocketSession(cookie, undefined, getLive)).toEqual(unavailable);
  expect(getLive).not.toHaveBeenCalled();
});

it("refuses malformed occurrences of the exact name before any lookup", async () => {
  const getLive = vi.fn(async () => ({ userId: "2", member: true, remainingMs: 60_000 }));
  const cookie = await signed(newSessionToken());
  const value = cookie.slice(SESSION_COOKIE.length + 1);
  for (const malformed of [
    `${SESSION_COOKIE} stray`,
    `${SESSION_COOKIE}\tstray=yes`,
    `${SESSION_COOKIE} =${value}`,
    `${SESSION_COOKIE}= ${value}`,
    `${String.fromCharCode(0xa0)}${cookie}`,
  ]) {
    for (const raw of [malformed, `${malformed}; ${cookie}`, `${cookie}; ${malformed}`]) {
      expect(await resolveLiveSocketSession(raw, signingKey, getLive)).toEqual(denied);
    }
  }
  expect(getLive).not.toHaveBeenCalled();
});

it("returns a non-bearer reference only for an exact live row, not rotation grace or revocation", async () => {
  let time = 1000;
  const now = () => time;
  const store = createMemorySessionStore(now);
  const token = newSessionToken();
  const ref = await hashToken(token);
  const cookie = await signed(token);
  const viewer = { userId: "2", username: "fixture", avatar: null, member: true, moderator: false };
  const expiresAt = new Date(time + 60_000);
  const resolve = (raw: string) =>
    resolveLiveSocketSession(raw, signingKey, store.getLive, now, now);
  expect(await resolve(cookie)).toEqual(denied);
  await store.create({ ...viewer, tokenHash: ref, expiresAt });
  expect(await resolve(`theme=dark; ${cookie}`)).toEqual({
    kind: "session",
    ref,
    validUntil: expiresAt.getTime(),
  });
  const successor = newSessionToken();
  const successorRef = await hashToken(successor);
  const successorCookie = await signed(successor);
  expect(await store.rotate(ref, { ...viewer, tokenHash: successorRef, expiresAt })).toBe(true);
  expect(await store.get(ref)).toEqual(viewer); // Ordinary request readers still get grace.
  expect(await resolve(cookie)).toEqual(denied);
  expect(await resolve(successorCookie)).toMatchObject({ kind: "session", ref: successorRef });
  time = expiresAt.getTime();
  expect(await resolve(successorCookie)).toEqual(denied);
  await store.create({ ...viewer, tokenHash: ref, expiresAt: new Date(time + 60_000) });
  await store.revoke(ref);
  expect(await resolve(cookie)).toEqual(denied);
});

it("keeps the original lineage cap across exact reads and same-hash re-creation", async () => {
  let time = 1000;
  const store = createMemorySessionStore(() => time);
  const cap = time + SESSION_ABSOLUTE_MAX_AGE_SECONDS * 1000;
  const row = {
    tokenHash: "lineage-fixture",
    userId: "2",
    username: "fixture",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(cap + 60_000),
  };
  await store.create(row);
  time = cap - 1;
  expect(await store.getLive(row.tokenHash)).toEqual({ userId: "2", member: true, remainingMs: 1 });
  time = cap;
  expect(await store.getLive(row.tokenHash)).toBeNull();
  await store.create(row);
  expect(await store.getLive(row.tokenHash)).toBeNull();
  expect(await store.sweepExpired(new Date(time))).toBe(1);
});

it("debits time in flight from store lifetime even with a skewed Worker wall clock", async () => {
  const token = newSessionToken();
  const ref = await hashToken(token);
  const cookie = await signed(token);
  const storeStart = 50_000;
  let storeTime = storeStart;
  let workerTime = 1000;
  let elapsedTime = 0;
  const store = createMemorySessionStore(() => storeTime);
  await store.create({
    tokenHash: ref,
    userId: "2",
    username: "fixture",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(storeStart + 10),
  });
  const resolveAfter = (delay: number, wallDelta: number) =>
    resolveLiveSocketSession(
      cookie,
      signingKey,
      async (hash) => {
        const live = await store.getLive(hash);
        expect(live?.remainingMs).toBe(10);
        storeTime += delay;
        workerTime += wallDelta;
        elapsedTime += delay;
        return live;
      },
      () => workerTime,
      () => elapsedTime,
    );
  expect(await resolveAfter(4, 4)).toEqual({ kind: "session", ref, validUntil: 1010 });
  storeTime = storeStart;
  expect(await resolveAfter(4, -5)).toEqual({ kind: "session", ref, validUntil: 1005 });
  storeTime = storeStart;
  expect(await resolveAfter(4, 10)).toEqual(denied);
  storeTime = storeStart;
  expect(await resolveAfter(10, -5)).toEqual(denied);
  expect(await store.getLive(ref)).toBeNull();
});

it("fails closed when the store cannot prove liveness", async () => {
  const cookie = await signed(newSessionToken());
  const invalidWallClock = vi.fn(() => 1000).mockReturnValueOnce(Infinity);
  expect(
    await resolveLiveSocketSession(
      cookie,
      signingKey,
      async () => ({ userId: "2", member: true, remainingMs: 5000 }),
      invalidWallClock,
      () => 0,
    ),
  ).toEqual(unavailable);
  expect(
    await resolveLiveSocketSession(cookie, signingKey, async () => ({
      userId: "2",
      member: true,
      remainingMs: NaN,
    })),
  ).toEqual(unavailable);
  expect(
    await resolveLiveSocketSession(cookie, signingKey, async () => {
      throw new Error("fixture store unavailable");
    }),
  ).toEqual(unavailable);
});

it.each(["expired", "revoked"])("bounds admission reads for a %s signed session", async (state) => {
  let time = 1000;
  const now = () => time;
  const store = createMemorySessionStore(now);
  const token = newSessionToken();
  const replacement = newSessionToken();
  const ref = await hashToken(token);
  const replacementRef = await hashToken(replacement);
  const cookie = await signed(token);
  const replacementCookie = await signed(replacement);
  const viewer = { userId: "2", username: "fixture", avatar: null, member: true, moderator: false };
  await store.create({ ...viewer, tokenHash: ref, expiresAt: new Date(time + 1000) });
  await store.create({ ...viewer, tokenHash: replacementRef, expiresAt: new Date(time + 120_000) });
  const lookup = vi.fn(store.getLive);
  const read = cacheSocketAdmissionRefusals(lookup, now);
  const resolve = (raw: string) => resolveLiveSocketSession(raw, signingKey, read, now, now);

  expect(await resolve(cookie)).toMatchObject({ kind: "session", ref });
  if (state === "revoked") await store.revoke(ref);
  time += state === "expired" ? 1000 : 1;
  const refusedAt = time;
  expect(await resolve(cookie)).toEqual(denied);
  for (const elapsed of [1000, 3000, 7000, 59_999]) {
    time = refusedAt + elapsed;
    expect(await resolve(`theme=dark; ${cookie}`)).toEqual(denied);
  }
  expect(lookup.mock.calls).toEqual([[ref], [ref]]);
  expect(await resolve("")).toEqual({ kind: "guest" });
  expect(await resolve(replacementCookie)).toMatchObject({ kind: "session", ref: replacementRef });
  time = refusedAt + 60_000;
  expect(await resolve(cookie)).toEqual(denied);
  expect(lookup.mock.calls).toEqual([[ref], [ref], [replacementRef], [ref]]);
});

it("retries an indeterminate or transport-expired admission read", async () => {
  let time = 1000;
  const now = () => time;
  const cookie = await signed(newSessionToken());
  const live = { userId: "2", member: true, remainingMs: 5000 };
  const lookup = vi
    .fn(async () => live)
    .mockRejectedValueOnce(new Error("fixture store unavailable"))
    .mockImplementationOnce(async () => {
      time += 5000;
      return live;
    });
  const read = cacheSocketAdmissionRefusals(lookup, now);
  const resolve = () => resolveLiveSocketSession(cookie, signingKey, read, now, now);

  expect(await resolve()).toEqual(unavailable);
  expect(await resolve()).toEqual(denied);
  expect(await resolve()).toMatchObject({ kind: "session" });
  expect(lookup).toHaveBeenCalledTimes(3);
});

it("evicts the oldest admission refusal when the cache fills", async () => {
  const lookup = vi.fn(async () => null);
  const read = cacheSocketAdmissionRefusals(lookup, () => 1000);
  for (let ref = 0; ref <= 1024; ref++) await read(String(ref));
  await read("1024");
  expect(lookup).toHaveBeenCalledTimes(1025);
  await read("0");
  expect(lookup).toHaveBeenCalledTimes(1026);
});
