import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import app from "./app";
import { profilesApp } from "../src/profiles/routes";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { SHIELD_REFUSAL_AUDIT_RATE } from "../src/agent-events/shield";

// No sockets: model only the existing shield SQL and audit writes.
const fixture = vi.hoisted(() => ({
  hits: 0,
  buckets: [] as string[],
  queries: [] as string[],
  ends: 0,
  connects: 0,
  failAudit: false,
  failGrants: false,
  options: [] as Record<string, unknown>[],
}));
vi.mock("postgres", () => ({
  default: (_url: string, options: Record<string, unknown>) => {
    fixture.connects++;
    fixture.options.push(options);
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      fixture.queries.push(query);
      if (fixture.failAudit && query.includes("agent_event_audits"))
        throw new Error("private audit failure");
      if (fixture.failGrants && query.includes("agent_event_grants"))
        throw new Error("private grant failure");
      if (query.includes("SELECT count(*)")) return [{ n: fixture.hits, wait: 31 }];
      if (query.includes("INSERT INTO agent_event_hits")) {
        fixture.hits++;
        fixture.buckets.push(String(values[0]));
      }
      return [];
    };
    sql.begin = async (fn: (tx: unknown) => unknown) => fn(sql);
    sql.unsafe = async () => [];
    sql.end = async () => {
      fixture.ends++;
    };
    return sql;
  },
}));

const env = {
  APP_URL: "https://fixture.example.test",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
} as Env;
const userId = "111111111111111111";
const ERROR = {
  reason: "payload_too_large",
  message: "Reduce the size of your request and try again.",
};

function upload(path: string, method: string, max: number, cookie = "", advertised = false) {
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
    controller.enqueue(new Uint8Array(1024)),
  );
  const request = new Request(new URL(path, env.APP_URL), {
    method,
    body: new ReadableStream({ pull }, { highWaterMark: 0 }),
    duplex: "half",
    headers: {
      origin: env.APP_URL,
      accept: "application/json",
      "content-type": "application/json",
      cookie,
      ...(advertised ? { "content-length": String(max + 1) } : {}),
    },
  } as RequestInit);
  return { request, pull };
}

async function session(moderator = false) {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId,
    username: "member",
    avatar: null,
    member: true,
    moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
      path: "/",
      secure: true,
    })
  ).split(";")[0]!;
  return { sessions, cookie };
}

beforeEach(() => {
  fixture.hits = 0;
  fixture.buckets = [];
  fixture.queries = [];
  fixture.ends = 0;
  fixture.connects = 0;
  fixture.failAudit = false;
  fixture.failGrants = false;
  fixture.options = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("profile write admission", () => {
  it.each(["PATCH", "POST"])(
    "%s refuses oversized bodies before throttle spend, even with a spent budget",
    async (method) => {
      const { sessions, cookie } = await session();
      const get = vi.spyOn(sessions, "get");
      const throttle = vi.fn(async () => ({ limited: true as const, retryAfter: 31 }));
      const profile = profilesApp({ sessionStore: sessions, throttle });
      for (const advertised of [false, true]) {
        const { request, pull } = upload(
          `/members/${userId}`,
          method,
          BODY_LIMIT_BYTES.form,
          cookie,
          advertised,
        );
        if (method === "POST")
          request.headers.set("content-type", "application/x-www-form-urlencoded");
        const response = await profile.request(request, undefined, env);
        expect(response.status).toBe(413);
        expect(await response.json()).toEqual(ERROR);
        if (advertised) expect(pull).not.toHaveBeenCalled();
        else expect(pull.mock.calls.length).toBeLessThanOrEqual(BODY_LIMIT_BYTES.form / 1024 + 2);
        await request.body?.cancel();
      }
      expect(throttle).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      const body =
        method === "POST" ? "_method=PATCH&bio=hello&games_text=" : '{"bio":"hello","games":[]}';
      const spent = await profile.request(
        `/members/${userId}`,
        {
          method,
          body,
          headers: {
            cookie,
            accept: "application/json",
            "content-type":
              method === "POST" ? "application/x-www-form-urlencoded" : "application/json",
          },
        },
        env,
      );
      expect(spent.status).toBe(429);
      expect(await spent.json()).toMatchObject({ reason: "rate_limited", retry_after: 31 });
      expect(throttle).toHaveBeenCalledTimes(1);
      expect(throttle).toHaveBeenCalledWith(`profile-write:${userId}`);
    },
  );

  it.each(["PATCH", "POST"])(
    "%s spends nothing on overflow and exactly one attempt on a valid write",
    async (method) => {
      const { sessions, cookie } = await session();
      const throttle = vi.fn(async () => ({ limited: false as const }));
      const store = {
        find: vi.fn(async () => ({
          id: userId,
          username: "member",
          avatar: null,
          bio: null,
          games: [],
          timezone: null,
        })),
        save: vi.fn(async () => {}),
      };
      const profile = profilesApp({ sessionStore: sessions, throttle, store });
      for (const advertised of [false, true]) {
        const { request } = upload(
          `/members/${userId}`,
          method,
          BODY_LIMIT_BYTES.form,
          cookie,
          advertised,
        );
        expect((await profile.request(request, undefined, env)).status).toBe(413);
      }
      expect(throttle).not.toHaveBeenCalled();
      expect(store.find).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
      const body =
        method === "POST" ? "_method=PATCH&bio=hello&games_text=" : '{"bio":"hello","games":[]}';
      const response = await profile.request(
        `/members/${userId}`,
        {
          method,
          body,
          headers: {
            cookie,
            accept: "application/json",
            "content-type":
              method === "POST" ? "application/x-www-form-urlencoded" : "application/json",
          },
        },
        env,
      );
      expect(response.status).toBe(200);
      expect(throttle).toHaveBeenCalledTimes(1);
      expect(store.save).toHaveBeenCalledOnce();
    },
  );

  it.each(["PATCH", "POST"])(
    "%s keeps the member gate on deeper or bare member write shapes",
    async (method) => {
      const { sessions } = await session();
      const get = vi.spyOn(sessions, "get");
      const throttle = vi.fn(async () => ({ limited: false as const }));
      const profile = profilesApp({ sessionStore: sessions, throttle });
      for (const path of [`/members/${userId}/extra`, `/members/${userId}/`, "/members/"]) {
        const response = await profile.request(
          path,
          { method, headers: { accept: "application/json", cookie: "" } },
          env,
        );
        expect(response.status, `${method} ${path}`).toBe(401);
        expect(await response.json(), `${method} ${path}`).toEqual({
          error: "Unauthorized",
          recovery: "/auth/recover?next=%2Fprofile",
        });
        expect(response.headers.get("cache-control") ?? "", `${method} ${path}`).toMatch(/private/);
        expect(response.headers.get("cache-control") ?? "", `${method} ${path}`).toMatch(
          /no-store/,
        );
      }
      expect(throttle).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      // The real single-segment write shape still 413s first when oversized.
      const { request } = upload(`/members/${userId}`, method, BODY_LIMIT_BYTES.form, "", true);
      if (method === "POST")
        request.headers.set("content-type", "application/x-www-form-urlencoded");
      const oversized = await profile.request(request, undefined, env);
      expect(oversized.status).toBe(413);
      expect(await oversized.json()).toEqual(ERROR);
      expect(throttle).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      await request.body?.cancel();
    },
  );
});

const moderatorWrites = [
  ["POST", "/events", BODY_LIMIT_BYTES.json],
  ["PATCH", "/events/test-event", BODY_LIMIT_BYTES.json],
  ...["publish", "cancel", "rsvp-pause", "rsvp-reopen"].map((action) => [
    "POST",
    `/events/test-event/${action}`,
    BODY_LIMIT_BYTES.action,
  ]),
] as [string, string, number][];

describe("moderator admission", () => {
  it.each(moderatorWrites)(
    "%s %s refuses oversized bodies before session reads for guests and non-moderators",
    async (method, path, max) => {
      const { sessions, cookie } = await session();
      const get = vi.spyOn(sessions, "get");
      for (const presented of ["", cookie]) {
        for (const advertised of [false, true]) {
          const { request, pull } = upload(path, method, max, presented, advertised);
          const response = await app.request(request, undefined, {
            ...env,
            SESSION_STORE: sessions,
          } as Env);
          expect(response.status).toBe(413);
          expect(await response.json()).toEqual(ERROR);
          if (advertised) expect(pull).not.toHaveBeenCalled();
          else expect(pull.mock.calls.length).toBeLessThanOrEqual(max / 1024 + 2);
          await request.body?.cancel();
        }
      }
      expect(get).not.toHaveBeenCalled();
    },
  );

  it.each(moderatorWrites)(
    "%s %s refuses a moderator upload before session reads",
    async (method, path, max) => {
      const { sessions, cookie } = await session(true);
      const get = vi.spyOn(sessions, "get");
      const { request } = upload(path, method, max, cookie);
      const response = await app.request(request, undefined, {
        ...env,
        SESSION_STORE: sessions,
      } as Env);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual(ERROR);
      expect(get).not.toHaveBeenCalled();
    },
  );
});

const ingressEnv = {
  ...env,
  AGENT_EVENTS_ENABLED: "true",
  AGENT_DB: { connectionString: "postgres://fixture.invalid/never-connected" },
} as Env;
const execution = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} });

describe("agent ingress admission", () => {
  it.each([
    [false, 404, "ingress_disabled"],
    [true, 503, "ingress_unavailable"],
  ] as const)(
    "environment gate enabled=%s refuses under-cap before SQL; over-cap is 413 first",
    async (enabled, status, reason) => {
      // Under-cap still reaches the gate with no client.
      const under = await app.request(
        "/api/agent-events",
        { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
        { ...env, AGENT_EVENTS_ENABLED: String(enabled) },
      );
      expect(under.status).toBe(status);
      expect(await under.json()).toMatchObject({ reason });
      expect(fixture.connects).toBe(0);
      // Over-cap never reaches the gate: the byte cap answers 413 first.
      for (const advertised of [false, true]) {
        const { request, pull } = upload(
          "/api/agent-events",
          "POST",
          BODY_LIMIT_BYTES.agent,
          "",
          advertised,
        );
        const response = await app.request(request, undefined, {
          ...env,
          AGENT_EVENTS_ENABLED: String(enabled),
        });
        expect(response.status).toBe(413);
        expect(await response.json()).toEqual(ERROR);
        // Advertised overflow short-circuits on content-length; chunked must
        // read the stream to discover the overflow.
        if (advertised) expect(pull).not.toHaveBeenCalled();
        else expect(pull).toHaveBeenCalled();
        expect(fixture.connects).toBe(0);
        expect(fixture.queries).toEqual([]);
        await request.body?.cancel();
      }
    },
  );

  it.each([null, "test-only-machine-credential"])(
    "spent bucket %s refuses under-cap 429; over-cap is 413 first",
    async (credential) => {
      // Sampler forced off (`rate < rate` is false): exact zero audits,
      // deterministically. Row shape under sampling is pinned by the
      // shield-429-audit suite.
      vi.spyOn(Math, "random").mockReturnValue(SHIELD_REFUSAL_AUDIT_RATE);
      fixture.hits = 60;
      // Under-cap still reaches the spent bucket and refuses 429.
      for (let i = 0; i < 2; i++) {
        const ctx = execution();
        const headers: Record<string, string> = { "cf-connecting-ip": "192.0.2.1" };
        if (credential) headers.authorization = `Bearer ${credential}`;
        const response = await app.request(
          "/api/agent-events",
          {
            method: "POST",
            body: JSON.stringify({ op: "create" }),
            headers: { "content-type": "application/json", ...headers },
          },
          ingressEnv,
          ctx,
        );
        expect(response.status).toBe(429);
        expect(await response.json()).toMatchObject({ reason: "rate_limited", retry_after: 31 });
        expect(ctx.waitUntil).toHaveBeenCalledOnce();
      }
      expect(fixture.hits).toBe(60);
      // Sampler forced off: exact zero audit INSERTs with no hit row and no
      // grant lookup either way.
      expect(fixture.queries.some((q) => /agent_event_grants/.test(q))).toBe(false);
      expect(fixture.queries.filter((q) => q.includes("agent_event_audits"))).toHaveLength(0);
      expect(fixture.ends).toBe(2);
      // Over-cap with the same spent bucket never reads the bucket: 413, no
      // new statements, hits, audits or closes.
      fixture.queries = [];
      fixture.ends = 0;
      for (const advertised of [false, true]) {
        const ctx = execution();
        const { request } = upload(
          "/api/agent-events",
          "POST",
          BODY_LIMIT_BYTES.agent,
          "",
          advertised,
        );
        if (credential) request.headers.set("authorization", `Bearer ${credential}`);
        request.headers.set("cf-connecting-ip", "192.0.2.1");
        const response = await app.request(request, undefined, ingressEnv, ctx);
        expect(response.status).toBe(413);
        expect(await response.json()).toEqual(ERROR);
        expect(ctx.waitUntil).not.toHaveBeenCalled();
        await request.body?.cancel();
      }
      expect(fixture.hits).toBe(60);
      expect(fixture.queries).toEqual([]);
      expect(fixture.ends).toBe(0);
    },
  );

  it.each([null, "test-only-machine-credential"])(
    "%s refuses overflow with zero spend and no client",
    async (credential) => {
      for (const advertised of [false, true]) {
        const ctx = execution();
        const { request } = upload(
          "/api/agent-events",
          "POST",
          BODY_LIMIT_BYTES.agent,
          "",
          advertised,
        );
        if (credential) request.headers.set("authorization", `Bearer ${credential}`);
        request.headers.set("cf-connecting-ip", "192.0.2.1");
        const response = await app.request(request, undefined, ingressEnv, ctx);
        expect(response.status).toBe(413);
        expect(await response.json()).toEqual(ERROR);
        expect(ctx.waitUntil).not.toHaveBeenCalled();
        await request.body?.cancel();
      }
      // Cap-first: no shield hit, no grant/audit row, no client open or close.
      expect(fixture.hits).toBe(0);
      expect(fixture.buckets).toEqual([]);
      expect(fixture.queries).toEqual([]);
      expect(fixture.connects).toBe(0);
      expect(fixture.ends).toBe(0);
    },
  );

  it("retains the static ingress 500 shape and closes the client on service failure", async () => {
    // Grantless requests are refused 401 before any store touch, so an audit
    // failure can no longer trigger this path. Fail the first DB touch of an
    // authenticated request instead: the grant lookup. The static 500 shape,
    // client close and error redaction are unchanged.
    fixture.failGrants = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const ctx = execution();
      const request = new Request(new URL("/api/agent-events", env.APP_URL), {
        method: "POST",
        body: "{}",
        headers: {
          accept: "application/json",
          authorization: "Bearer test-only-machine-credential",
        },
      });
      const response = await app.request(request, undefined, ingressEnv, ctx);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        code: "internal_error",
        reason: "internal_error",
        message: "The agent event ingress failed.",
        request_id: expect.any(String),
        next: "Retry shortly; report if it persists.",
      });
      expect(fixture.ends).toBe(1);
      expect(ctx.waitUntil).toHaveBeenCalledOnce();
      // Emission proof: the redaction assert below is vacuous when nothing is
      // logged, so pin the expected error first (silencing the logger fails here).
      expect(log).toHaveBeenCalledWith("agent-events failed", { exception: "Error" });
      expect(JSON.stringify(log.mock.calls)).not.toContain("private grant failure");
    } finally {
      log.mockRestore();
    }
  });

  it("refuses a failing upload without opening a client", async () => {
    const ctx = execution();
    const request = new Request(new URL("/api/agent-events", env.APP_URL), {
      method: "POST",
      duplex: "half",
      headers: { accept: "application/json" },
      body: new ReadableStream(
        {
          pull(controller) {
            controller.error(new Error("private upload failure"));
          },
        },
        { highWaterMark: 0 },
      ),
    } as RequestInit);
    const response = await app.request(request, undefined, ingressEnv, ctx);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("private upload failure");
    // Cap-first: the limiter fails the upload before admission opens a client.
    expect(fixture.hits).toBe(0);
    expect(fixture.connects).toBe(0);
    expect(fixture.queries).toEqual([]);
    expect(fixture.ends).toBe(0);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it.each(["complete", "reject"] as const)(
    "defers the client until a below-cap upload reaches EOF, then cleans up on %s",
    async (finish) => {
      const ctx = execution();
      let source!: ReadableStreamDefaultController<Uint8Array>;
      let waiting!: () => void;
      const awaitingEof = new Promise<void>((resolve) => {
        waiting = resolve;
      });
      const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
        source = controller;
        if (pull.mock.calls.length === 1) controller.enqueue(new TextEncoder().encode("{}"));
        else waiting();
      });
      const request = new Request(new URL("/api/agent-events", env.APP_URL), {
        method: "POST",
        duplex: "half",
        headers: { accept: "application/json" },
        body: new ReadableStream({ pull }, { highWaterMark: 0 }),
      } as RequestInit);
      let completed = false;
      const pending = Promise.resolve(app.request(request, undefined, ingressEnv, ctx)).then(
        (response) => {
          completed = true;
          return response;
        },
      );
      await awaitingEof;
      try {
        expect(completed).toBe(false);
        // Cap-first: the limiter buffers before admission, so no client exists
        // while EOF is withheld.
        expect(fixture.hits).toBe(0);
        expect(fixture.connects).toBe(0);
        expect(fixture.ends).toBe(0);
        expect(ctx.waitUntil).not.toHaveBeenCalled();
        expect(fixture.queries).toEqual([]);
        expect(fixture.options).toEqual([]);
      } finally {
        if (finish === "complete") source.close();
        else source.error(new Error("private withheld upload failure"));
        await pending;
      }
      const response = await pending;
      expect(response.status).toBe(finish === "complete" ? 401 : 400);
      expect(await response.text()).not.toContain("private withheld upload failure");
      if (finish === "complete") {
        // Admitted after EOF: one shield hit, then the grant resolution
        // refuses the grantless upload 401 (not 422) with no audit row.
        // Driver bounds apply either way.
        expect(fixture.hits).toBe(1);
        expect(fixture.connects).toBe(1);
        expect(fixture.queries.filter((q) => q.includes("agent_event_audits"))).toHaveLength(0);
        expect(fixture.ends).toBe(1);
        expect(ctx.waitUntil).toHaveBeenCalledOnce();
        expect(fixture.options).toEqual([
          {
            max: 1,
            idle_timeout: 10,
            connect_timeout: 10,
            prepare: false,
            fetch_types: false,
          },
        ]);
      } else {
        // Failed upload never reaches admission: no client, no audit.
        expect(fixture.hits).toBe(0);
        expect(fixture.connects).toBe(0);
        expect(fixture.queries).toEqual([]);
        expect(fixture.ends).toBe(0);
        expect(ctx.waitUntil).not.toHaveBeenCalled();
      }
    },
  );

  it("charges one shield hit at the cap and refuses grantless requests before envelope validation", async () => {
    for (const body of [" ".repeat(BODY_LIMIT_BYTES.agent - 2) + "{}", "{}", "bad-json"]) {
      const response = await app.request(
        "/api/agent-events",
        { method: "POST", body },
        ingressEnv,
        execution(),
      );
      // No credential is presented and this fixture admits no grants, so the
      // grant resolution refuses 401 before the envelope is validated (no
      // audit row). One shield hit is still charged per request either way.
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: "unauthenticated" });
    }
    expect(fixture.hits).toBe(3);
    expect(fixture.queries.filter((q) => q.includes("agent_event_audits"))).toHaveLength(0);
    expect(fixture.ends).toBe(3);
  });
});
