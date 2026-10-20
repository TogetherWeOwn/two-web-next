// route-inventory: POST /admin/queue/failed/:id/redispatch
// Acceptance: the two I/O-free redispatch refusals (non-operator 403,
// malformed-id/query 422) are decided before the shared admin-write
// throttle. Under an exhausted budget they still refuse 403/422 with zero
// throttle spend — never 429. The wire cap still runs first (413 before any
// spend); operator dispatch, dedupe, refusal receipts and the operator's
// exhausted-budget 429 are unchanged. Hermetic: in-memory sessions, a
// counting throttle Sql double, redispatch-deps spies, a mocked audit
// client and a fail-if-touched Db double; no DATABASE_URL is connected.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { recordAccess } from "../src/admin/store";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import type { Db } from "../src/db/index";
import type { FailedJobReplayCandidate } from "../src/jobs/preview";
import { STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore, type Sql } from "../src/sessions";
import { WRITE_THROTTLE_PER_MINUTE, type EnvWithThrottle } from "../src/throttle";
import { cookieFor, env, MEMBER, MODERATOR } from "./helpers/member-data";
import { withThrottleTx } from "./helpers/throttle-tx-double";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/admin/store")>()),
  recordAccess: vi.fn(),
}));

const pg = vi.hoisted(() => ({ audit: vi.fn(), end: vi.fn(), factory: vi.fn() }));
vi.mock("postgres", () => ({ default: pg.factory }));

const OTHER_MODERATOR = {
  userId: "100000000000000222",
  username: "other-moderator",
  member: true,
  moderator: true,
} as const;

const replayCandidate: FailedJobReplayCandidate = {
  preview: {
    failure: { id: 7, kind: "sync-event", failedAt: "2026-10-07T00:00:00.000Z" },
    observedAt: "2026-10-07T01:00:00.000Z",
    disposition: { action: "replay", reason: "source is still dirty; fresh dispatch" },
  },
  eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
};

const keepCandidate: FailedJobReplayCandidate = {
  preview: {
    ...replayCandidate.preview,
    disposition: {
      action: "keep",
      reason: "definitive refusal; operator recovery required, preserve dead row and snapshot",
    },
  },
  eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
};

const dbTouched = vi.fn(() => {
  throw new Error("fixture must not query a DB");
});
const db = {
  select: dbTouched,
  insert: dbTouched,
  update: dbTouched,
  delete: dbTouched,
  transaction: dbTouched,
  execute: dbTouched,
} as unknown as Db;

function throttleFixture(initial: number) {
  let hits = initial;
  const buckets: unknown[] = [];
  const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    buckets.push(...values);
    if (query.includes("SELECT count(*)")) return [{ n: hits, wait: 30 }];
    if (query.includes("INSERT INTO web_throttle_hits")) hits++;
    return [];
  });
  const store = vi.fn(async () => withThrottleTx(sql as unknown as Sql));
  return { sql, store, buckets, count: () => hits };
}

type Throttle = ReturnType<typeof throttleFixture>;

function redispatchDeps() {
  const loadCandidate = vi.fn(async () => replayCandidate);
  const dispatch = vi.fn(async () => true);
  const bindings = {
    APP_URL: STAGING_APP_URL,
    DATABASE_URL: "postgres://agent_test@agent-testdb:5432/two_web_next",
    QUEUE_RECONCILE_PREVIEW_ENABLED: "true",
    QUEUE_RECONCILE_OPERATOR_ID: MODERATOR.userId,
    REDISPATCH_DEPS: { loadCandidate, dispatch },
  };
  return { loadCandidate, dispatch, bindings };
}

async function mounted(
  actor: typeof MODERATOR | typeof MEMBER | typeof OTHER_MODERATOR,
  throttle: Throttle,
  extra: Record<string, unknown> = {},
) {
  const sessions = createMemorySessionStore();
  const cookie = await cookieFor(sessions, actor);
  const app = adminApp({ sessionStore: sessions, db });
  const bindings = {
    ...env,
    ADMIN_DB: db,
    THROTTLE_STORE: throttle.store,
    ...extra,
  } as unknown as EnvWithThrottle;
  return { app, cookie, bindings };
}

function postJson(base: string, cookie: string) {
  return {
    method: "POST" as const,
    headers: {
      cookie,
      origin: base,
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "",
  };
}

const REDISPATCH = "/queue/failed/7/redispatch";
const REDISPATCH_URL = `${STAGING_APP_URL}${REDISPATCH}`;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(recordAccess).mockResolvedValue(true);
  pg.audit.mockResolvedValue([]);
  pg.end.mockResolvedValue(undefined);
  pg.factory.mockImplementation(() =>
    Object.assign(pg.audit, { json: (x: unknown) => x, end: pg.end }),
  );
});

describe("redispatch I/O-free refusals precede the admin-write throttle", () => {
  it("non-operator moderator is 403 operator_required with zero spend under an exhausted budget (never 429)", async () => {
    const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
    const deps = redispatchDeps();
    const { app, cookie, bindings } = await mounted(OTHER_MODERATOR, throttle, deps.bindings);
    const response = await app.request(REDISPATCH_URL, postJson(STAGING_APP_URL, cookie), bindings);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "operator_required" });
    expect(throttle.store).not.toHaveBeenCalled();
    expect(throttle.sql).not.toHaveBeenCalled();
    expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
    expect(deps.loadCandidate).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(pg.factory).not.toHaveBeenCalled();
  });

  it.each(["0", "01", "1.0"])(
    "malformed id %s is 422 invalid_failure_id with zero spend under an exhausted budget",
    async (id) => {
      const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
      const deps = redispatchDeps();
      const { app, cookie, bindings } = await mounted(MODERATOR, throttle, deps.bindings);
      const response = await app.request(
        `${STAGING_APP_URL}/queue/failed/${id}/redispatch`,
        postJson(STAGING_APP_URL, cookie),
        bindings,
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "invalid_failure_id" });
      expect(throttle.store).not.toHaveBeenCalled();
      expect(throttle.sql).not.toHaveBeenCalled();
      expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
      expect(deps.loadCandidate).not.toHaveBeenCalled();
      expect(deps.dispatch).not.toHaveBeenCalled();
      expect(pg.factory).not.toHaveBeenCalled();
    },
  );

  it("non-empty query is 422 invalid_failure_id with zero spend under an exhausted budget", async () => {
    const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
    const deps = redispatchDeps();
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle, deps.bindings);
    const response = await app.request(
      `${REDISPATCH_URL}?reason=override`,
      postJson(STAGING_APP_URL, cookie),
      bindings,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid_failure_id" });
    expect(throttle.store).not.toHaveBeenCalled();
    expect(throttle.sql).not.toHaveBeenCalled();
    expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
    expect(deps.loadCandidate).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(pg.factory).not.toHaveBeenCalled();
  });
});

describe("redispatch controls: operator path and wire cap are unchanged", () => {
  it("operator exhausted budget is still 429 with no candidate load, dispatch or audit", async () => {
    const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
    const deps = redispatchDeps();
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle, deps.bindings);
    const response = await app.request(REDISPATCH_URL, postJson(STAGING_APP_URL, cookie), bindings);
    expect(response.status).toBe(429);
    expect(throttle.store).toHaveBeenCalledTimes(1);
    expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
    expect(deps.loadCandidate).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(pg.factory).not.toHaveBeenCalled();
  });

  it("operator dispatch still spends exactly one hit, dispatches once and audits the attempt", async () => {
    const throttle = throttleFixture(0);
    const deps = redispatchDeps();
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle, deps.bindings);
    const response = await app.request(REDISPATCH_URL, postJson(STAGING_APP_URL, cookie), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      redispatched: true,
      ...replayCandidate.preview,
    });
    expect(throttle.count()).toBe(1);
    expect(
      throttle.buckets.some((v) => typeof v === "string" && v.startsWith("admin-write:")),
    ).toBe(true);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(pg.audit).toHaveBeenCalledTimes(1);
  });

  it("held lock still reports the in-flight dedupe with the same attempt receipt", async () => {
    const throttle = throttleFixture(0);
    const deps = redispatchDeps();
    deps.dispatch.mockResolvedValue(false);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle, deps.bindings);
    const response = await app.request(REDISPATCH_URL, postJson(STAGING_APP_URL, cookie), bindings);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      redispatched: true,
      deduped: true,
      ...replayCandidate.preview,
    });
    expect(throttle.count()).toBe(1);
    expect(pg.audit).toHaveBeenCalledTimes(1);
  });

  it("keep advice still refuses 409 with a refusal receipt", async () => {
    const throttle = throttleFixture(0);
    const deps = redispatchDeps();
    deps.loadCandidate.mockResolvedValue(keepCandidate);
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle, deps.bindings);
    const response = await app.request(REDISPATCH_URL, postJson(STAGING_APP_URL, cookie), bindings);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "redispatch_refused",
      failure: keepCandidate.preview.failure,
      disposition: keepCandidate.preview.disposition,
    });
    expect(throttle.count()).toBe(1);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(pg.audit).toHaveBeenCalledTimes(1);
  });

  it("wire cap still runs first: oversized is 413 with zero spend under an exhausted budget", async () => {
    const throttle = throttleFixture(WRITE_THROTTLE_PER_MINUTE);
    const deps = redispatchDeps();
    const { app, cookie, bindings } = await mounted(MODERATOR, throttle, deps.bindings);
    const request = new Request(REDISPATCH_URL, {
      method: "POST",
      body: "x".repeat(BODY_LIMIT_BYTES.action + 1),
      headers: {
        cookie,
        origin: STAGING_APP_URL,
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "content-length": String(BODY_LIMIT_BYTES.action + 1),
      },
    } as RequestInit);
    const response = await app.request(request, undefined, bindings);
    expect(response.status).toBe(413);
    expect(throttle.store).not.toHaveBeenCalled();
    expect(throttle.count()).toBe(WRITE_THROTTLE_PER_MINUTE);
    expect(deps.loadCandidate).not.toHaveBeenCalled();
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(pg.factory).not.toHaveBeenCalled();
    await request.body?.cancel().catch(() => {});
  });
});
