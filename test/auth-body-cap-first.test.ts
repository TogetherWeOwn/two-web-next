// Acceptance: POST /logout and POST /auth/qa/:identity enforce the `action`
// body-size cap BEFORE the throttle. An oversized body is therefore a 413 even
// when the caller presents a live session or has already spent the throttle
// budget — and it spends zero throttle budget. Bodies at or under the cap keep
// the current order untouched: throttle first (429 when spent), then the
// session/revocation or QA issuance work. The QA identity/token gate still runs
// first of all: unauthenticated probes 404 (byte-identical to under-cap
// probes) without reaching the cap or the throttle.
// Hermetic: in-memory session store and a counting throttle Sql double; no
// DATABASE_URL, no sockets.
import { describe, expect, it, vi } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import app from "./app";
import { withThrottleTx } from "./helpers/throttle-tx-double";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import { QA_HEADER, STAGING_APP_URL } from "../src/qa";
import {
  AUTH_THROTTLE_PER_MINUTE,
  WRITE_THROTTLE_PER_MINUTE,
  type EnvWithThrottle,
} from "../src/throttle";
import { createMemorySessionStore, newSessionToken, type Sql } from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const QA_TOKEN = "test-only-auth-cap-first-token";
// One Ray ID gives every compared response the same echoed x-request-id, so
// the full header comparison still proves byte-identical refusals (same
// pattern as test/qa-identity-admission.test.ts).
const RAY = "0123456789abcdef-LHR";
const MAX = BODY_LIMIT_BYTES.action;
const ERROR = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};

function throttleFixture(initial: number) {
  let hits = initial;
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("SELECT count(*)")) return [{ n: hits, wait: 30 }];
    if (query.includes("INSERT INTO web_throttle_hits")) hits++;
    return [];
  });
  const store = vi.fn(async () => withThrottleTx(sql as unknown as Sql));
  return { sql, store, count: () => hits };
}

function envFor(
  sessions: ReturnType<typeof createMemorySessionStore>,
  throttle: ReturnType<typeof throttleFixture>,
) {
  return {
    APP_URL: STAGING_APP_URL,
    SESSION_SECRET,
    QA_AUTH_TOKEN: QA_TOKEN,
    SESSION_STORE: sessions,
    THROTTLE_STORE: throttle.store,
  } as unknown as EnvWithThrottle;
}

function upload(
  path: string,
  max: number,
  cookie: string,
  advertised: boolean,
  extraHeaders: Record<string, string> = {},
) {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
    controller.enqueue(new Uint8Array(1024)),
  );
  const request = new Request(new URL(path, STAGING_APP_URL), {
    method: "POST",
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: "half",
    headers: {
      origin: STAGING_APP_URL,
      accept: "application/json",
      "content-type": "application/json",
      "cf-ray": RAY,
      cookie,
      ...extraHeaders,
      ...(advertised ? { "content-length": String(max + 1) } : {}),
    },
  } as RequestInit);
  return { request, pull };
}

function smallRequest(path: string, cookie: string, extraHeaders: Record<string, string> = {}) {
  return new Request(new URL(path, STAGING_APP_URL), {
    method: "POST",
    body: "{}",
    headers: {
      origin: STAGING_APP_URL,
      accept: "application/json",
      "content-type": "application/json",
      "cf-ray": RAY,
      cookie,
      ...extraHeaders,
    },
  });
}

async function sessionCookie(sessions: ReturnType<typeof createMemorySessionStore>) {
  const token = newSessionToken();
  const { hashToken } = await import("../src/sessions");
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: "111111111111111111",
    username: "member",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
    })
  ).split(";")[0]!;
}

const qaHeaders = { [QA_HEADER]: QA_TOKEN };

describe("body-size cap precedes the throttle on POST /logout", () => {
  it.each([true, false])(
    "advertised=%s oversized is 413 with zero throttle spend and zero session work",
    async (advertised) => {
      for (const presenter of ["guest", "session"] as const) {
        const sessions = createMemorySessionStore();
        const cookie = presenter === "session" ? await sessionCookie(sessions) : "";
        const revoke = vi.spyOn(sessions, "revoke");
        const get = vi.spyOn(sessions, "get");
        const throttle = throttleFixture(0);
        const { request, pull } = upload("/logout", MAX, cookie, advertised);
        const response = await app.request(request, undefined, envFor(sessions, throttle));
        expect(response.status, `${presenter}`).toBe(413);
        expect(await response.json(), `${presenter}`).toEqual(ERROR);
        expect(throttle.store, `${presenter}`).not.toHaveBeenCalled();
        expect(throttle.sql, `${presenter}`).not.toHaveBeenCalled();
        expect(throttle.count(), `${presenter}`).toBe(0);
        // A live session is not revoked by a refusal: the cap decides first.
        expect(revoke, `${presenter}`).not.toHaveBeenCalled();
        expect(get, `${presenter}`).not.toHaveBeenCalled();
        if (advertised) expect(pull, `${presenter}`).not.toHaveBeenCalled();
        await request.body?.cancel().catch(() => {});
      }
    },
  );

  it.each([true, false])(
    "advertised=%s oversized beats a spent budget (413, not 429) and spends nothing",
    async (advertised) => {
      const sessions = createMemorySessionStore();
      const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
      const { request } = upload("/logout", MAX, "", advertised);
      const response = await app.request(request, undefined, envFor(sessions, throttle));
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(ERROR);
      expect(throttle.store).not.toHaveBeenCalled();
      expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
      await request.body?.cancel().catch(() => {});
    },
  );

  it("under-cap guest clears and 303s with exactly one throttle hit", async () => {
    const sessions = createMemorySessionStore();
    const revoke = vi.spyOn(sessions, "revoke");
    const throttle = throttleFixture(0);
    const response = await app.request(
      smallRequest("/logout", ""),
      undefined,
      envFor(sessions, throttle),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    expect(throttle.count()).toBe(1);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("under-cap session revokes with exactly one throttle hit", async () => {
    const sessions = createMemorySessionStore();
    const cookie = await sessionCookie(sessions);
    const revoke = vi.spyOn(sessions, "revoke");
    const throttle = throttleFixture(0);
    const response = await app.request(
      smallRequest("/logout", cookie),
      undefined,
      envFor(sessions, throttle),
    );
    expect(response.status).toBe(303);
    expect(throttle.count()).toBe(1);
    expect(revoke).toHaveBeenCalledOnce();
  });

  it("control: under-cap revocation failure is still the 503, with one throttle hit", async () => {
    const sessions = createMemorySessionStore();
    const cookie = await sessionCookie(sessions);
    vi.spyOn(sessions, "revoke").mockRejectedValue(new Error("store down"));
    const throttle = throttleFixture(0);
    const response = await app.request(
      smallRequest("/logout", cookie),
      undefined,
      envFor(sessions, throttle),
    );
    expect(response.status).toBe(503);
    expect(throttle.count()).toBe(1);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("a body of exactly the cap is not a 413: the guest still 303s", async () => {
    const sessions = createMemorySessionStore();
    const throttle = throttleFixture(0);
    const response = await app.request(
      new Request(new URL("/logout", STAGING_APP_URL), {
        method: "POST",
        body: "x".repeat(MAX),
        headers: { origin: STAGING_APP_URL, accept: "application/json" },
      }),
      undefined,
      envFor(sessions, throttle),
    );
    expect(response.status).toBe(303);
    expect(throttle.count()).toBe(1);
  });

  it("under-cap with a spent budget is still the one 429 shape, with no new hit", async () => {
    const sessions = createMemorySessionStore();
    const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
    const response = await app.request(
      smallRequest("/logout", ""),
      undefined,
      envFor(sessions, throttle),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ reason: "rate_limited", retry_after: 30 });
    expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
  });
});

describe("body-size cap precedes the throttle on POST /auth/qa/:identity", () => {
  it.each([true, false])(
    "advertised=%s oversized with a valid token is 413 with zero throttle spend and no issuance",
    async (advertised) => {
      const sessions = createMemorySessionStore();
      const create = vi.spyOn(sessions, "create");
      const throttle = throttleFixture(0);
      const { request, pull } = upload("/auth/qa/qa-member", MAX, "", advertised, qaHeaders);
      const response = await app.request(request, undefined, envFor(sessions, throttle));
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(ERROR);
      expect(throttle.store).not.toHaveBeenCalled();
      expect(throttle.sql).not.toHaveBeenCalled();
      expect(throttle.count()).toBe(0);
      expect(create).not.toHaveBeenCalled();
      if (advertised) expect(pull).not.toHaveBeenCalled();
      await request.body?.cancel().catch(() => {});
    },
  );

  it.each([true, false])(
    "advertised=%s oversized with a valid token beats a spent budget (413, not 429)",
    async (advertised) => {
      const sessions = createMemorySessionStore();
      const create = vi.spyOn(sessions, "create");
      const throttle = throttleFixture(AUTH_THROTTLE_PER_MINUTE);
      const { request } = upload("/auth/qa/qa-member", MAX, "", advertised, qaHeaders);
      const response = await app.request(request, undefined, envFor(sessions, throttle));
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(ERROR);
      expect(throttle.store).not.toHaveBeenCalled();
      expect(throttle.count()).toBe(AUTH_THROTTLE_PER_MINUTE);
      expect(create).not.toHaveBeenCalled();
      await request.body?.cancel().catch(() => {});
    },
  );

  it.each([true, false])(
    "advertised=%s oversized probes stay gate-first 404s, byte-identical, with zero spend",
    async (advertised) => {
      const probes: Record<string, string>[] = [
        {},
        { [QA_HEADER]: "wrong-test-token" },
        { [QA_HEADER]: QA_TOKEN },
      ];
      const paths = ["/auth/qa/qa-member", "/auth/qa/qa-member", "/auth/qa/not-a-qa-identity"];
      const sessions = createMemorySessionStore();
      const create = vi.spyOn(sessions, "create");
      const throttle = throttleFixture(0);
      const env = envFor(sessions, throttle);
      const responses: Response[] = [];
      const pulls: ReturnType<typeof vi.fn>[] = [];
      for (let i = 0; i < probes.length; i++) {
        const { request, pull } = upload(paths[i]!, MAX, "", advertised, probes[i]!);
        responses.push(await app.request(request, undefined, env));
        pulls.push(pull);
        await request.body?.cancel().catch(() => {});
      }
      const [baseline, ...rest] = responses;
      expect(baseline!.status).toBe(404);
      const baselineBody = await baseline!.text();
      for (const res of rest) {
        expect(res.status).toBe(404);
        expect([...res.headers]).toEqual([...baseline!.headers]);
        expect(await res.text()).toBe(baselineBody);
        expect(res.headers.getSetCookie()).toHaveLength(0);
      }
      // The identity/token gate refuses before the cap or the throttle: no
      // upload pull, no throttle query, no issuance.
      for (const pull of pulls) expect(pull).not.toHaveBeenCalled();
      expect(throttle.store).not.toHaveBeenCalled();
      expect(throttle.count()).toBe(0);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("under-cap valid login still issues a 204 with exactly one throttle hit", async () => {
    const sessions = createMemorySessionStore();
    const create = vi.spyOn(sessions, "create");
    const throttle = throttleFixture(0);
    const response = await app.request(
      smallRequest("/auth/qa/qa-member", "", qaHeaders),
      undefined,
      envFor(sessions, throttle),
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(throttle.count()).toBe(1);
    expect(create).toHaveBeenCalledOnce();
  });

  it("under-cap missing-token, bad-token and unknown-identity refusals stay byte-identical 404s", async () => {
    const sessions = createMemorySessionStore();
    const create = vi.spyOn(sessions, "create");
    const throttle = throttleFixture(0);
    const env = envFor(sessions, throttle);
    const baseline = await app.request(
      smallRequest("/auth/qa/not-a-qa-identity", "", qaHeaders),
      undefined,
      env,
    );
    expect(baseline.status).toBe(404);
    const baselineBody = await baseline.text();
    for (const [path, headers] of [
      ["/auth/qa/qa-member", {}],
      ["/auth/qa/qa-member", { [QA_HEADER]: "wrong-test-token" }],
    ] as const) {
      const res = await app.request(smallRequest(path, "", headers), undefined, env);
      expect(res.status).toBe(404);
      expect([...res.headers]).toEqual([...baseline.headers]);
      expect(await res.text()).toBe(baselineBody);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("a body of exactly the cap with a valid token is not a 413: still 204", async () => {
    const sessions = createMemorySessionStore();
    const throttle = throttleFixture(0);
    const response = await app.request(
      new Request(new URL("/auth/qa/qa-member", STAGING_APP_URL), {
        method: "POST",
        body: "x".repeat(MAX),
        headers: { origin: STAGING_APP_URL, accept: "application/json", ...qaHeaders },
      }),
      undefined,
      envFor(sessions, throttle),
    );
    expect(response.status).toBe(204);
    expect(throttle.count()).toBe(1);
  });

  it("under-cap valid login with a spent budget is still the one 429 shape, with no new hit", async () => {
    const sessions = createMemorySessionStore();
    const create = vi.spyOn(sessions, "create");
    const throttle = throttleFixture(AUTH_THROTTLE_PER_MINUTE);
    const response = await app.request(
      smallRequest("/auth/qa/qa-member", "", qaHeaders),
      undefined,
      envFor(sessions, throttle),
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ reason: "rate_limited", retry_after: 30 });
    expect(throttle.count()).toBe(AUTH_THROTTLE_PER_MINUTE);
    expect(create).not.toHaveBeenCalled();
  });
});
