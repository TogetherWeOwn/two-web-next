// Independent acceptance. Builder consumes unchanged; this branch is intentionally RED.
// Offline JSON receipt:
// npx vitest run test/admission-degradation-observability-acceptance.test.ts --reporter=json
//
// Removing a catch warning, leaking a bucket/error, inventing correlation, changing
// a verdict, or dispatching these Hono-owned actions to Kit must fail these cases.
// Codes/field vocabulary below are the public contract, not imported expectations.
// Warnings may use one JSON string or the existing console.warn(code, fields) form.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import realApp from "../src/index";
import { throttled } from "../src/join/route-shared";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { requestLog } from "../src/request-log";
import { dispatchHookRequest } from "../src/route-ownership";
import { createMemorySessionStore, hashToken, newSessionToken, type Sql } from "../src/sessions";
import { throttleGuard } from "../src/throttle";
import { trustHosts } from "../src/trust-hosts";
import {
  captureDiagnosticStream,
  scanDiagnosticStream,
  type DiagnosticRecord,
} from "./helpers/diagnostic-stream";

const driver = vi.hoisted(() => ({ sql: undefined as unknown, builds: 0 }));
// Only the external driver is replaced. Profile admission and checkJoinThrottle
// execute; deps.throttle is deliberately NOT supplied.
vi.mock("postgres", () => ({
  default: () => {
    driver.builds += 1;
    return driver.sql;
  },
}));

const ORIGIN = "https://next.example.test";
const RAY = "0123456789abcdef-LHR";
const OWNER = "326474832151838721";
const OTHER = "326474832151838722";
const IP = "192.0.2.44";
const MARKERS = [
  OWNER,
  OTHER,
  IP,
  "private-exception-marker",
  "private-cookie-marker",
  "private-body-marker",
  "hostile.example.test",
  "private-path-marker",
  "private-query-marker",
];
const JOIN_CODE = "join.throttle.store_failed";
const PROFILE_CODE = "profile.throttle.store_failed";
const HOST_CODE = "http.untrusted_host";
const HOST_ACTION = "check_app_url_and_proxy_host";
const env: Env = {
  APP_URL: ORIGIN,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};
const headers = {
  "cf-ray": RAY,
  "cf-connecting-ip": IP,
  cookie: "probe=private-cookie-marker",
  accept: "application/json",
};

// Native transaction surface, with exact statement admission and hit accounting.
// This is a storage fixture, not a replacement for any verdict/logger function.
function sqlFixture(
  opts: { error?: unknown; fail?: "begin" | "statement"; count?: number; busy?: boolean } = {},
) {
  const calls = { begins: 0, inserts: 0, buckets: [] as unknown[] };
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join("?");
    if (statement.includes("pg_advisory_xact_lock")) {
      calls.buckets.push(values[0]);
      return [];
    }
    if (statement.includes("SELECT count(*)")) {
      if (opts.fail === "statement") throw opts.error;
      return [{ n: opts.count ?? 0, wait: 17 }];
    }
    if (statement.includes("INSERT INTO web_throttle_hits")) {
      calls.inserts += 1;
      return [];
    }
    if (statement.includes("DELETE FROM web_throttle_hits")) return [];
    if (statement.includes("INSERT INTO join_attempts")) return [];
    throw new Error("Unexpected fixture statement");
  }) as Sql & { begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown> };
  sql.unsafe = async () => [];
  sql.begin = async (run) => {
    calls.begins += 1;
    if (opts.fail === "begin") throw opts.error;
    if (opts.busy && calls.begins === 1)
      throw Object.assign(new Error("private-exception-marker"), { code: "55P03" });
    return run(sql);
  };
  return { sql, calls };
}

let logs: DiagnosticRecord[];
beforeEach(() => {
  driver.builds = 0;
  logs = captureDiagnosticStream();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function clean() {
  expect(scanDiagnosticStream(logs, MARKERS)).toEqual({ hits: [], incomplete: [] });
}
function warns() {
  return logs.filter((line) => line.channel === "warn");
}
function decodedWarning(line: DiagnosticRecord): Record<string, unknown> {
  if (line.args.length === 1 && typeof line.args[0] === "string") {
    expect(line.args[0], "structured warning, not legacy message-only output").toMatch(/^\{/);
    return JSON.parse(line.args[0]);
  }
  expect(line.args).toHaveLength(2);
  expect(typeof line.args[0]).toBe("string");
  expect(line.args[1]).toBeTypeOf("object");
  return { event: line.args[0], ...(line.args[1] as Record<string, unknown>) };
}
function warning(code: string, fields: Record<string, unknown>) {
  clean();
  expect(warns()).toHaveLength(1);
  const record = decodedWarning(warns()[0]!);
  expect(record).toEqual({ event: code, ...fields });
  expect(JSON.stringify(record).length).toBeLessThanOrEqual(512);
}
function correlated(response: Response) {
  expect(response.headers.get("x-request-id")).toBe(RAY);
  const requests = logs
    .filter((line) => line.channel === "log" && typeof line.args[0] === "string")
    .map((line) => JSON.parse(line.args[0] as string))
    .filter((line) => line.event === "http.request");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ request_id: RAY, status: response.status });
}

// Execute the real Kit hook core. No Kit SSR/browser rendering applies: these
// write/OAuth/foreign-host paths are Hono-owned, even with Kit routes enabled.
async function throughKit(
  request: Request,
  fetch: (request: Request) => Response | Promise<Response>,
) {
  let forwards = 0;
  const response = await dispatchHookRequest(
    { request, url: new URL(request.url), route: { id: "/[...path]" }, locals: {} },
    {
      appUrl: ORIGIN,
      honoFetch: async (original) => {
        expect(original).toBe(request);
        forwards += 1;
        return fetch(original);
      },
      resolve: async () => {
        throw new Error("Hono-owned action incorrectly sent to Kit SSR");
      },
    },
  );
  expect(forwards).toBe(1);
  expect(response.headers.has("x-two-renderer")).toBe(false);
  return response;
}

async function join(path: string, store: () => Promise<Sql | null>, kit = false) {
  const bindings = { ...env, JOIN_DEPS: { store }, SESSION_STORE: createMemorySessionStore() };
  const request = new Request(`${ORIGIN}${path}`, { headers });
  return kit
    ? throughKit(request, (r) => realApp.request(r, {}, bindings))
    : realApp.request(request, {}, bindings);
}
function startVerdict(response: Response) {
  expect(response.status).toBe(302);
  const destination = new URL(response.headers.get("location")!);
  expect(destination.origin).toBe("https://discord.com");
  expect(destination.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/join/callback`);
  expect(destination.searchParams.get("scope")).toBe("identify guilds.join");
  expect(response.headers.get("set-cookie")).toContain("__Host-two_join_state=");
  expect(response.headers.get("cache-control")).toBe("no-store, private");
}

async function profile(
  options: {
    owner?: boolean;
    form?: boolean;
    correlation?: boolean | string;
    kit?: boolean;
    noStore?: boolean;
  } = {},
) {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore([
    { id: OWNER, username: "fixture", avatar: null, bio: "original", games: [], timezone: "UTC" },
  ]);
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: options.owner === false ? OTHER : OWNER,
    username: "fixture",
    avatar: null,
    member: true,
    moderator: options.owner === false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
      secure: true,
      path: "/",
    })
  ).split(";")[0]!;
  const app = new Hono<{ Bindings: Env }>();
  if (options.correlation !== false) {
    if (typeof options.correlation === "string")
      app.use("*", async (c, next) => {
        c.set("requestId", options.correlation as string);
        await next();
      });
    else app.use("*", requestLog);
  }
  app.route("/", profilesApp({ sessionStore: sessions, store }));
  const bindings = {
    ...env,
    ...(options.noStore ? {} : { DATABASE_URL: "postgres://fixture.invalid/db" }),
  };
  const body = options.form
    ? "_method=PATCH&bio=private-body-marker&games_text=&timezone=UTC"
    : JSON.stringify({ bio: "private-body-marker", games: [], timezone: "UTC" });
  const request = new Request(`${ORIGIN}/members/${OWNER}`, {
    method: options.form ? "POST" : "PATCH",
    headers: {
      ...headers,
      cookie,
      origin: ORIGIN,
      "content-type": options.form ? "application/x-www-form-urlencoded" : "application/json",
    },
    body,
  });
  const response = options.kit
    ? await throughKit(request, (r) => app.request(r, {}, bindings))
    : await app.request(request, {}, bindings);
  return { response, saved: await store.find(OWNER) };
}

const failure = () => new TypeError(`private-exception-marker ${IP} ${OWNER}`);
describe("join degradation warnings", () => {
  it.each(["resolver", "begin", "statement"] as const)(
    "warns once on actual %s failure, without changing OAuth admission",
    async (mode) => {
      const fixture = sqlFixture({
        fail: mode === "resolver" ? undefined : mode,
        error: failure(),
      });
      const response = await join(
        "/join/discord?source=private-query-marker",
        async () => {
          if (mode === "resolver") throw failure();
          return fixture.sql;
        },
        true,
      );
      startVerdict(response);
      correlated(response);
      expect(fixture.calls.inserts).toBe(0);
      warning(JOIN_CODE, { throttle: "join", exception: "TypeError", request_id: RAY });
    },
  );

  it("callback admission warns before its unchanged invalid-state recovery", async () => {
    // Callback resolves the store again for best-effort attempt recording; only
    // throttle statements fail, leaving that independent work healthy.
    const fixture = sqlFixture({ fail: "statement", error: failure() });
    const response = await join(
      "/join/callback?code=private-query-marker",
      async () => fixture.sql,
      true,
    );
    expect(response.status).toBe(200);
    correlated(response);
    clean();
    const targeted = warns().filter(
      (line) =>
        line.args[0] === JOIN_CODE ||
        (typeof line.args[0] === "string" &&
          line.args[0].startsWith("{") &&
          JSON.parse(line.args[0]).event === JOIN_CODE),
    );
    expect(targeted).toHaveLength(1);
    expect(decodedWarning(targeted[0]!)).toEqual({
      event: JOIN_CODE,
      throttle: "join",
      exception: "TypeError",
      request_id: RAY,
    });
    // Its existing InvalidState warning is separate, not a second store warning.
    expect(warns()).toHaveLength(2);
  });

  it.each([undefined, "private-cookie-marker"])(
    "join does not invent correlation without a valid middleware id (%s)",
    async (id) => {
      const app = new Hono<{ Bindings: Env }>();
      if (id)
        app.use("*", async (c, next) => {
          c.set("requestId", id);
          await next();
        });
      app.get("/join/discord", async (c) => (await throttled(c)) ?? c.body(null, 204));
      const response = await app.request(
        `${ORIGIN}/join/discord`,
        { headers },
        {
          ...env,
          JOIN_DEPS: {
            store: async () => {
              throw failure();
            },
          },
        },
      );
      expect(response.status).toBe(204);
      expect(response.headers.has("x-request-id")).toBe(false);
      warning(JOIN_CODE, { throttle: "join", exception: "TypeError" });
    },
  );

  it("CONTROL: classified database outage stays 503, not a degraded admission", async () => {
    const response = await join("/join/discord", async () => {
      throw Object.assign(failure(), { code: "ECONNREFUSED" });
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(warns()).toHaveLength(0);
    clean();
  });

  it("CONTROL: healthy join is silent and still charges one hit", async () => {
    const fixture = sqlFixture();
    startVerdict(await join("/join/discord", async () => fixture.sql));
    expect(fixture.calls.inserts).toBe(1);
    expect(fixture.calls.buckets).toEqual([`web-throttle:join:${IP}`]);
    expect(warns()).toHaveLength(0);
    clean();
  });

  it.each([false, true])(
    "CONTROL: over-budget/busy=%s stays 429 with no new warning",
    async (busy) => {
      const fixture = sqlFixture({ count: 10, busy });
      const response = await join("/join/discord", async () => fixture.sql);
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe(busy ? "1" : "17");
      expect(fixture.calls.inserts).toBe(0);
      expect(warns()).toHaveLength(0);
      clean();
    },
  );

  it("CONTROL: null store retains only the existing checkJoinThrottle warning", async () => {
    startVerdict(await join("/join/discord", async () => null));
    expect(warns().map((line) => line.args)).toEqual([
      ["Throttle store unavailable; allowing the request.", { throttle: "join" }],
    ]);
    clean();
  });
});

describe("profile degradation warnings", () => {
  it.each([false, true])(
    "owner save still succeeds (form=%s) with one bounded correlated warning",
    async (form) => {
      driver.sql = sqlFixture({ fail: "begin", error: failure() }).sql;
      const { response, saved } = await profile({ form, kit: true });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ saved: true, message: "Profile saved." });
      expect(saved?.bio).toBe("private-body-marker");
      expect(driver.builds).toBe(1);
      correlated(response);
      warning(PROFILE_CODE, { throttle: "profile-write", exception: "TypeError", request_id: RAY });
    },
  );

  it("non-owner moderator still 403s after the throttle failure with no write", async () => {
    driver.sql = sqlFixture({ fail: "statement", error: failure() }).sql;
    const { response, saved } = await profile({ owner: false });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "forbidden",
      message: "You can only edit your own profile.",
      request_id: RAY,
    });
    expect(saved?.bio).toBe("original");
    expect(driver.builds).toBe(1);
    warning(PROFILE_CODE, { throttle: "profile-write", exception: "TypeError", request_id: RAY });
  });

  it.each([false, "private-cookie-marker"])(
    "omits correlation without a validated requestLog id (%s)",
    async (correlation) => {
      driver.sql = sqlFixture({ fail: "begin", error: failure() }).sql;
      const { response } = await profile({ correlation });
      expect(response.status).toBe(200);
      expect(response.headers.has("x-request-id")).toBe(false);
      warning(PROFILE_CODE, { throttle: "profile-write", exception: "TypeError" });
    },
  );

  it("bounds a hostile exception name without changing admission", async () => {
    const error = failure();
    error.name = `Failure\r\n${"X".repeat(500)}`;
    driver.sql = sqlFixture({ fail: "begin", error }).sql;
    expect((await profile()).response.status).toBe(200);
    clean();
    expect(warns()).toHaveLength(1);
    const record = decodedWarning(warns()[0]!);
    expect(record).toEqual({
      event: PROFILE_CODE,
      throttle: "profile-write",
      exception: expect.any(String),
      request_id: RAY,
    });
    expect(record.exception).toMatch(/^[^\r\n\x00-\x1f\x7f]{1,100}$/);
    expect(JSON.stringify(record).length).toBeLessThanOrEqual(512);
  });

  it("CONTROL: healthy profile admission is silent and still charges a hit", async () => {
    const fixture = sqlFixture();
    driver.sql = fixture.sql;
    expect((await profile()).response.status).toBe(200);
    expect(fixture.calls.buckets).toEqual([`web-throttle:profile-write:${OWNER}`]);
    expect(fixture.calls.inserts).toBe(1);
    expect(warns()).toHaveLength(0);
    clean();
  });

  it("CONTROL: no configured profile store retains its silent allow", async () => {
    expect((await profile({ noStore: true })).response.status).toBe(200);
    expect(driver.builds).toBe(0);
    expect(warns()).toHaveLength(0);
    clean();
  });

  it("CONTROL: profile over-budget still refuses before ownership or save", async () => {
    const fixture = sqlFixture({ count: 30 });
    driver.sql = fixture.sql;
    const { response, saved } = await profile({ owner: false });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(saved?.bio).toBe("original");
    expect(fixture.calls.inserts).toBe(0);
    expect(warns()).toHaveLength(0);
    clean();
  });
});

describe("host refusal correlation", () => {
  it.each(["host", "url"])(
    "real application refuses hostile %s with one correlated, no-echo structured warn",
    async (kind) => {
      const url = `${kind === "url" ? "https://hostile.example.test" : ORIGIN}/private-path-marker?x=private-query-marker`;
      const request = new Request(url, {
        headers: {
          ...headers,
          host: kind === "host" ? "hostile.example.test" : "next.example.test",
        },
      });
      const response = await throughKit(request, (r) => realApp.request(r, {}, env));
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store, private");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toContain("We cannot find that page");
      correlated(response);
      warning(HOST_CODE, { request_id: RAY, next_action: HOST_ACTION });
    },
  );

  it("host refusal without requestLog does not invent an id", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", trustHosts());
    app.get("/", (c) => c.text("allowed"));
    const response = await app.request(
      `${ORIGIN}/`,
      { headers: { host: "hostile.example.test" } },
      env,
    );
    expect(response.status).toBe(404);
    expect(response.headers.has("x-request-id")).toBe(false);
    warning(HOST_CODE, { next_action: HOST_ACTION });
  });

  it("CONTROL: trusted host produces no refusal warning", async () => {
    const response = await realApp.request(`${ORIGIN}/robots.txt`, { headers }, env);
    expect(response.status).toBe(200);
    expect(warns()).toHaveLength(0);
    clean();
  });

  it("CONTROL: existing throttleGuard failure is not relogged under a new code", async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.use("*", requestLog);
    app.get("/probe", async (c) => (await throttleGuard(c, "probe", 10)) ?? c.body(null, 204));
    const response = await app.request(
      `${ORIGIN}/probe`,
      { headers },
      {
        ...env,
        THROTTLE_STORE: async () => {
          throw failure();
        },
      },
    );
    expect(response.status).toBe(204);
    expect(warns().map((line) => line.args)).toEqual([
      [
        "Throttle store failed; allowing the request.",
        { throttle: "probe", exception: "TypeError" },
      ],
    ]);
    clean();
  });
});

describe("operator contract", () => {
  it.each([JOIN_CODE, PROFILE_CODE, HOST_CODE])(
    "documents exactly one canonical row for %s with recovery and read-only guidance",
    (code) => {
      const text = readFileSync(new NodeURL("../docs/runbook-logs.md", import.meta.url), "utf8");
      const rows = text
        .split("\n")
        .filter((line) => line.startsWith("|") && line.includes(`\`${code}\``));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toContain("request_id");
      expect(row).toContain("retryable");
      expect(row).toContain("next_action");
      expect(row).toMatch(/read.only|Filter|SELECT/i);
      if (code === HOST_CODE) expect(row).toContain(HOST_ACTION);
      else {
        expect(row).toContain("exception");
        expect(row).toContain("throttle");
      }
      // The replayable offline receipt is native Vitest JSON, not a second logging
      // implementation or a command that connects to production to manufacture proof.
      expect(text).toContain(
        "npx vitest run test/admission-degradation-observability-acceptance.test.ts --reporter=json",
      );
    },
  );
});
