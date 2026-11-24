// route-inventory: POST /logout/everywhere
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STATUS_COOKIE } from "../src/http/auth-status";
import { fetchKitSignOutEverywhere } from "../src/kit-sign-out";
import { decideOwner } from "../src/route-ownership";
import { SESSION_COOKIE } from "../src/session-cookie";
import { hashToken, newSessionToken, REVOKE_ALL_EXCEPT } from "../src/sessions";
import app from "./app";
import recording from "./fixtures/parity/hono-9822a6e60c6b2229c8b823bb481c87fb29fa85c9/index.json";
import { vectors } from "./fixtures/parity/hono-9822a6e60c6b2229c8b823bb481c87fb29fa85c9/routes/logout_everywhere.json";
import { MEMBER, recoveryFixture, SECRET } from "./fixtures/session-recovery";

const PATH = "/logout/everywhere";
const REQUEST_ID = "0123456789abcdef";
const OTHER = "100000000000000002";
const PRIVATE = "synthetic driver details";
type Fixture = ReturnType<typeof recoveryFixture>;
type Vector = keyof typeof vectors;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function signed(name: string, value: string) {
  return (await serializeSigned(name, value, SECRET, { path: "/", secure: true })).split(";")[0]!;
}

const responders = {
  Hono: (f: Fixture, request: Request) => app.request(request, undefined, f.env),
  Kit: (f: Fixture, request: Request) => fetchKitSignOutEverywhere(request, f.env, REQUEST_ID),
};

function post(f: Fixture, cookie: string, accept = "text/html", body?: URLSearchParams) {
  return new Request(new URL(PATH, f.env.APP_URL), {
    method: "POST",
    headers: { origin: f.env.APP_URL, cookie, accept, "cf-ray": REQUEST_ID },
    body,
  });
}

const shared: Record<string, unknown> = recording.shared;

async function expectFrozenResponse(response: Response | null, vector: Vector) {
  if (!response) throw new Error("Missing sign-out-everywhere response");
  const golden = vectors[vector].response;
  const headers = shared[golden.headers.slice(1)] as Record<string, string>;
  const cookies = shared[golden.setCookies.slice(1)] as {
    name: string;
    value: string;
    attributes: string[];
  }[];
  expect(response.status).toBe(golden.status);
  for (const name of ["cache-control", "location", "vary", "content-type"]) {
    expect(response.headers.get(name)).toBe(headers[name] ?? null);
  }
  expect(response.headers.getSetCookie()).toEqual(
    cookies.map(({ name, value, attributes }) => [`${name}=${value}`, ...attributes].join("; ")),
  );
  if (golden.body === vectors.HEAD.response.body) expect(await response.text()).toBe("");
}

it("leaves ownership and method refusals with Hono", async () => {
  const f = recoveryFixture();
  const live = await f.login();
  const acquire = vi.fn(() => {
    throw new Error(PRIVATE);
  });
  Object.defineProperty(f.env, "SESSION_STORE", { get: acquire });
  const admitted = post(f, live.cookie, "*/*");
  expect(decideOwner(admitted)).toBe("hono");
  for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"] as const) {
    const request = new Request(admitted.url, { method, headers: admitted.headers });
    expect(decideOwner(request)).toBe("hono");
    expect(await fetchKitSignOutEverywhere(request, f.env)).toBeNull();
    await expectFrozenResponse(await app.request(request, undefined, f.env), method);
  }
  for (const path of ["/logout", `${PATH}/`]) {
    const request = new Request(new URL(path, admitted.url), admitted);
    expect(await fetchKitSignOutEverywhere(request, f.env)).toBeNull();
  }
  expect(acquire).not.toHaveBeenCalled();
});

describe.each(Object.entries(responders))("sign-out everywhere through %s", (_, respond) => {
  it("sweeps every actor session and preserves the other member", async () => {
    const f = recoveryFixture();
    const expiresAt = new Date(Date.now() + 3_600_000);
    const live = await f.login(expiresAt);
    const sibling = await f.login();
    const row = (await f.sessions.get(live.tokenHash))!;
    const otherHashes = await Promise.all([newSessionToken(), newSessionToken()].map(hashToken));
    for (const tokenHash of otherHashes) {
      await f.sessions.create({ ...row, userId: OTHER, tokenHash, expiresAt });
    }
    const status = await signed(AUTH_STATUS_COOKIE, otherHashes[0]!);
    const cookie = `${live.cookie}; ${status}`;
    const form = new URLSearchParams({ userId: OTHER, next: "/profile" });
    const sweep = vi.spyOn(f.sessions, "revokeUserSessions");
    await expectFrozenResponse(
      await respond(f, post(f, cookie, "text/html", form)),
      "POST accept:html",
    );
    expect(sweep.mock.calls).toEqual([[MEMBER, REVOKE_ALL_EXCEPT]]);
    for (const hash of [live.tokenHash, sibling.tokenHash]) {
      expect(await f.sessions.get(hash)).toBeNull();
    }
    for (const hash of otherHashes) {
      expect(await f.sessions.get(hash)).toMatchObject({ userId: OTHER });
    }
  });

  it("clears unusable bearers without acquiring storage", async () => {
    const f = recoveryFixture();
    const acquire = vi.fn(() => {
      throw new Error(PRIVATE);
    });
    Object.defineProperty(f.env, "SESSION_STORE", { get: acquire });
    for (const cookie of [
      "",
      `${SESSION_COOKIE}=forged`,
      await signed(SESSION_COOKIE, "malformed"),
    ]) {
      await expectFrozenResponse(await respond(f, post(f, cookie)), "POST identity:forged");
    }
    expect(acquire).not.toHaveBeenCalled();
  });

  it("clears a dead bearer while leaving a signed live lineage untouched", async () => {
    const f = recoveryFixture();
    const dead = await f.login(new Date(Date.now() - 60_000));
    const live = await f.login();
    const status = await signed(AUTH_STATUS_COOKIE, live.tokenHash);
    const get = vi.spyOn(f.sessions, "get");
    const sweep = vi.spyOn(f.sessions, "revokeUserSessions");
    const lineage = vi.spyOn(f.sessions, "revokeLineage");
    await expectFrozenResponse(
      await respond(f, post(f, `${dead.cookie}; ${status}`)),
      "POST identity:expired",
    );
    expect(get.mock.calls).toEqual([[dead.tokenHash]]);
    expect(sweep).not.toHaveBeenCalled();
    expect(lineage).not.toHaveBeenCalled();
    expect(await f.sessions.get(live.tokenHash)).toBeTruthy();
  });

  it.each([
    ["lookup", "text/html", "text/html; charset=UTF-8", "We will be right back"],
    ["sweep", "application/json", "application/json", '"error":"db_unavailable"'],
    ["acquisition", "*/*", "text/plain; charset=UTF-8", "Sign-out temporarily unavailable"],
  ] as const)(
    "preserves cookies and can retry after %s fails",
    async (stage, accept, type, message) => {
      const f = recoveryFixture();
      const live = await f.login();
      const sibling = await f.login();
      const error = new Error(PRIVATE);
      const get = vi.spyOn(f.sessions, "get");
      const sweep = vi.spyOn(f.sessions, "revokeUserSessions");
      if (stage === "lookup") get.mockRejectedValueOnce(error);
      if (stage === "sweep") sweep.mockRejectedValueOnce(error);
      if (stage === "acquisition") {
        const acquire = vi
          .fn(() => f.sessions)
          .mockImplementationOnce(() => {
            throw error;
          });
        Object.defineProperty(f.env, "SESSION_STORE", { get: acquire });
      }
      const response = await respond(f, post(f, live.cookie, accept));
      if (!response) throw new Error("Missing sign-out-everywhere failure");
      expect(response.status).toBe(503);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(response.headers.get("vary")).toBe("Accept");
      expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
      expect(response.headers.get("content-type")).toBe(type);
      expect(response.headers.get("retry-after")).toBe(accept === "*/*" ? null : "60");
      const body = await response.text();
      expect(body).toContain(message);
      expect(body).not.toContain(PRIVATE);
      if (accept !== "*/*") expect(body).toContain(REQUEST_ID);
      expect(console.error).toHaveBeenCalledWith("logout everywhere revocation failed", {
        exception: "Error",
        request_id: REQUEST_ID,
      });
      expect(sweep).toHaveBeenCalledTimes(stage === "sweep" ? 1 : 0);
      expect(await f.sessions.get(live.tokenHash)).toBeTruthy();
      expect(await f.sessions.get(sibling.tokenHash)).toBeTruthy();
      await expectFrozenResponse(await respond(f, post(f, live.cookie, accept)), "POST");
      expect(await f.sessions.get(live.tokenHash)).toBeNull();
      expect(await f.sessions.get(sibling.tokenHash)).toBeNull();
    },
  );
});
