import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTH_STATUS_COOKIE } from "../src/http/auth-status";
import { kitAuthStatusResponse } from "../src/kit-auth-status";
import { resolveRequestSession } from "../src/kit-session";
import { decideOwner } from "../src/route-ownership";
import { SESSION_COOKIE } from "../src/session-cookie";
import { hashToken, newSessionToken, SESSION_PREDECESSOR_GRACE_SECONDS } from "../src/sessions";
import { EXPIRED_WRITE_COOKIE } from "../src/write-recovery";
import { recoveryFixture, SECRET } from "./fixtures/session-recovery";

const PATH = "/auth/status";
const KIT_URL = `https://kit.example.test${PATH}`;
const REQUEST_ID = "0123456789abcdef";
type Fixture = ReturnType<typeof recoveryFixture>;

afterEach(() => vi.restoreAllMocks());

async function signed(name: string, value: string): Promise<string> {
  return (await serializeSigned(name, value, SECRET, { path: "/", secure: true })).split(";")[0]!;
}

async function expectParity(f: Fixture, cookie: string, authenticated: boolean, status = 200) {
  const headers = { cookie, accept: "text/html", "cf-ray": REQUEST_ID };
  const [hono, kit] = await Promise.all([
    f.request(PATH, { headers }),
    kitAuthStatusResponse(new Request(KIT_URL, { headers }), f.env, REQUEST_ID),
  ]);
  for (const response of [hono, kit]) {
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await response.text()).toBe(`{"authenticated":${authenticated}}`);
  }
}

describe("detached Kit auth status parity", () => {
  it("leaves all status methods with Hono", () => {
    for (const method of ["GET", "HEAD", "POST", "OPTIONS"]) {
      expect(decideOwner(new Request(KIT_URL, { method }))).toBe("hono");
    }
  });

  it("leaves anonymous, malformed and recovery-only requests independent of the store", async () => {
    const f = recoveryFixture();
    const pending = await signed(EXPIRED_WRITE_COOKIE, "pending|/profile?edit=1");
    const malformed = await signed(SESSION_COOKIE, "two_wrong_shape");
    const acquire = vi.fn(() => {
      throw new Error("unexpected store acquisition");
    });
    Object.defineProperty(f.env, "SESSION_STORE", { get: acquire });
    for (const cookie of ["", pending, malformed, `${AUTH_STATUS_COOKIE}=forged`]) {
      await expectParity(f, cookie, false);
    }
    expect(acquire).not.toHaveBeenCalled();
  });

  it("preserves the refusal when a presented cookie cannot be checked without a secret", async () => {
    const f = recoveryFixture();
    const live = await f.login();
    const pending = await signed(EXPIRED_WRITE_COOKIE, "pending|/profile?edit=1");
    f.env.SESSION_SECRET = "";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const get = vi.spyOn(f.sessions, "get");
    await expectParity(f, "", false);
    await expectParity(f, pending, false, 503);
    await expectParity(f, live.cookie, false, 503);
    expect(get).not.toHaveBeenCalled();
  });

  it("treats a signature verification error as an invalid cookie and keeps bearer fallback", async () => {
    const f = recoveryFixture();
    const live = await f.login();
    const key = (await f.sessions.statusHash(live.tokenHash))!;
    const probe = await signed(AUTH_STATUS_COOKIE, key);
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "verify").mockImplementation(
      (algorithm, cryptoKey, signature, data) => {
        if (new TextDecoder().decode(data) === key) {
          return Promise.reject(new Error("synthetic verifier failure"));
        }
        return verify(algorithm, cryptoKey, signature, data);
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const isActive = vi.spyOn(f.sessions, "isActive");

    await expectParity(f, probe, false);
    await expectParity(f, `${probe}; ${live.cookie}`, true);
    expect(isActive).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter(([line]) => line === "auth status store unavailable")).toEqual(
      [],
    );
  });

  it("reads the hashed bearer without renewal and honors first wire-valid cookie precedence", async () => {
    const f = recoveryFixture();
    const live = await f.login();
    const dead = await f.login(new Date(0));
    const get = vi.spyOn(f.sessions, "get");
    const probe = vi.spyOn(f.sessions, "isActive");
    const rotate = vi.spyOn(f.sessions, "rotate");
    const quoted = live.cookie.replace("=", '="') + '"';
    await expectParity(f, `${AUTH_STATUS_COOKIE}=forged; ${quoted}`, true);
    expect(get.mock.calls).toEqual([[live.tokenHash], [live.tokenHash]]);

    get.mockClear();
    await expectParity(f, `${SESSION_COOKIE}=forged; ${live.cookie}`, false);
    expect(get).not.toHaveBeenCalled();

    await expectParity(f, dead.cookie, false);
    await f.sessions.revoke(live.tokenHash);
    await expectParity(f, live.cookie, false);
    expect(probe).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
  });

  it("reads the stable probe past predecessor grace and cannot admit it as a bearer", async () => {
    let now = Date.now();
    const f = recoveryFixture(undefined, {}, () => now);
    const expiresAt = new Date(now + 3600_000);
    const live = await f.login(expiresAt);
    const row = (await f.sessions.get(live.tokenHash))!;
    const key = (await f.sessions.statusHash(live.tokenHash))!;
    const cookie = await signed(AUTH_STATUS_COOKIE, key);
    const successorHash = await hashToken(newSessionToken());
    expect(
      await f.sessions.rotate(live.tokenHash, { ...row, tokenHash: successorHash, expiresAt }),
    ).toBe(true);
    now += (SESSION_PREDECESSOR_GRACE_SECONDS + 1) * 1000;
    const probe = vi.spyOn(f.sessions, "isActive");
    const get = vi.spyOn(f.sessions, "get");
    await expectParity(f, live.cookie, false);
    get.mockClear();
    await expectParity(f, `${live.cookie}; ${cookie}`, true);
    await expectParity(f, cookie, true);
    expect(probe.mock.calls).toEqual([[key], [key], [key], [key]]);

    const relabeled = cookie.replace(AUTH_STATUS_COOKIE, SESSION_COOKIE);
    await expectParity(f, relabeled, false);
    for (const value of [cookie, relabeled]) {
      const request = new Request(KIT_URL, { headers: { cookie: value } });
      expect(
        await resolveRequestSession(request, {
          sessionSecret: SECRET,
          store: f.sessions,
          roleRecheck: null,
        }),
      ).toEqual({ status: "guest", session: null });
    }
    await f.sessions.revokeLineage(key);
    const independentSession = await f.login();
    await expectParity(f, `${cookie}; ${independentSession.cookie}`, false);
    expect(get).not.toHaveBeenCalled();
  });

  it("returns the existing 503 for store acquisition and either lookup failure", async () => {
    const f = recoveryFixture();
    const live = await f.login();
    const key = (await f.sessions.statusHash(live.tokenHash))!;
    const probe = await signed(AUTH_STATUS_COOKIE, key);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("synthetic private store error detail");
    vi.spyOn(f.sessions, "get").mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    await expectParity(f, live.cookie, false, 503);
    vi.spyOn(f.sessions, "isActive").mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    await expectParity(f, probe, false, 503);
    Object.defineProperty(f.env, "SESSION_STORE", {
      get: () => {
        throw failure;
      },
    });
    await expectParity(f, probe, false, 503);

    const statusWarnings = warn.mock.calls.filter(
      ([line]) => line === "auth status store unavailable",
    );
    expect(statusWarnings).toEqual(
      Array.from({ length: 6 }, () => [
        "auth status store unavailable",
        { exception: "Error", request_id: REQUEST_ID },
      ]),
    );
  });
});
