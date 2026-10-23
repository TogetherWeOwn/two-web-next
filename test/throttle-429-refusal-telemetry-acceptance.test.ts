// Acceptance contract: telemetry on throttle 429 refusals (S8).
//
// Acceptance-owned: the Builder builds on this branch and never edits this file.
// Failing-first: the nine telemetry tests run RED on the base head (human-guard
// refusals are silent today, and shield refusals warn only on the ~1% audit
// sample) and go green when the build lands. The three controls already pass and
// must keep passing.
//
// Contract for the Builder (token bucket + shed signal, following the
// takeCspLogToken / warnCspShed precedent in src/csp-reports.ts:136-159):
//   1. Every throttleGuard 429 — over-budget AND busy-path — takes a token from
//      an in-memory bucket: on success
//        console.warn("throttle.refused", { throttle, outcome: "rate_limited" })
//      with the route name only (never the "<name>:<client>" bucket, never IP
//      bytes, never body bytes); when the bucket is spent the refusal still
//      answers 429 and folds into a bounded shed signal
//        console.warn("throttle.refused.shed", { dropped })
//      with the drop count since the previous shed emit. The warn lives in the
//      guard (one site covers middleware + in-handler forms); checkJoinThrottle
//      verdicts stay as they are, so direct callers (join funnel, profile
//      writes, RSVP) keep their current silence.
//   2. Every over-budget shield refusal takes a token the same way: on success
//        console.warn("agent-events.shield.refused", { bucket_class, outcome })
//      with the bucket class only (credential | anonymous, never the credential,
//      never IP bytes, never body bytes); shed folds into
//        console.warn("agent-events.shield.refused.shed", { dropped }).
//      This replaces the sampled `agent-events.shield.refusal_sampled` warn; the
//      ~1% audit-row sampling is unchanged.
//   3. Store-failure allow-paths keep their existing warns byte-for-byte. Refusal
//      vs store-failure telemetry is distinguishable by stable code: the dotted
//      refusal codes above vs the two existing sentences.
//   4. Refill is Date.now-driven (same clock as the CSP precedent). Burst/refill
//      constants are the Builder's choice within the bounds these tests assume:
//      full recovery inside a 1h clock jump, and a finite burst drainable inside
//      a 300-attempt frozen-clock loop. Whether the bucket is shared or
//      per-source is the Builder's choice; these tests reset via the clock and
//      tolerate either.
//   5. Warn keys stay within { throttle, outcome, bucket_class, dropped }: the
//      console-user-key guard forbids user/userId keys, and exact-shape pins
//      below forbid bucket/IP/body keys.
//
// Known fallout the Builder owns (old silence contract, not this file):
// test/silent-fallback-throttle-acceptance.test.ts "a refused guard answers 429
// with Retry-After and no warn" flips to warn; the verdict-level silence pins in
// that file stay green. test/agent-events-shield-429-bounded-audit.test.ts
// "refusal counters ..." warn pins move to the new codes. docs/runbook-logs.md
// and docs/agent-events.md cite `agent-events.shield.refusal_sampled`; S8 wants
// a runbook row naming the alert an agent can query.
//
// Hermetic: in-memory SQL doubles + fake agent-event store, no DATABASE_URL, no
// network. Traceable probes: TEST-NET IPs, a body marker, a credential marker.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, handleAgentEvent, type IngressConfig } from "../src/agent-events/service";
import { __resetShieldRefusalCountersForTests } from "../src/agent-events/shield";
import { checkJoinThrottle } from "../src/join/service";
import type { Sql } from "../src/sessions";
import {
  AUTH_THROTTLE_PER_MINUTE,
  WRITE_THROTTLE_PER_MINUTE,
  normalizeClientIp,
  throttle,
  type EnvWithThrottle,
  throttleGuard,
} from "../src/throttle";
import { makeFakeAgentDb, type FakeAgentDb } from "./helpers/fake-agent-ingress-db";

const IP_V4 = "192.0.2.44";
const IP_V6 = "2001:db8::99";
const SHIELD_IP = "198.51.100.9";
const BODY_PROBE = "throttle-429-body-probe-7f3a91";
const SHIELD_CREDENTIAL = "shield-telemetry-credential-probe";
const AUTH_BUCKET = "login-callback";
const WRITE_BUCKET = "logout";

function memorySql(opts: { count: number; wait?: number }): Sql {
  const tag = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const statement = strings.join("?");
    if (statement.includes("pg_advisory_xact_lock")) return [];
    if (statement.includes("SELECT count(*)")) return [{ n: opts.count, wait: opts.wait ?? 1 }];
    if (statement.includes("INSERT INTO web_throttle_hits")) return [];
    if (statement.includes("DELETE FROM web_throttle_hits")) return [];
    throw new Error("Unexpected throttle statement");
  }) as unknown as Sql & {
    begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  };
  (tag as { unsafe?: unknown }).unsafe = async () => [];
  tag.begin = (run) => run(tag as unknown as Sql);
  return tag as unknown as Sql;
}

/** First verdict transaction hits a held advisory lock (55P03); the prune then succeeds. */
function busyThenHealthySql(): Sql {
  let begins = 0;
  const tag = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const statement = strings.join("?");
    if (statement.includes("DELETE FROM web_throttle_hits")) return [];
    throw new Error("Unexpected busy-path statement");
  }) as unknown as Sql & {
    begin: (run: (tx: Sql) => Promise<unknown>) => Promise<unknown>;
  };
  (tag as { unsafe?: unknown }).unsafe = async () => [];
  tag.begin = (run) => {
    begins += 1;
    if (begins === 1) {
      const busy = new Error("throttle busy throttle-busy-marker") as Error & { code?: string };
      busy.code = "55P03";
      return Promise.reject(busy);
    }
    return run(tag as unknown as Sql);
  };
  return tag as unknown as Sql;
}

/** In-handler guard form (GET), on the real auth bucket + budget. */
function authProbe(store: () => Promise<Sql | null>, ip = IP_V4) {
  const app = new Hono<{ Bindings: EnvWithThrottle }>();
  app.get("/probe-auth", async (c) => {
    const limited = await throttleGuard(c, AUTH_BUCKET, AUTH_THROTTLE_PER_MINUTE);
    if (limited) return limited;
    return c.json({ limited: false });
  });
  return () =>
    app.request(
      "/probe-auth",
      { headers: { "cf-connecting-ip": ip, accept: "application/json" } },
      { THROTTLE_STORE: store } as unknown as EnvWithThrottle,
    );
}

/** Middleware form (POST), on the real write bucket + budget. */
function writeProbe(store: () => Promise<Sql | null>) {
  const app = new Hono<{ Bindings: EnvWithThrottle }>();
  app.post("/probe-write", throttle(WRITE_BUCKET, WRITE_THROTTLE_PER_MINUTE), (c) =>
    c.json({ limited: false }),
  );
  return (body?: BodyInit) =>
    app.request(
      "/probe-write",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": IP_V4,
          accept: "application/json",
          "content-type": "application/json",
        },
        body,
      },
      { THROTTLE_STORE: store } as unknown as EnvWithThrottle,
    );
}

let shieldKeySeq = 0;

function shieldCall(fake: FakeAgentDb, routePerMinute: number, keyPrefix: string) {
  const cfg: IngressConfig = {
    ...DEFAULT_CONFIG,
    enabled: true,
    callerAgentId: "telemetry-429-acceptance",
    lockWaitMs: 50,
    routePerMinute,
  };
  return (credential: string | null, ip: string | null) =>
    handleAgentEvent(
      fake.sql,
      cfg,
      { op: "create", idempotency_key: `${keyPrefix}-${++shieldKeySeq}` },
      credential,
      ip,
    );
}

let now = Date.now();
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Refill any time-based refusal-telemetry bucket between independent cases,
  // never within a flood: mirrors the CSP shed-suite clock discipline
  // (test/csp-sink-logging-acceptance.test.ts). Fixtures are fresh per test, so
  // the jump expires nothing under test.
  now += 3_600_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  __resetShieldRefusalCountersForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const warnCodes = () => warn.mock.calls.map((call: unknown[]) => String(call[0]));
const loggedText = () => JSON.stringify(warn.mock.calls);

describe("throttle 429 refusal telemetry (failing-first)", () => {
  it("auth-bucket refusal emits throttle.refused with route class + outcome and keeps the 429", async () => {
    const get = authProbe(async () => memorySql({ count: 999, wait: 42 }));
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(await res.json()).toMatchObject({ reason: "rate_limited", retry_after: 42 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("throttle.refused", {
      throttle: AUTH_BUCKET,
      outcome: "rate_limited",
    });
    const logged = loggedText();
    expect(logged).not.toContain(IP_V4);
    expect(logged).not.toContain(`${AUTH_BUCKET}:${IP_V4}`);
  });

  it("write-bucket refusal emits throttle.refused with route class + outcome and no body bytes", async () => {
    const post = writeProbe(async () => memorySql({ count: 999, wait: 17 }));
    const res = await post(JSON.stringify({ note: BODY_PROBE }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("17");
    expect(await res.json()).toMatchObject({ reason: "rate_limited", retry_after: 17 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("throttle.refused", {
      throttle: WRITE_BUCKET,
      outcome: "rate_limited",
    });
    const logged = loggedText();
    expect(logged).not.toContain(IP_V4);
    expect(logged).not.toContain(`${WRITE_BUCKET}:${IP_V4}`);
    expect(logged).not.toContain(BODY_PROBE);
  });

  it("IPv6 refusal names the route only", async () => {
    const get = authProbe(async () => memorySql({ count: 999, wait: 9 }), IP_V6);
    const res = await get();
    expect(res.status).toBe(429);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("throttle.refused", {
      throttle: AUTH_BUCKET,
      outcome: "rate_limited",
    });
    const logged = loggedText();
    expect(logged).not.toContain(IP_V6);
    const normalized = normalizeClientIp(IP_V6);
    expect(logged).not.toContain(normalized);
    expect(logged).not.toContain(`${AUTH_BUCKET}:${normalized}`);
  });

  it("busy-path guard refusal emits refusal telemetry, not the store-failure code", async () => {
    const get = authProbe(async () => busyThenHealthySql());
    const res = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("throttle.refused", {
      throttle: AUTH_BUCKET,
      outcome: "rate_limited",
    });
  });

  it("human refusal warns shed under flood and the shed signal carries the drop count", async () => {
    const post = writeProbe(async () => memorySql({ count: 999, wait: 5 }));
    const ATTEMPTS = 300;
    for (let i = 0; i < ATTEMPTS; i++) {
      const res = await post();
      expect(res.status).toBe(429);
    }
    const sheds = warn.mock.calls.filter((call: unknown[]) => call[0] === "throttle.refused.shed");
    expect(
      sheds.length,
      `expected a shed signal, saw codes: ${JSON.stringify(warnCodes())}`,
    ).toBeGreaterThan(0);
    for (const [, payload] of sheds) {
      expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual(["dropped"]);
      expect((payload as { dropped: number }).dropped).toBeGreaterThanOrEqual(1);
    }
    // Rate limiting proven: strictly fewer warns than refusals.
    expect(warn.mock.calls.length).toBeLessThan(ATTEMPTS);
    for (const [, payload] of warn.mock.calls.filter(
      (call: unknown[]) => call[0] === "throttle.refused",
    )) {
      expect(payload).toEqual({ throttle: WRITE_BUCKET, outcome: "rate_limited" });
    }
    const logged = loggedText();
    expect(logged).not.toContain(IP_V4);
    expect(logged).not.toContain(`${WRITE_BUCKET}:${IP_V4}`);
  });

  it("shield anonymous refusal emits agent-events.shield.refused with the sampler forced off", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const fake = makeFakeAgentDb();
    const call = shieldCall(fake, 1, "anon-emit");
    expect((await call(null, SHIELD_IP)).status).toBe(401);
    const refused = await call(null, SHIELD_IP);
    expect(refused.status).toBe(429);
    expect(refused.body.reason).toBe("rate_limited");
    expect(refused.body.retry_after).toBeGreaterThanOrEqual(1);
    expect(refused.body.request_id).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("agent-events.shield.refused", {
      bucket_class: "anonymous",
      outcome: "rate_limited",
    });
    const logged = loggedText();
    expect(logged).not.toContain(SHIELD_IP);
    expect(logged).not.toContain("ip:");
    expect(logged).not.toContain("anon-emit-");
  });

  it("shield credentialed refusal carries the class, never the credential", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const fake = makeFakeAgentDb();
    const call = shieldCall(fake, 1, "cred-emit");
    expect((await call(SHIELD_CREDENTIAL, SHIELD_IP)).status).toBe(401);
    const refused = await call(SHIELD_CREDENTIAL, SHIELD_IP);
    expect(refused.status).toBe(429);
    expect(refused.body.reason).toBe("rate_limited");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("agent-events.shield.refused", {
      bucket_class: "credential",
      outcome: "rate_limited",
    });
    const logged = loggedText();
    expect(logged).not.toContain(SHIELD_CREDENTIAL);
    expect(logged).not.toContain(SHIELD_IP);
    expect(logged).not.toContain("cred-emit-");
  });

  it("shield refusal warns shed under flood", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const fake = makeFakeAgentDb();
    const call = shieldCall(fake, 1, "shed-flood");
    expect((await call(null, SHIELD_IP)).status).toBe(401);
    const ATTEMPTS = 299;
    for (let i = 0; i < ATTEMPTS; i++) {
      const refused = await call(null, SHIELD_IP);
      expect(refused.status).toBe(429);
      expect(refused.body.reason).toBe("rate_limited");
    }
    const sheds = warn.mock.calls.filter(
      (call: unknown[]) => call[0] === "agent-events.shield.refused.shed",
    );
    expect(
      sheds.length,
      `expected a shed signal, saw codes: ${JSON.stringify(warnCodes())}`,
    ).toBeGreaterThan(0);
    for (const [, payload] of sheds) {
      expect(Object.keys(payload as Record<string, unknown>).sort()).toEqual(["dropped"]);
      expect((payload as { dropped: number }).dropped).toBeGreaterThanOrEqual(1);
    }
    expect(warn.mock.calls.length).toBeLessThan(ATTEMPTS);
    for (const [, payload] of warn.mock.calls.filter(
      (call: unknown[]) => call[0] === "agent-events.shield.refused",
    )) {
      expect(payload).toEqual({ bucket_class: "anonymous", outcome: "rate_limited" });
    }
    const logged = loggedText();
    expect(logged).not.toContain(SHIELD_IP);
    expect(logged).not.toContain("shed-flood-");
  });

  it("refusal and store-failure telemetry are distinguishable by stable code", async () => {
    const nullVerdict = await checkJoinThrottle(null, `${AUTH_BUCKET}:${IP_V4}`, 10);
    expect(nullVerdict).toEqual({ limited: false });
    const failGet = authProbe(async () => {
      throw new Error("telemetry-code-probe-store-failure");
    });
    expect((await failGet()).status).toBe(200);
    const refuseGet = authProbe(async () => memorySql({ count: 999, wait: 11 }));
    const refused = await refuseGet();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("11");
    expect(warn).toHaveBeenCalledTimes(3);
    const codes = warnCodes();
    expect(codes).toContain("Throttle store unavailable; allowing the request.");
    expect(codes).toContain("Throttle store failed; allowing the request.");
    expect(codes).toContain("throttle.refused");
    expect(new Set(codes).size).toBe(3);
    const logged = loggedText();
    expect(logged).not.toContain(IP_V4);
    expect(logged).not.toContain("telemetry-code-probe-store-failure");
  });
});

describe("throttle 429 behavior controls (green on base, must stay green)", () => {
  it("an admitted human request emits no refusal telemetry", async () => {
    const get = authProbe(async () => memorySql({ count: 0 }));
    const res = await get();
    expect(res.status).toBe(200);
    expect(warn).not.toHaveBeenCalled();
  });

  it("an admitted shield hit emits no refusal telemetry", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const fake = makeFakeAgentDb();
    const call = shieldCall(fake, 1, "admit-quiet");
    expect((await call(null, SHIELD_IP)).status).toBe(401);
    expect(warn).not.toHaveBeenCalled();
  });

  it("throwing-store allow keeps its exact warn and emits no refusal code", async () => {
    const get = authProbe(async () => {
      throw new Error("telemetry-control-probe-failure");
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Throttle store failed; allowing the request.", {
      throttle: AUTH_BUCKET,
      exception: "Error",
    });
    const logged = loggedText();
    expect(logged).not.toContain(IP_V4);
    expect(logged).not.toContain("telemetry-control-probe-failure");
  });
});
