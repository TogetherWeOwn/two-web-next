import { serializeSigned } from "hono/utils/cookie";
import { expect, it, vi } from "vitest";
import { resolveLiveSocketSession } from "../src/live/socket-session";
import { SESSION_COOKIE } from "../src/session-cookie";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const signingKey = "local fixture session signing key";
const signed = async (token: string, key = signingKey) =>
  (await serializeSigned(SESSION_COOKIE, token, key, { secure: true, path: "/" })).split(";")[0]!;
const denied = { kind: "refused", status: 401 };
const unavailable = { kind: "refused", status: 503 };

it("allows only absent session cookies to become guests without a session lookup", async () => {
  const getLive = vi.fn(async () => null);
  const token = newSessionToken();
  const cookie = await signed(token);
  for (const raw of ["", "theme=dark"]) {
    expect(await resolveLiveSocketSession(raw, undefined, getLive)).toEqual({ kind: "guest" });
  }
  for (const raw of [
    SESSION_COOKIE,
    `${SESSION_COOKIE}=`,
    `${SESSION_COOKIE}=${token}`,
    `${cookie}; ${cookie}`,
    `theme=dark, ${cookie}`,
    await signed(token, "different fixture key"),
    await signed("wrong bearer shape"),
    `theme=${"x".repeat(8192)}`,
  ]) {
    expect(await resolveLiveSocketSession(raw, signingKey, getLive)).toEqual(denied);
  }
  expect(await resolveLiveSocketSession(cookie, undefined, getLive)).toEqual(unavailable);
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
  const resolve = (raw: string) => resolveLiveSocketSession(raw, signingKey, store.getLive, now);
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

it("fails closed when the store cannot prove liveness or expiry crosses during lookup", async () => {
  const cookie = await signed(newSessionToken());
  const read = async (validUntil: number) => ({ userId: "2", member: true, validUntil });
  expect(
    await resolveLiveSocketSession(
      cookie,
      signingKey,
      () => read(10),
      () => 10,
    ),
  ).toEqual(denied);
  expect(
    await resolveLiveSocketSession(
      cookie,
      signingKey,
      () => read(NaN),
      () => 10,
    ),
  ).toEqual(unavailable);
  expect(
    await resolveLiveSocketSession(cookie, signingKey, async () => {
      throw new Error("fixture store unavailable");
    }),
  ).toEqual(unavailable);
});
