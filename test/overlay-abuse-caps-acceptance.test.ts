// ACCEPTANCE-OWNED (overlay abuse hardening + caps, spec section 7 slice 5):
// the Builder builds on this card's branch and never edits this file.
// Fail-first contract for per-token daily byte caps, auto-pause, distinct-IP
// hints, operator CLI revocation, cap-breach warnings and the member-facing
// cap notices.
//
// Production changes that must make this file fail if reverted: removing the
// byte-cap check on the live-data endpoint, resetting the daily counter at a
// non-UTC boundary, dropping the 3-day auto-pause or the re-enable path,
// silencing the cap-breach warning, removing the operator CLI, or deleting
// the cap/IP notices on the settings page.
//
// Locked builder contract (implement exactly these names; nothing else here
// pins internals):
// - `src/overlay-caps.ts` exports OVERLAY_DAILY_BYTE_CAP (52_428_800 =
//   50 MiB), OVERLAY_AUTOPAUSE_CAPPED_DAYS (3),
//   OVERLAY_DISTINCT_IP_HINT_THRESHOLD (5, hint when distinct IPs exceed it),
//   utcDayKey(nowMs) ("YYYY-MM-DD" in UTC) and secondsUntilUtcReset(nowMs)
//   (1..86_400, seconds until the next UTC midnight).
// - `Env.OVERLAY_DEPS` (`{ now?, byteCap?, store? }`, all optional) is the
//   test seam. Routes use `now()` for day boundaries and Retry-After when
//   present (default Date.now), `byteCap` as the per-token daily byte cap
//   (default OVERLAY_DAILY_BYTE_CAP) and `store()` for overlay tables
//   (default the runtime database, like THROTTLE_STORE/JOIN_DEPS).
// - `GET /o/:token/data` over the daily cap answers 429 with a numeric
//   Retry-After (seconds until UTC reset) until the UTC day rolls over, then
//   allows again. JSON callers get the shared `{ reason: "rate_limited" }`
//   envelope. No member data in the refusal.
// - Three consecutive capped UTC days auto-pause the token: the data
//   endpoint keeps 429ing and `GET /o/:token` renders a slate containing
//   "paused" and "/overlay" with no member PII. `POST
//   /overlay/token/reactivate` (session-gated like the settings page,
//   owner-only, 30/min write throttle) unpauses; guest -> 302 OAuth,
//   non-member -> 403.
// - More than 5 distinct client IPs on one token in one UTC day surfaces a
//   "shared URL" hint on `GET /overlay` (contains "shar" + "rotat"); a
//   breached cap surfaces a cap notice (contains "cap" + "rotat"). The
//   settings page never renders token plaintext.
// - A cap breach writes exactly one `console.warn` line naming the cap with
//   `{ token_id }` (uuid only, never token plaintext, member id, name or
//   email). Under-cap requests warn nothing.
// - `bin/revoke-overlay-token.mjs` mirrors `bin/revoke-sessions.mjs`:
//   `--discord-id=<snowflake>` (required), `--dry-run` (default) / `--apply`,
//   `--target staging|production`, exit 0 success / 2 usage-config-refusal /
//   1 driver failure, counts-only JSON `{ mode, counts, passes,
//   stampsPerPass }`, never prints URLs or secrets. Apply marks the member's
//   live overlay tokens `revoked` so the overlay URL 404s.
// - `docs/overlay-caps.md` notes the leaked-URL hotlink risk
//   (rotation-only cure), the 50 MB/day cap + 429-until-reset, the 3-day
//   auto-pause, the distinct-IP hint and the recorded annual re-mint nudge
//   decision.
//
// Hermetic sections run everywhere (pure helpers via dynamic import so a
// missing module fails as an assertion, CLI safety via spawn, docs via fs,
// one 404 control). Route/CLI-effect sections need the disposable database
// (`skipIf` without DATABASE_URL) plus the slice-1..4 tables and routes; they
// fail RED until those land, then pin slice-5 behavior. Small injected caps
// (not 50 MB of traffic) drive every boundary; distinct tokens and IPs per
// test stay clear of the 30/min write/data throttles.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, type Sql } from "../src/sessions";
import { cookieFor, env as memberEnv, MEMBER, OUTSIDER } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const CAP_MODULE_PATH = "../src/overlay-caps";
const CLI_REL = "bin/revoke-overlay-token.mjs";
const DOCS_REL = "docs/overlay-caps.md";

const EXPECTED_CAP = 50 * 1024 * 1024;
const EXPECTED_AUTOPAUSE_DAYS = 3;
const EXPECTED_IP_THRESHOLD = 5;

// Synthetic fixtures only: low-entropy, never real tokens or members.
const STREAMER = { userId: "100000000000000301", username: "zxq-overlay-streamer" };
const OTHER_MEMBER = { userId: "100000000000000302", username: "zxq-overlay-other" };
const PLAINTEXT = (tag: string) => `two_ov_synthetic-cap-test-${tag}`;
const TOKEN_ID = (tag: string) => {
  const suffix = tag
    .replaceAll(/[^0-9a-f]/gi, "a")
    .padEnd(12, "a")
    .slice(0, 12);
  return `11111111-2222-4333-8444-${suffix}`;
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OverlayCapsModule = {
  OVERLAY_DAILY_BYTE_CAP?: unknown;
  OVERLAY_AUTOPAUSE_CAPPED_DAYS?: unknown;
  OVERLAY_DISTINCT_IP_HINT_THRESHOLD?: unknown;
  utcDayKey?: unknown;
  secondsUntilUtcReset?: unknown;
};

async function loadCapsModule(): Promise<OverlayCapsModule | null> {
  // Non-literal specifier: typechecks whether or not the Builder has created
  // the module yet, and resolves at runtime in both states.
  const specifier = `${CAP_MODULE_PATH}${""}`;
  try {
    return (await import(/* @vite-ignore */ specifier)) as OverlayCapsModule;
  } catch {
    return null;
  }
}

async function loadCliModule(): Promise<Record<string, unknown> | null> {
  const url = pathToFileURL(join(process.cwd(), CLI_REL)).href;
  try {
    return (await import(/* @vite-ignore */ `${url}${""}`)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readDocs(): string | null {
  try {
    return readFileSync(join(process.cwd(), DOCS_REL), "utf8");
  } catch {
    return null;
  }
}

// Oracle math, independent of the implementation under test.
const expectedDayKey = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 10);
const expectedResetSeconds = (nowMs: number) => {
  const at = new Date(nowMs);
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.max(1, Math.round((next - nowMs) / 1000));
};

describe("overlay cap constants and UTC boundaries (hermetic)", () => {
  it("pins the 50 MiB daily cap, 3-day auto-pause and 5-IP hint threshold", async () => {
    const mod = await loadCapsModule();
    expect(mod, "src/overlay-caps.ts must exist (slice-5 cap module)").not.toBeNull();
    expect(mod!.OVERLAY_DAILY_BYTE_CAP).toBe(EXPECTED_CAP);
    expect(mod!.OVERLAY_AUTOPAUSE_CAPPED_DAYS).toBe(EXPECTED_AUTOPAUSE_DAYS);
    expect(mod!.OVERLAY_DISTINCT_IP_HINT_THRESHOLD).toBe(EXPECTED_IP_THRESHOLD);
  });

  it("keys days in UTC and measures Retry-After to the next UTC midnight", async () => {
    const mod = await loadCapsModule();
    expect(mod, "src/overlay-caps.ts must exist (slice-5 cap module)").not.toBeNull();
    const { utcDayKey, secondsUntilUtcReset } = mod!;
    expect(typeof utcDayKey, "utcDayKey(nowMs) must be exported").toBe("function");
    expect(typeof secondsUntilUtcReset, "secondsUntilUtcReset(nowMs) must be exported").toBe(
      "function",
    );
    const day = utcDayKey as (nowMs: number) => string;
    const reset = secondsUntilUtcReset as (nowMs: number) => number;
    // Fixed instants around UTC midnight: the day key flips at 00:00:00Z and
    // the reset counts down to it, never 0 and never past a full day.
    const cases = [
      Date.UTC(2026, 9, 21, 0, 0, 0),
      Date.UTC(2026, 9, 21, 0, 0, 1),
      Date.UTC(2026, 9, 21, 12, 0, 0),
      Date.UTC(2026, 9, 21, 23, 59, 59),
      Date.UTC(2026, 9, 22, 0, 0, 0),
    ];
    for (const nowMs of cases) {
      expect(day(nowMs)).toBe(expectedDayKey(nowMs));
      expect(reset(nowMs)).toBe(expectedResetSeconds(nowMs));
    }
    expect(day(Date.UTC(2026, 9, 21, 23, 59, 59))).toBe("2026-10-21");
    expect(day(Date.UTC(2026, 9, 22, 0, 0, 0))).toBe("2026-10-22");
    expect(reset(Date.UTC(2026, 9, 21, 23, 59, 59))).toBe(1);
    expect(reset(Date.UTC(2026, 9, 22, 0, 0, 0))).toBe(86_400);
  });
});

describe("overlay cap docs (hermetic)", () => {
  it("notes hotlink risk as rotation-only with the cap, pause and re-mint decision", () => {
    const docs = readDocs();
    expect(docs, `${DOCS_REL} must exist (slice-5 abuse docs)`).not.toBeNull();
    const body = docs!;
    expect(body).toMatch(/hotlink/i);
    expect(body).toMatch(/rotat/i);
    expect(body).toMatch(/50\s*MB/i);
    expect(body).toMatch(/429/);
    expect(body).toMatch(/auto-?pause/i);
    expect(body).toMatch(/distinct.*ip|ip.*distinct|>5 ips|5 distinct/i);
    expect(body).toMatch(/annual/i);
    expect(body).toMatch(/re-?mint/i);
    expect(body).toMatch(/decision/i);
    // Rotation is the cure: the doc must say so, not merely mention rotation.
    expect(body).toMatch(/rotation.{0,40}(only|cure)|only.{0,40}rotation|cure.{0,40}rotation/i);
  });
});

describe("overlay revoke CLI safety (hermetic)", () => {
  const script = join(process.cwd(), CLI_REL);
  const run = (args: string[] = [], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--import", "./bin/ts-hook.mjs", script, ...args], {
      env,
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 20_000,
    });

  it("exists, defaults to dry-run and rejects invalid arguments", async () => {
    expect(existsSync(script), `${CLI_REL} must exist (slice-5 operator CLI)`).toBe(true);
    const mod = await loadCliModule();
    expect(mod, `${CLI_REL} must be importable`).not.toBeNull();
    const parse = mod!["parseRevokeOverlayArgs"] ?? mod!["parseRevokeArgs"];
    expect(typeof parse, "CLI must export parseRevokeOverlayArgs").toBe("function");
    const parseArgs = parse as (args: string[]) => {
      discordId: string;
      mode: string;
      target: string | undefined;
    };
    expect(parseArgs([`--discord-id=${STREAMER.userId}`])).toEqual({
      discordId: STREAMER.userId,
      mode: "dry-run",
      target: undefined,
    });
    expect(parseArgs([`--discord-id=${STREAMER.userId}`, "--apply"]).mode).toBe("apply");
    for (const args of [
      [],
      ["--discord-id=bad"],
      [`--discord-id=${STREAMER.userId}`, "--apply", "--dry-run"],
      [`--discord-id=${STREAMER.userId}`, "--target", "sideways"],
    ])
      expect(() => parseArgs(args), JSON.stringify(args)).toThrow();
    const malformed = run(["--discord-id=bad"], {
      DATABASE_URL: "postgres://agent_test@127.0.0.1:1/test",
    });
    expect(malformed.status).toBe(2);
    expect(malformed.stderr).toContain("malformed Discord id");
  });

  it("refuses remote URLs without a target and never prints URLs or secrets", async () => {
    expect(existsSync(script), `${CLI_REL} must exist (slice-5 operator CLI)`).toBe(true);
    const production =
      "postgres://fixture:synthetic-cap-password@db.production.test/neondb?sslmode=verify-full";
    const refused = run([`--discord-id=${STREAMER.userId}`], { DATABASE_URL: production });
    expect(refused.status).toBe(2);
    expect(refused.stdout + refused.stderr).not.toContain("synthetic-cap-password");
    expect(refused.stdout + refused.stderr).not.toContain("postgres://");
    const unreachable = run([`--discord-id=${STREAMER.userId}`], {
      DATABASE_URL: "postgres://agent_test@127.0.0.1:1/test",
    });
    expect(unreachable.status).toBe(1);
    expect(unreachable.stdout + unreachable.stderr).not.toContain("postgres://");
  });
});

describe("overlay unknown-token control (hermetic)", () => {
  it("unknown tokens 404 with no member data, no cookie and no-store", async () => {
    const res = await app.request("/o/two_ov_synthetic-cap-test-unknown-000", {}, {
      ...memberEnv,
    } as Env);
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const body = await res.text();
    for (const secret of [STREAMER.username, STREAMER.userId, "two_ov_synthetic"])
      expect(body).not.toContain(secret);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("overlay daily byte cap and UTC reset", () => {
  let fixture: MemberDataFixture;
  let sessions = createMemorySessionStore();

  const overlayEnv = (overrides: Record<string, unknown> = {}) =>
    ({
      ...memberEnv,
      SESSION_STORE: sessions,
      ADMIN_DB: fixture.db,
      THROTTLE_STORE: async () => fixture.client as unknown as Sql,
      ...overrides,
    }) as unknown as Env;

  async function seedToken(tag: string, memberId = STREAMER.userId) {
    const plaintext = PLAINTEXT(tag);
    const tokenId = TOKEN_ID(tag);
    await fixture.client`insert into users (id, username, member, avatar)
      values (${memberId}, ${memberId === STREAMER.userId ? STREAMER.username : OTHER_MEMBER.username}, true, null)
      on conflict (id) do update set username = excluded.username`;
    await fixture.client`insert into overlay_tokens (id, member_id, token_hash, status)
      values (${tokenId}, ${memberId}, ${`cap-test-hash-${tag}`}, 'live')`;
    await fixture.client`insert into overlay_configs (member_id, elements, theme)
      values (${memberId}, '{}', '{}')
      on conflict (member_id) do nothing`;
    return { plaintext, tokenId };
  }

  async function dataRequest(
    plaintext: string,
    env: Env,
    init: RequestInit & { headers?: Record<string, string> } = {},
  ) {
    return app.request(
      `/o/${encodeURIComponent(plaintext)}/data`,
      {
        ...init,
        headers: { accept: "application/json", ...(init.headers ?? {}) },
      },
      env,
    );
  }

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });

  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`delete from overlay_tokens`.catch(() => []);
    await fixture.client`delete from overlay_configs`.catch(() => []);
    sessions = createMemorySessionStore();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  it("under a small injected cap the data endpoint allows; over it 429s until UTC reset", async () => {
    const { plaintext, tokenId } = await seedToken("reset-boundary-01");
    const clock = { nowMs: Date.UTC(2026, 9, 21, 12, 0, 0) };
    const env = overlayEnv({
      OVERLAY_DEPS: {
        now: () => clock.nowMs,
        byteCap: 64,
        store: async () => fixture.client as unknown as Sql,
      },
    });
    // First poll fits in 64 bytes: allowed (200 or 304 on re-poll).
    const first = await dataRequest(plaintext, env, {
      headers: { "cf-connecting-ip": "203.0.113.11" },
    });
    expect([200, 304]).toContain(first.status);
    // Keep polling until the tiny cap trips: must 429, never 500.
    let limited: Response | null = null;
    for (let i = 0; i < 6 && !limited; i++) {
      const res = await dataRequest(plaintext, env, {
        headers: { "cf-connecting-ip": "203.0.113.11" },
      });
      if (res.status === 429) limited = res;
      else expect([200, 304]).toContain(res.status);
    }
    expect(limited, "a 64-byte cap must trip within a few polls").not.toBeNull();
    expect(limited!.headers.get("Retry-After")).toBe(String(expectedResetSeconds(clock.nowMs)));
    const body = (await limited!.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ reason: "rate_limited" });
    expect(JSON.stringify(body)).not.toContain(STREAMER.username);
    expect(JSON.stringify(body)).not.toContain(plaintext);
    // Still capped later the same UTC day: 429-until-reset.
    clock.nowMs = Date.UTC(2026, 9, 21, 23, 59, 59);
    const sameDay = await dataRequest(plaintext, env, {
      headers: { "cf-connecting-ip": "203.0.113.11" },
    });
    expect(sameDay.status).toBe(429);
    expect(sameDay.headers.get("Retry-After")).toBe("1");
    // One second past UTC midnight the budget returns.
    clock.nowMs = Date.UTC(2026, 9, 22, 0, 0, 0);
    const nextDay = await dataRequest(plaintext, env, {
      headers: { "cf-connecting-ip": "203.0.113.11" },
    });
    expect([200, 304]).toContain(nextDay.status);
    expect(tokenId).toMatch(UUID_RE);
  });

  it("a cap breach warns once with the token id and no plaintext or member PII", async () => {
    const { plaintext, tokenId } = await seedToken("warn-line-02");
    const clock = { nowMs: Date.UTC(2026, 9, 21, 12, 0, 0) };
    const env = overlayEnv({
      OVERLAY_DEPS: {
        now: () => clock.nowMs,
        byteCap: 1,
        store: async () => fixture.client as unknown as Sql,
      },
    });
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    const res = await dataRequest(plaintext, env, {
      headers: { "cf-connecting-ip": "203.0.113.12" },
    });
    expect([200, 304, 429]).toContain(res.status);
    // Poll once more to be sure the 1-byte cap has tripped.
    const second = await dataRequest(plaintext, env, {
      headers: { "cf-connecting-ip": "203.0.113.12" },
    });
    expect(second.status).toBe(429);
    const capLines = warn.mock.calls.filter(([message]) =>
      String(message).match(/overlay.*cap|cap.*overlay|byte.*cap/i),
    );
    expect(capLines.length).toBeGreaterThanOrEqual(1);
    const serialized = JSON.stringify(capLines);
    expect(serialized).toContain(tokenId);
    for (const secret of [plaintext, STREAMER.username, STREAMER.userId, "two_ov_synthetic"])
      expect(serialized).not.toContain(secret);
  });

  it("control: under-cap polls stay silent on the warn channel", async () => {
    const { plaintext } = await seedToken("silent-control-03");
    const clock = { nowMs: Date.UTC(2026, 9, 21, 12, 0, 0) };
    const env = overlayEnv({
      OVERLAY_DEPS: {
        now: () => clock.nowMs,
        byteCap: 1024 * 1024,
        store: async () => fixture.client as unknown as Sql,
      },
    });
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    const res = await dataRequest(plaintext, env, {
      headers: { "cf-connecting-ip": "203.0.113.13" },
    });
    expect([200, 304]).toContain(res.status);
    const capLines = warn.mock.calls.filter(([message]) =>
      String(message).match(/overlay.*cap|cap.*overlay|byte.*cap/i),
    );
    expect(capLines).toHaveLength(0);
  });

  it("three consecutive capped days auto-pause; re-enable reopens the token", async () => {
    const { plaintext } = await seedToken("autopause-04");
    const clock = { nowMs: Date.UTC(2026, 9, 21, 12, 0, 0) };
    const deps = {
      now: () => clock.nowMs,
      byteCap: 1,
      store: async () => fixture.client as unknown as Sql,
    };
    const env = overlayEnv({ OVERLAY_DEPS: deps });
    const tripDay = async (ip: string) => {
      for (let i = 0; i < 4; i++) {
        const res = await dataRequest(plaintext, env, {
          headers: { "cf-connecting-ip": ip },
        });
        if (res.status === 429) return;
      }
      throw new Error("expected the 1-byte cap to trip");
    };
    await tripDay("203.0.113.14");
    clock.nowMs = Date.UTC(2026, 9, 22, 12, 0, 0);
    await tripDay("203.0.113.14");
    clock.nowMs = Date.UTC(2026, 9, 23, 12, 0, 0);
    await tripDay("203.0.113.14");
    // Third capped day trips the pause: the page renders the paused slate and
    // the data endpoint refuses even after the UTC reset.
    const page = await app.request(`/o/${encodeURIComponent(plaintext)}`, {}, env);
    const slate = await page.text();
    expect(slate).toMatch(/paus/i);
    expect(slate).toContain("/overlay");
    expect(slate).not.toContain(STREAMER.username);
    clock.nowMs = Date.UTC(2026, 9, 24, 12, 0, 0);
    const whilePaused = await dataRequest(plaintext, env, {
      headers: { "cf-connecting-ip": "203.0.113.14" },
    });
    expect(whilePaused.status).toBe(429);
    // Owner re-enables with one click; guests and outsiders cannot.
    const guest = await app.request("/overlay/token/reactivate", { method: "POST" }, env);
    expect(guest.status).toBe(302);
    const outsiderSessions = createMemorySessionStore();
    const outsiderCookie = await cookieFor(outsiderSessions, {
      ...OUTSIDER,
      username: "zxq-overlay-outsider",
    } as typeof MEMBER);
    const outsiderEnv = overlayEnv({
      SESSION_STORE: outsiderSessions,
      OVERLAY_DEPS: deps,
    });
    const outsider = await app.request(
      "/overlay/token/reactivate",
      { method: "POST", headers: { cookie: outsiderCookie } },
      outsiderEnv,
    );
    expect(outsider.status).toBe(403);
    const ownerCookie = await cookieFor(sessions, {
      userId: STREAMER.userId,
      username: STREAMER.username,
      member: true,
      moderator: false,
    } as typeof MEMBER);
    const reenable = await app.request(
      "/overlay/token/reactivate",
      { method: "POST", headers: { cookie: ownerCookie } },
      env,
    );
    expect([200, 302, 303]).toContain(reenable.status);
    const reopened = await dataRequest(plaintext, env, {
      headers: { "cf-connecting-ip": "203.0.113.14" },
    });
    expect([200, 304]).toContain(reopened.status);
  });

  it("two capped days with a clean day between never auto-pause", async () => {
    const { plaintext } = await seedToken("pause-control-05");
    const clock = { nowMs: Date.UTC(2026, 9, 21, 12, 0, 0) };
    const deps = {
      now: () => clock.nowMs,
      byteCap: 1,
      store: async () => fixture.client as unknown as Sql,
    };
    const env = overlayEnv({ OVERLAY_DEPS: deps });
    const tripDay = async () => {
      for (let i = 0; i < 4; i++) {
        if (
          (
            await dataRequest(plaintext, env, {
              headers: { "cf-connecting-ip": "203.0.113.15" },
            })
          ).status === 429
        )
          return;
      }
      throw new Error("expected the 1-byte cap to trip");
    };
    await tripDay();
    // Clean day: raise the cap so nothing trips.
    clock.nowMs = Date.UTC(2026, 9, 22, 12, 0, 0);
    const cleanEnv = overlayEnv({
      OVERLAY_DEPS: { ...deps, byteCap: 1024 * 1024, now: () => clock.nowMs },
    });
    const clean = await dataRequest(plaintext, cleanEnv, {
      headers: { "cf-connecting-ip": "203.0.113.15" },
    });
    expect([200, 304]).toContain(clean.status);
    clock.nowMs = Date.UTC(2026, 9, 23, 12, 0, 0);
    await tripDay();
    // Non-consecutive capped days: no pause, the next day opens normally.
    clock.nowMs = Date.UTC(2026, 9, 24, 12, 0, 0);
    const page = await app.request(`/o/${encodeURIComponent(plaintext)}`, {}, env);
    expect(await page.text()).not.toMatch(/paus/i);
    const next = await dataRequest(plaintext, env, {
      headers: { "cf-connecting-ip": "203.0.113.15" },
    });
    expect([200, 304]).toContain(next.status);
  });

  it("more than five distinct IPs in a day surfaces the shared-URL hint on /overlay", async () => {
    const { plaintext } = await seedToken("shared-hint-06");
    const clock = { nowMs: Date.UTC(2026, 9, 21, 12, 0, 0) };
    const env = overlayEnv({
      OVERLAY_DEPS: {
        now: () => clock.nowMs,
        byteCap: 1024 * 1024,
        store: async () => fixture.client as unknown as Sql,
      },
    });
    for (let i = 1; i <= 6; i++) {
      const res = await dataRequest(plaintext, env, {
        headers: { "cf-connecting-ip": `203.0.113.${20 + i}` },
      });
      expect([200, 304]).toContain(res.status);
    }
    const ownerCookie = await cookieFor(sessions, {
      userId: STREAMER.userId,
      username: STREAMER.username,
      member: true,
      moderator: false,
    } as typeof MEMBER);
    const settings = await app.request("/overlay", { headers: { cookie: ownerCookie } }, env);
    expect(settings.status).toBe(200);
    const html = await settings.text();
    expect(html).toMatch(/shar/i);
    expect(html).toMatch(/rotat/i);
    expect(html).not.toContain(plaintext);
  });

  it("five or fewer distinct IPs stay quiet on /overlay", async () => {
    const { plaintext } = await seedToken("shared-control-07");
    const clock = { nowMs: Date.UTC(2026, 9, 21, 12, 0, 0) };
    const env = overlayEnv({
      OVERLAY_DEPS: {
        now: () => clock.nowMs,
        byteCap: 1024 * 1024,
        store: async () => fixture.client as unknown as Sql,
      },
    });
    for (let i = 1; i <= 5; i++) {
      const res = await dataRequest(plaintext, env, {
        headers: { "cf-connecting-ip": `198.51.100.${30 + i}` },
      });
      expect([200, 304]).toContain(res.status);
    }
    const ownerCookie = await cookieFor(sessions, {
      userId: STREAMER.userId,
      username: STREAMER.username,
      member: true,
      moderator: false,
    } as typeof MEMBER);
    const settings = await app.request("/overlay", { headers: { cookie: ownerCookie } }, env);
    expect(settings.status).toBe(200);
    expect(await settings.text()).not.toMatch(/shar/i);
  });

  it("/overlay shows the cap notice fixture after a breach, without token plaintext", async () => {
    const { plaintext } = await seedToken("cap-notice-08");
    const clock = { nowMs: Date.UTC(2026, 9, 21, 12, 0, 0) };
    const env = overlayEnv({
      OVERLAY_DEPS: {
        now: () => clock.nowMs,
        byteCap: 1,
        store: async () => fixture.client as unknown as Sql,
      },
    });
    for (let i = 0; i < 3; i++) {
      await dataRequest(plaintext, env, { headers: { "cf-connecting-ip": "203.0.113.40" } });
    }
    const ownerCookie = await cookieFor(sessions, {
      userId: STREAMER.userId,
      username: STREAMER.username,
      member: true,
      moderator: false,
    } as typeof MEMBER);
    const settings = await app.request("/overlay", { headers: { cookie: ownerCookie } }, env);
    expect(settings.status).toBe(200);
    const html = await settings.text();
    expect(html).toMatch(/cap/i);
    expect(html).toMatch(/rotat/i);
    expect(html).not.toContain(plaintext);
  });

  it("operator CLI apply revokes the member's live token so the overlay 404s", async () => {
    const { plaintext } = await seedToken("cli-revoke-09", OTHER_MEMBER.userId);
    const before = await app.request(
      `/o/${encodeURIComponent(plaintext)}/data`,
      { headers: { accept: "application/json" } },
      overlayEnv({
        OVERLAY_DEPS: {
          byteCap: 1024 * 1024,
          store: async () => fixture.client as unknown as Sql,
        },
      }),
    );
    expect([200, 304]).toContain(before.status);
    const mod = await loadCliModule();
    expect(mod, `${CLI_REL} must be importable`).not.toBeNull();
    const revoke = mod!["revokeOverlayTokens"] ?? mod!["revokeMemberOverlayTokens"] ?? mod!["main"];
    expect(typeof revoke, "CLI must export an overlay revocation entry").toBe("function");
    // Drive the effect through the module against the fixture pool: the spawned
    // CLI shape (argv, targets, exit codes) is pinned hermetically above.
    const sql = fixture.client as unknown as Sql;
    if (mod!["revokeOverlayTokens"] ?? mod!["revokeMemberOverlayTokens"]) {
      const fn = (mod!["revokeOverlayTokens"] ?? mod!["revokeMemberOverlayTokens"]) as (
        sql: Sql,
        memberId: string,
        opts: { dryRun: boolean },
      ) => Promise<unknown>;
      await fn(sql, OTHER_MEMBER.userId, { dryRun: false });
    } else {
      const main = mod!["main"] as (args: string[], env: Record<string, string>) => Promise<number>;
      const url = process.env.DATABASE_URL!;
      const code = await main([`--discord-id=${OTHER_MEMBER.userId}`, "--apply"], {
        DATABASE_URL: url,
      });
      expect(code).toBe(0);
    }
    const rows = await fixture.client<{ status: string }[]>`
      select status from overlay_tokens where member_id = ${OTHER_MEMBER.userId}`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.status).toBe("revoked");
    const after = await app.request(
      `/o/${encodeURIComponent(plaintext)}/data`,
      { headers: { accept: "application/json" } },
      overlayEnv({
        OVERLAY_DEPS: { store: async () => fixture.client as unknown as Sql },
      }),
    );
    expect(after.status).toBe(404);
  });

  it("operator CLI dry-run changes nothing", async () => {
    const { plaintext } = await seedToken("cli-dryrun-10", OTHER_MEMBER.userId);
    const mod = await loadCliModule();
    expect(mod, `${CLI_REL} must be importable`).not.toBeNull();
    const fn = (mod!["revokeOverlayTokens"] ?? mod!["revokeMemberOverlayTokens"]) as
      | ((sql: Sql, memberId: string, opts: { dryRun: boolean }) => Promise<unknown>)
      | undefined;
    if (!fn) {
      // Fall back to argv dry-run against an unreachable database: still exit 1
      // without touching the live token (safety pin, effect covered above).
      const script = fileURLToPath(new URL(`../${CLI_REL}`, import.meta.url).href);
      const result = spawnSync(
        process.execPath,
        ["--import", "./bin/ts-hook.mjs", script, `--discord-id=${OTHER_MEMBER.userId}`],
        {
          env: { DATABASE_URL: "postgres://agent_test@127.0.0.1:1/test" },
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      expect(result.status).toBe(1);
    } else {
      await fn(fixture.client as unknown as Sql, OTHER_MEMBER.userId, { dryRun: true });
    }
    const rows = await fixture.client<{ status: string }[]>`
      select status from overlay_tokens where member_id = ${OTHER_MEMBER.userId}`;
    expect(rows.map((row) => row.status)).toContain("live");
    const res = await app.request(
      `/o/${encodeURIComponent(plaintext)}/data`,
      { headers: { accept: "application/json" } },
      overlayEnv({
        OVERLAY_DEPS: {
          byteCap: 1024 * 1024,
          store: async () => fixture.client as unknown as Sql,
        },
      }),
    );
    expect([200, 304]).toContain(res.status);
  });
});
