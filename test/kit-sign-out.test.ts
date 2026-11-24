// route-inventory: POST /logout
// route-inventory: POST /logout/everywhere
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import { AUTH_STATUS_COOKIE } from "../src/http/auth-status";
import { fetchKitSignOut } from "../src/kit-sign-out";
import { decideOwner } from "../src/route-ownership";
import { SESSION_COOKIE } from "../src/session-cookie";
import { hashToken, newSessionToken, REVOKE_ALL_EXCEPT, type Sql } from "../src/sessions";
import type { EnvWithThrottle } from "../src/throttle";
import { EXPIRED_WRITE_COOKIE } from "../src/write-recovery";
import app from "./app";
import recording from "./fixtures/parity/hono-9822a6e60c6b2229c8b823bb481c87fb29fa85c9/index.json";
import { vectors as ordinary } from "./fixtures/parity/hono-9822a6e60c6b2229c8b823bb481c87fb29fa85c9/routes/logout.json";
import { vectors as everywhere } from "./fixtures/parity/hono-9822a6e60c6b2229c8b823bb481c87fb29fa85c9/routes/logout_everywhere.json";
import { recoveryFixture, SECRET } from "./fixtures/session-recovery";
import { withThrottleTx } from "./helpers/throttle-tx-double";

const REQUEST_ID = "0123456789abcdef";
const PRIVATE = "synthetic driver details";
const ROUTES = [
  { path: "/logout", vectors: ordinary },
  { path: "/logout/everywhere", vectors: everywhere },
] as const;
type Fixture = ReturnType<typeof recoveryFixture>;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function signed(name: string, value: string) {
  return (await serializeSigned(name, value, SECRET, { path: "/", secure: true })).split(";")[0]!;
}

const responders = {
  Hono: (f: Fixture, path: string, init: RequestInit) => app.request(path, init, f.env),
  Kit: (f: Fixture, path: string, init: RequestInit) =>
    fetchKitSignOut(new Request(new URL(path, f.env.APP_URL), init), f.env, REQUEST_ID),
};

function post(f: Fixture, cookie: string, accept = "text/html"): RequestInit {
  return {
    method: "POST",
    headers: { origin: f.env.APP_URL, cookie, accept, "cf-ray": REQUEST_ID },
  };
}

const shared: Record<string, unknown> = recording.shared;

async function expectFrozenResponse(
  response: Response | null,
  vector: { response: { status: number; headers: string; setCookies: string; body: string } },
) {
  if (!response) throw new Error("Missing sign-out response");
  const golden = vector.response;
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
  if (golden.body === ordinary.HEAD.response.body) expect(await response.text()).toBe("");
}

describe.each(ROUTES)("detached sign-out parity for $path", ({ path, vectors }) => {
  it("leaves method and admission refusals with Hono", async () => {
    const f = recoveryFixture();
    const live = await f.login();
    const acquire = vi.fn(() => {
      throw new Error(PRIVATE);
    });
    Object.defineProperty(f.env, "SESSION_STORE", { get: acquire });
    const sql = vi.fn(async (parts: TemplateStringsArray) =>
      parts.join("").includes("SELECT count(*)") ? [{ n: 30, wait: 60 }] : [],
    );
    const throttle = vi.fn(async () => withThrottleTx(sql as unknown as Sql));
    (f.env as EnvWithThrottle).THROTTLE_STORE = throttle;
    for (const method of ["GET", "HEAD", "OPTIONS", "PUT", "PATCH", "DELETE"] as const) {
      const init = { ...post(f, live.cookie, "*/*"), method };
      const request = new Request(new URL(path, f.env.APP_URL), init);
      expect(decideOwner(request)).toBe("hono");
      expect(await fetchKitSignOut(request, f.env)).toBeNull();
      await expectFrozenResponse(await responders.Hono(f, path, init), vectors[method]);
    }
    expect(decideOwner(new Request(new URL(path, f.env.APP_URL), post(f, live.cookie)))).toBe(
      "hono",
    );
    for (const [origin, vector] of [
      ["https://other.example.test", vectors["POST origin:cross"]],
      [undefined, vectors["POST origin:missing"]],
    ] as const) {
      const init = post(f, live.cookie, "*/*");
      const headers = new Headers(init.headers);
      if (origin) headers.set("origin", origin);
      else headers.delete("origin");
      await expectFrozenResponse(await responders.Hono(f, path, { ...init, headers }), vector);
    }
    const init = post(f, live.cookie, "*/*");
    const headers = new Headers(init.headers);
    headers.set("content-length", String(BODY_LIMIT_BYTES.action + 1));
    await expectFrozenResponse(
      await responders.Hono(f, path, { ...init, headers }),
      vectors["POST body:oversized"],
    );
    expect(throttle).not.toHaveBeenCalled();
    await expectFrozenResponse(
      await responders.Hono(f, path, init),
      ordinary["POST throttle:exhausted"],
    );
    expect(throttle).toHaveBeenCalledOnce();
    expect(sql.mock.calls.some(([parts]) => parts.join("").includes("INSERT"))).toBe(false);
    expect(acquire).not.toHaveBeenCalled();
  });

  it("clears cookies on the frozen no-JS and JSON redirects without a usable bearer", async () => {
    const f = recoveryFixture();
    const acquire = vi.fn(() => {
      throw new Error(PRIVATE);
    });
    Object.defineProperty(f.env, "SESSION_STORE", { get: acquire });
    const pending = await signed(EXPIRED_WRITE_COOKIE, "pending|/profile?edit=1");
    const malformed = await signed(SESSION_COOKIE, "two_wrong_shape");
    for (const respond of Object.values(responders)) {
      const form = post(f, pending);
      await expectFrozenResponse(
        await respond(f, path, { ...form, body: new URLSearchParams({ next: "/profile" }) }),
        vectors["POST accept:html"],
      );
      for (const cookie of [`${malformed}; ${pending}`, `${SESSION_COOKIE}=forged`]) {
        await expectFrozenResponse(
          await respond(f, path, post(f, cookie, "application/json")),
          vectors["POST accept:json"],
        );
      }
    }
    expect(acquire).not.toHaveBeenCalled();
  });

  it.each([
    ["text/html", "text/html; charset=UTF-8", "We will be right back"],
    ["application/json", "application/json", '"error":"db_unavailable"'],
    ["*/*", "text/plain; charset=UTF-8", "Sign-out temporarily unavailable"],
  ])(
    "keeps cookies and negotiates a sanitized 503 for %s",
    async (accept, contentType, message) => {
      const f = recoveryFixture();
      const live = await f.login();
      const pending = await signed(EXPIRED_WRITE_COOKIE, "pending|/profile?edit=1");
      const mutate = vi
        .spyOn(f.sessions, path === "/logout" ? "revoke" : "revokeUserSessions")
        .mockRejectedValue(new Error(PRIVATE));
      const init = post(f, `${live.cookie}; ${pending}`, accept);
      const hono = await responders.Hono(f, path, init);
      const kit = await responders.Kit(f, path, init);
      if (!kit) throw new Error("Missing Kit refusal");
      const body = await hono.text();
      for (const res of [hono, kit]) {
        expect(res.status).toBe(503);
        expect(res.headers.getSetCookie()).toEqual([]);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.get("cache-control")).toBe("no-store, private");
        expect(res.headers.get("vary")).toBe("Accept");
        expect(res.headers.get("x-request-id")).toBe(REQUEST_ID);
        expect(res.headers.get("content-type")).toBe(contentType);
        expect(res.headers.get("retry-after")).toBe(accept === "*/*" ? null : "60");
      }
      expect(await kit.text()).toBe(body);
      expect(body).toContain(message);
      expect(body).not.toContain(PRIVATE);
      if (accept !== "*/*") expect(body).toContain(REQUEST_ID);
      expect(mutate).toHaveBeenCalledTimes(2);
      expect(await f.sessions.get(live.tokenHash)).toBeTruthy();
      expect(console.error).toHaveBeenCalledWith(
        path === "/logout" ? "logout revocation failed" : "logout everywhere revocation failed",
        { exception: "Error", request_id: REQUEST_ID },
      );
    },
  );
});

describe.each(Object.entries(responders))("sign-out effects through %s", (_, respond) => {
  it("revokes a rotated session lineage and leaves sibling lineages live", async () => {
    const f = recoveryFixture();
    const expiresAt = new Date(Date.now() + 3600_000);
    const live = await f.login(expiresAt);
    const sibling = await f.login();
    const row = (await f.sessions.get(live.tokenHash))!;
    const key = (await f.sessions.statusHash(live.tokenHash))!;
    const status = await signed(AUTH_STATUS_COOKIE, key);
    const successor = await hashToken(newSessionToken());
    expect(
      await f.sessions.rotate(live.tokenHash, { ...row, tokenHash: successor, expiresAt }),
    ).toBe(true);
    const revoke = vi.spyOn(f.sessions, "revoke");
    const lineage = vi.spyOn(f.sessions, "revokeLineage");
    await expectFrozenResponse(
      await respond(f, "/logout", post(f, `${live.cookie}; ${status}`)),
      ordinary["POST identity:member"],
    );
    expect(revoke.mock.calls).toEqual([[live.tokenHash]]);
    expect(lineage.mock.calls).toEqual([[key]]);
    expect(await f.sessions.isActive(key)).toBe(false);
    expect(await f.sessions.get(successor)).toBeNull();
    expect(await f.sessions.get(sibling.tokenHash)).toBeTruthy();
  });

  it("sweeps only the live acting member and clears a dead bearer without sweeping", async () => {
    const f = recoveryFixture();
    const expiresAt = new Date(Date.now() + 3600_000);
    const live = await f.login(expiresAt);
    const sibling = await f.login();
    const dead = await f.login(new Date(0));
    const row = (await f.sessions.get(live.tokenHash))!;
    const other = await hashToken(newSessionToken());
    await f.sessions.create({ ...row, userId: "100000000000000002", tokenHash: other, expiresAt });
    const status = await signed(AUTH_STATUS_COOKIE, (await f.sessions.statusHash(live.tokenHash))!);
    const sweep = vi.spyOn(f.sessions, "revokeUserSessions");
    const lineage = vi.spyOn(f.sessions, "revokeLineage");
    await expectFrozenResponse(
      await respond(f, "/logout/everywhere", post(f, `${dead.cookie}; ${status}`)),
      everywhere["POST identity:expired"],
    );
    expect(sweep).not.toHaveBeenCalled();
    expect(lineage).not.toHaveBeenCalled();
    expect(await f.sessions.get(live.tokenHash)).toBeTruthy();
    await expectFrozenResponse(
      await respond(f, "/logout/everywhere", post(f, live.cookie)),
      everywhere["POST identity:member"],
    );
    expect(sweep.mock.calls).toEqual([[row.userId, REVOKE_ALL_EXCEPT]]);
    expect(await f.sessions.get(live.tokenHash)).toBeNull();
    expect(await f.sessions.get(sibling.tokenHash)).toBeNull();
    expect(await f.sessions.get(other)).toBeTruthy();
  });
});
