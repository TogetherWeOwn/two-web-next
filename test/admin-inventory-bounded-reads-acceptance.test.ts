// Acceptance: stalled inventory reads cancel server-side before a busy refusal.
//
// Event inventory (the list SELECT plus its second Going-only aggregate),
// featured inventory and activity-log inventory must run inside a transaction
// with finite transaction-local lock_timeout and statement_timeout, reusing
// the existing server-enforced convention (SET LOCAL / set_config(..., true),
// never global pool/role settings and never a client-side Promise.race that
// abandons a still-running statement). Recognized PostgreSQL lock/statement
// cancellation errors (55P03, 57014), including wrapped causes, must produce
// the existing private/no-store sanitized 503 outage envelope only after the
// transaction has settled (rolled back). A timed-out read must never resolve
// an empty-success inventory, and no classified read may still be waiting on
// its lock after the refusal. Filters, pagination, projections and Going-only
// occupancy stay unchanged; activity-log causers stay attributed to the
// required fail-closed access audit; `properties` stays unselected; ordinary
// programming/query errors keep their established classification; a later
// healthy read succeeds; timeout settings never leak into pooled work. The
// bound is documented as per-statement, not a whole-request guarantee.
//
// Behavioral, not a literal pin: every live contention case parks a holder
// connection on a real table lock, proves the contender reached that lock in
// pg_stat_activity (observable rendezvous, never sleeps), then requires the
// contender to settle with the busy/outage verdict while the holder is still
// parked. An unbounded wait loses the test-side detection race and fails as
// the wrong outcome. Settlement is confirmed by the rejection itself, zero
// remaining Lock-waiters blocked by the holder, unchanged pooled timeout
// settings on every pool connection, and a later success after release.
// Hermetic cases pin timeout installation (transaction + local knobs before
// any select), wrapped-cancellation recognition, the Hono/Kit 503 mappings
// and the audit fail-closed posture without a database.
//
// Live against the guarded test database in a throwaway schema. Skipped when
// DATABASE_URL is unset. Never point this at production or staging.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import testApp from "./app";
import { __resetAlertRateLimitForTests } from "../src/alerts";
import { loadActivityLogPage } from "../src/admin/kit-activity-log";
import { resolveKitFeaturedList } from "../src/admin/kit-featured";
import { getEvent, listEvents } from "../src/admin/store-event-reads";
import { listFeatured } from "../src/admin/store-featured";
import { listActivityLog } from "../src/admin/reads";
import {
  activityLog,
  events,
  featuredContents,
  memberDataAccessLogs,
  rsvps,
} from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { databaseOptions } from "../src/db/connection";
import { isDatabaseQueryCancellation, isDatabaseUnavailable } from "../src/db/errors";
import { databaseUnavailable } from "../src/errors";
import type { Env } from "../src/env";
import { bufferedMemberText, declareMemberResult, memberReadBoundary } from "../src/member-reads";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env as baseEnv, MODERATOR, SUBJECT } from "./helpers/member-data";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// Test-side unbounded-wait detector, not a production deadline. Any finite
// server-enforced bound the builder chooses (existing conventions are
// 400ms..2s) settles well inside this. An unbounded wait loses this race and
// fails as the wrong outcome.
const SETTLE_DEADLINE_MS = 15_000;
const BRANDED_OUTAGE_MARK = "We will be right back";
const PLAIN_REFUSAL = "Member data is temporarily unavailable.";

// Deterministic eventKey sequence: unique within each run, no collision risk.
let eventKeySeq = 0;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pgError(code: string) {
  return Object.assign(new Error("private query details"), {
    name: "PostgresError",
    code,
  });
}

function wrapped(code: string, depth = 1) {
  let current: Error = pgError(code);
  for (let i = 0; i < depth; i++) {
    current = new Error("Failed query", { cause: current });
  }
  return current;
}

function codesInChain(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let i = 0; i < 8 && current instanceof Error; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = current.cause;
  }
  return codes;
}

// The three inventory reads behind one table so classification and
// propagation stay uniform across the bundle.
const READS = [
  ["listEvents", (db: Db) => listEvents(db, {})],
  ["listFeatured", (db: Db) => listFeatured(db, {})],
  ["listActivityLog", (db: Db) => listActivityLog(db, {})],
] as const;

// A Db that throws the same error from every entry point the reads use,
// before or after the builder moves them into a transaction.
const fakeRefusing = (error: unknown) =>
  ({
    transaction: async () => {
      throw error;
    },
    select: () => {
      throw error;
    },
    execute: async () => {
      throw error;
    },
    insert: () => {
      throw error;
    },
  }) as unknown as Db;

// Chainable thenable stub for the Drizzle select builders the inventory
// reads await. Rows come from a queue so the two-statement event read can
// return list rows first and Going counts second.
function selectable(rows: unknown[]) {
  const self: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit", "offset", "groupBy"]) {
    self[method] = () => self;
  }
  self.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return self;
}

// Probe Db recording transaction use, timeout installation and which side
// each select ran on. The builder's bounded reads must transact once,
// install both knobs locally before any select, and run every inventory
// statement on the transaction — never on the bare pool.
function makeProbeDb(rowQueues: unknown[][]) {
  const probe = {
    order: [] as string[],
    transactions: 0,
    executes: [] as unknown[],
    selectsOnDb: 0,
    selectsOnTx: 0,
  };
  let calls = 0;
  const nextRows = () => rowQueues[Math.min(calls++, rowQueues.length - 1)] ?? [];
  const tx = {
    execute: async (query: unknown) => {
      probe.order.push("exec");
      probe.executes.push(query);
      return [];
    },
    select: () => {
      probe.order.push("sel-tx");
      probe.selectsOnTx++;
      return selectable(nextRows());
    },
  };
  const db = {
    transaction: async (callback: (t: unknown) => Promise<unknown>) => {
      probe.order.push("tx");
      probe.transactions++;
      return callback(tx);
    },
    execute: async (query: unknown) => {
      probe.order.push("exec");
      probe.executes.push(query);
      return [];
    },
    select: () => {
      probe.order.push("sel-db");
      probe.selectsOnDb++;
      return selectable(nextRows());
    },
  };
  return { db: db as unknown as Db, probe };
}

// Best-effort text/param extraction from a Drizzle SQL template: string
// chunks joined (drizzle inlines `${"2000ms"}` string params as raw string
// chunks and `${2000}` numbers as raw number chunks), other bound params
// collected. Enough to pin the knob names, the transaction-local flag and
// finite values without a SQL dialect.
function sqlStrings(query: unknown): { text: string; params: unknown[] } {
  const strings: string[] = [];
  const params: unknown[] = [];
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      strings.push(node);
      return;
    }
    if (typeof node === "number") {
      params.push(node);
      return;
    }
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.queryChunks)) {
      (record.queryChunks as unknown[]).forEach(walk);
      return;
    }
    if (
      Array.isArray(record.value) &&
      (record.value as unknown[]).every((part) => typeof part === "string")
    ) {
      strings.push(...(record.value as string[]));
      return;
    }
    if ("value" in record && !("table" in record)) {
      params.push(record.value);
      return;
    }
    Object.values(record).forEach(walk);
  };
  walk(query);
  return { text: strings.join(""), params };
}

function expectBoundedInstall(
  probe: ReturnType<typeof makeProbeDb>["probe"],
  expectedTxSelects: number,
  label: string,
) {
  expect(probe.transactions, `${label} must run inside one transaction`).toBe(1);
  expect(
    probe.selectsOnDb,
    `${label}: no inventory statement may run outside the bounded transaction`,
  ).toBe(0);
  expect(
    probe.selectsOnTx,
    `${label}: every inventory statement runs inside the bounded transaction`,
  ).toBe(expectedTxSelects);
  expect(
    probe.executes.length,
    `${label}: the transaction must install lock/statement timeouts`,
  ).toBeGreaterThanOrEqual(1);
  expect(probe.order[0], `${label}: the transaction opens first`).toBe("tx");
  expect(probe.order[1], `${label}: timeouts install before any inventory select`).toBe("exec");
  const first = sqlStrings(probe.executes[0]);
  expect(first.text, `${label}: the install names lock_timeout`).toMatch(/lock_timeout/i);
  expect(first.text, `${label}: the install names statement_timeout`).toMatch(/statement_timeout/i);
  expect(first.text, `${label}: the install follows the local convention`).toMatch(
    /set_config|SET LOCAL/i,
  );
  if (/set_config/i.test(first.text)) {
    expect(
      first.text,
      `${label}: set_config stays transaction-local (is_local true), never session/global`,
    ).toMatch(/,\s*true\s*\)/);
  }
  // String params land in the joined text, integer params (bare
  // numbers are milliseconds in Postgres) land in params; both count.
  const fromText = [...first.text.matchAll(/(\d+)ms/g)].map((match) =>
    Number.parseInt(match[1]!, 10),
  );
  const fromParams = first.params.flatMap((param) => {
    if (typeof param === "number" && Number.isInteger(param)) return [param];
    if (typeof param === "string" && /^\d+ms$/.test(param)) return [Number.parseInt(param, 10)];
    return [];
  });
  const finiteMs = [...fromText, ...fromParams];
  expect(
    finiteMs.length,
    `${label}: both knobs carry finite millisecond values, got ${JSON.stringify(first)}`,
  ).toBeGreaterThanOrEqual(2);
  for (const value of finiteMs) {
    expect(value, `${label}: timeout values stay finite and modest`).toBeGreaterThanOrEqual(100);
    expect(value, `${label}: timeout values stay finite and modest`).toBeLessThanOrEqual(15_000);
  }
}

describe("inventory read busy classification (offline)", () => {
  it.each(["55P03", "57014"])("recognizes Postgres cancellation code %s", (code) => {
    expect(isDatabaseUnavailable(pgError(code))).toBe(true);
    expect(isDatabaseQueryCancellation(pgError(code))).toBe(true);
  });

  it.each(["55P03", "57014"])("recognizes %s through a single query wrapper", (code) => {
    expect(isDatabaseUnavailable(wrapped(code, 1))).toBe(true);
    expect(isDatabaseQueryCancellation(wrapped(code, 1))).toBe(true);
  });

  it.each(["55P03", "57014"])("recognizes %s through a double-wrapped cause chain", (code) => {
    expect(isDatabaseUnavailable(wrapped(code, 2))).toBe(true);
    expect(isDatabaseQueryCancellation(wrapped(code, 2))).toBe(true);
  });

  it.each([pgError("23505"), pgError("42601"), pgError("42501"), new TypeError("bug")])(
    "does not disguise ordinary errors as outage or cancellation: %s",
    (error) => {
      expect(isDatabaseUnavailable(error)).toBe(false);
      expect(isDatabaseQueryCancellation(error)).toBe(false);
    },
  );

  it("keeps bounds transaction-local, never global connection settings", () => {
    // The bounded-read convention is SET LOCAL / set_config(..., true)
    // inside each inventory transaction. Global databaseOptions must not
    // carry statement_timeout or lock_timeout: those would bound every
    // pooled statement, not just the stalled inventories.
    expect(databaseOptions).not.toHaveProperty("statement_timeout");
    expect(databaseOptions).not.toHaveProperty("lock_timeout");
  });

  it("documents the per-statement inventory-read bound, never a whole-request deadline", () => {
    // The builder documents the inventory bound where a moderator or
    // operator will find it: the moderator guide or the store leaves that
    // own the bound. One block must name the inventory reads, both the
    // per-statement scope and the timeout knobs, and the whole-request
    // disclaimer together — proximity matters, so blocks are checked
    // separately and distant unrelated matches cannot combine.
    const guide = readFileSync(
      fileURLToPath(new URL("../docs/moderator-admin-guide.md", import.meta.url).href),
      "utf8",
    );
    const leaves = [
      "../src/admin/store-event-reads.ts",
      "../src/admin/store-featured.ts",
      "../src/admin/reads.ts",
    ].map((rel) => {
      try {
        return readFileSync(fileURLToPath(new URL(rel, import.meta.url).href), "utf8");
      } catch {
        return "";
      }
    });
    const blocks = [...guide.split(/^## /m), ...leaves];
    const documented = blocks.some(
      (block) =>
        /inventor/i.test(block) &&
        /per-statement|per statement/i.test(block) &&
        /statement_timeout|lock_timeout/i.test(block) &&
        /whole-request|whole request/i.test(block),
    );
    expect(documented, "one guide section or store leaf documents the inventory-read bound").toBe(
      true,
    );
  });
});

describe("inventory timeout installation (offline, probe Db)", () => {
  it("bounds the event list and its second Going-count statement in one transaction", async () => {
    const { db, probe } = makeProbeDb([[{ id: 7 }], [{ eventId: 7, n: 3 }]]);
    const rows = await listEvents(db, {});
    expect(rows).toEqual([{ id: 7, goingCount: 3 }]);
    expectBoundedInstall(probe, 2, "listEvents");
  });

  it("bounds the featured list in one transaction", async () => {
    const { db, probe } = makeProbeDb([[{ id: 1, title: "Slot" }]]);
    const rows = await listFeatured(db, {});
    expect(rows).toHaveLength(1);
    expectBoundedInstall(probe, 1, "listFeatured");
  });

  it("bounds the activity-log list in one transaction", async () => {
    const { db, probe } = makeProbeDb([
      [{ id: 1, causerId: "100000000000000201", properties: undefined }],
    ]);
    const rows = await listActivityLog(db, {});
    expect(rows).toHaveLength(1);
    expectBoundedInstall(probe, 1, "listActivityLog");
  });
});

describe("inventory store propagation (offline, fake Db)", () => {
  it.each(READS)(
    "%s rejects on a wrapped lock-timeout, never an empty success",
    async (_n, run) => {
      const error = wrapped("55P03", 1);
      const seen = await run(fakeRefusing(error)).then(
        (value) => ({ value }),
        (thrown: unknown) => ({ thrown }),
      );
      expect("thrown" in seen, "a cancelled inventory must reject, never resolve").toBe(true);
      if (!("thrown" in seen)) throw new Error("cancelled inventory resolved");
      expect(codesInChain(seen.thrown)).toContain("55P03");
      expect(isDatabaseUnavailable(seen.thrown)).toBe(true);
      expect(isDatabaseQueryCancellation(seen.thrown)).toBe(true);
    },
  );

  it.each(READS)(
    "%s rejects on a double-wrapped statement-timeout, never an empty success",
    async (_n, run) => {
      const seen = await run(fakeRefusing(wrapped("57014", 2))).then(
        (value) => ({ value }),
        (thrown: unknown) => ({ thrown }),
      );
      expect("thrown" in seen, "a cancelled inventory must reject, never resolve").toBe(true);
      if (!("thrown" in seen)) throw new Error("cancelled inventory resolved");
      expect(codesInChain(seen.thrown)).toContain("57014");
      expect(isDatabaseUnavailable(seen.thrown)).toBe(true);
    },
  );

  it.each(READS)(
    "%s lets ordinary programming errors keep their classification",
    async (_n, run) => {
      for (const error of [new TypeError("private bug"), pgError("42601")]) {
        const seen = await run(fakeRefusing(error)).then(
          (value) => ({ value }),
          (thrown: unknown) => ({ thrown }),
        );
        expect("thrown" in seen, "an ordinary failure must reject, never resolve").toBe(true);
        if (!("thrown" in seen)) throw new Error("ordinary failure resolved");
        expect(isDatabaseUnavailable(seen.thrown)).toBe(false);
        expect(isDatabaseQueryCancellation(seen.thrown)).toBe(false);
      }
    },
  );
});

describe("inventory outage mapping (offline, mounted Hono boundary)", () => {
  const muted = async <T>(fn: () => Promise<T>): Promise<T> => {
    const errors: unknown[] = [];
    const warns: unknown[] = [];
    const errSpy = console.error;
    const warnSpy = console.warn;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    console.warn = (...args: unknown[]) => {
      warns.push(args);
    };
    try {
      return await fn();
    } finally {
      console.error = errSpy;
      console.warn = warnSpy;
    }
    void errors;
    void warns;
  };

  const boundaryApp = (
    behavior: () => Promise<Response>,
    write: () => Promise<boolean> = async () => true,
  ) => {
    const app = new Hono();
    app.use(async (c, next) =>
      memberReadBoundary(
        c,
        {
          resource: "events",
          action: "list",
          route: "admin.events.index",
          viewer: MODERATOR.userId,
        },
        write,
        next,
        databaseUnavailable,
      ),
    );
    app.get("/probe", behavior);
    return app;
  };

  it("maps a wrapped lock-timeout to the branded 503 with no leak", async () => {
    await muted(async () => {
      const res = await boundaryApp(async () => {
        throw wrapped("55P03", 1);
      }).request("/probe", {}, baseEnv);
      expect(res.status).toBe(503);
      const cache = res.headers.get("cache-control") ?? "";
      expect(cache).toContain("no-store");
      expect(cache).toContain("private");
      const body = await res.text();
      expect(body).toContain(BRANDED_OUTAGE_MARK);
      expect(body).not.toMatch(/private query details|Failed query|55P03|57014/);
    });
  });

  it("maps a double-wrapped statement-timeout to the branded 503 with no leak", async () => {
    await muted(async () => {
      const res = await boundaryApp(async () => {
        throw wrapped("57014", 2);
      }).request("/probe", {}, baseEnv);
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).toContain(BRANDED_OUTAGE_MARK);
      expect(body).not.toMatch(/private query details|Failed query|55P03|57014/);
    });
  });

  it.each([[new TypeError("private bug")], [pgError("42601")]])(
    "keeps an ordinary read failure on the plain refusal, never the outage envelope: %s",
    async (error) => {
      await muted(async () => {
        const res = await boundaryApp(async () => {
          throw error;
        }).request("/probe", {}, baseEnv);
        expect(res.status).toBe(503);
        const body = await res.text();
        expect(body).toContain(PLAIN_REFUSAL);
        expect(body).not.toContain(BRANDED_OUTAGE_MARK);
        expect(body).not.toMatch(/private query details|private bug|42601/);
      });
    },
  );

  it("fails a broken access audit closed with no private bytes escaping", async () => {
    await muted(async () => {
      const app = new Hono();
      app.use(async (c, next) =>
        memberReadBoundary(
          c,
          {
            resource: "activity_log",
            action: "list",
            route: "admin.activity-log.index",
            viewer: MODERATOR.userId,
          },
          async () => {
            throw new Error("audit store down");
          },
          next,
          databaseUnavailable,
        ),
      );
      app.get("/probe", (c) => {
        declareMemberResult(["100000000000000201"]);
        return bufferedMemberText(c, "private causer 100000000000000201 payload", 200);
      });
      const res = await app.request("/probe", {}, baseEnv);
      expect(res.status).toBe(503);
      const cache = res.headers.get("cache-control") ?? "";
      expect(cache).toContain("no-store");
      expect(cache).toContain("private");
      const body = await res.text();
      expect(body).toContain(BRANDED_OUTAGE_MARK);
      expect(body).not.toContain("private causer 100000000000000201 payload");
      expect(body).not.toContain("100000000000000201");
    });
  });
});

describe("inventory outage mapping (offline, Kit helpers)", () => {
  const db = {} as unknown as Db;

  it("featured: a wrapped cancellation answers unavailable, never an empty page", async () => {
    const outcome = await resolveKitFeaturedList(
      {},
      {
        db,
        list: async () => {
          throw wrapped("55P03", 1);
        },
      },
    );
    expect(outcome).toEqual({ kind: "unavailable" });
  });

  it.each([[new TypeError("private bug")], [pgError("42601")]])(
    "featured: an ordinary list failure rethrows, never degrades to unavailable: %s",
    async (error) => {
      await expect(
        resolveKitFeaturedList(
          {},
          {
            db,
            list: async () => {
              throw error;
            },
          },
        ),
      ).rejects.toBe(error);
    },
  );

  it("activity-log: a wrapped cancellation throws the silent branded 503 marker", async () => {
    __resetAlertRateLimitForTests();
    const lines: string[] = [];
    const errSpy = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const setHeaders = (_headers: Record<string, string>) => {};
      let seenHeaders: Record<string, string> | undefined;
      await expect(
        loadActivityLogPage({
          env: baseEnv,
          subjectParam: null,
          causerParam: null,
          pageParam: null,
          setHeaders: (headers) => {
            seenHeaders = headers;
          },
          dbForFn: async () => db,
          listFn: async () => {
            throw wrapped("57014", 1);
          },
        }),
      ).rejects.toMatchObject({ status: 503 });
      expect(seenHeaders?.["cache-control"]).toContain("no-store");
      expect(seenHeaders?.["cache-control"]).toContain("private");
      expect(
        lines.filter((line) => line.includes('"error.alert"')),
        "a classified outage stays silent",
      ).toHaveLength(0);
      void setHeaders;
    } finally {
      console.error = errSpy;
    }
  });

  it("activity-log: an ordinary list failure still alerts before the 503 marker", async () => {
    __resetAlertRateLimitForTests();
    const lines: string[] = [];
    const errSpy = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await expect(
        loadActivityLogPage({
          env: baseEnv,
          subjectParam: null,
          causerParam: null,
          pageParam: null,
          setHeaders: () => {},
          dbForFn: async () => db,
          listFn: async () => {
            throw new TypeError("private bug");
          },
        }),
      ).rejects.toMatchObject({ status: 503 });
      const alerts = lines.filter((line) => line.includes('"error.alert"'));
      expect(alerts, "a code bug emits exactly one leak-free diagnostic").toHaveLength(1);
      expect(alerts[0]).not.toContain("private bug");
    } finally {
      console.error = errSpy;
    }
  });

  it("events: the Kit binding keeps mapping a classified outage to error(503)", () => {
    // Contract pin: the events load owns the 503 mapping in the server
    // binding (cloudflare:workers imports keep it out of the root suite),
    // while featured/activity-log map inside their tested helpers.
    const server = readFileSync(
      fileURLToPath(
        new URL("../web/src/routes/admin/events/+page.server.ts", import.meta.url).href,
      ),
      "utf8",
    );
    expect(server).toMatch(/isDatabaseUnavailable/);
    expect(server).toMatch(/error\(503/);
  });
});

const raw = process.env.DATABASE_URL;
describe.skipIf(!raw)("inventory bounded reads (test database)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  const sessionStore = createMemorySessionStore();
  let cookie = "";
  const liveEnv = () =>
    ({ ...baseEnv, ADMIN_DB: db, SESSION_STORE: sessionStore }) as unknown as Env;

  beforeAll(async () => {
    // Contender transactions, pg_stat_activity observers, settings canaries
    // and assertions each need a connection while a separate holder pool
    // parks its table lock.
    fixture = await createMemberDataFixture(raw!, { max: 8 });
    db = fixture.db;
    cookie = await cookieFor(sessionStore, MODERATOR);
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  beforeEach(async () => {
    await fixture.reset();
    await db.delete(featuredContents);
  });

  const holderClient = () => {
    const url = testDatabaseUrl(raw!);
    return postgres(url.href, {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
  };

  const blockedBy = (holderPid: number) =>
    fixture.client<{ pid: number; query: string }[]>`
      select pid, query from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and ${holderPid} = any(pg_blocking_pids(pid))`;

  async function waitForBlockedOn(holderPid: number, pattern: RegExp) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await blockedBy(holderPid);
      if (rows.some((row) => pattern.test(row.query ?? ""))) return;
      if (Date.now() >= deadline)
        throw new Error(`contender did not reach the held lock (${pattern})`);
      await delay(25);
    }
  }

  async function settleHasNoWaiters(holderPid: number) {
    // After the refusal the classified read is gone: no backend may still
    // wait on the holder's lock, even though the holder stays parked.
    const deadline = Date.now() + 2_000;
    for (;;) {
      const rows = await blockedBy(holderPid);
      if (rows.length === 0) return;
      if (Date.now() >= deadline)
        throw new Error(`classified read still waiting after refusal (${rows.length})`);
      await delay(25);
    }
  }

  type Settled<T> =
    | { settled: true; value: T }
    | { settled: true; error: unknown }
    | { settled: false };

  async function raceBounded<T>(pending: Promise<T>): Promise<Settled<T>> {
    const verdict = pending.then(
      (value): Settled<T> => ({ settled: true, value }),
      (error): Settled<T> => ({ settled: true, error }),
    );
    const deadline = delay(SETTLE_DEADLINE_MS).then((): Settled<T> => ({ settled: false }));
    return Promise.race([verdict, deadline]);
  }

  async function poolSettingsAllDefault() {
    // Eight concurrent probes force eight distinct backends (concurrent
    // queries cannot share a connection), covering the whole max:8 pool —
    // including the contender's connection now idle after rollback. Any
    // session-level leak would surface on exactly that backend.
    const probes = Array.from(
      { length: 8 },
      () =>
        fixture.client<{ statement: string; lock: string }[]>`
        select current_setting('statement_timeout') as statement,
               current_setting('lock_timeout') as lock`,
    );
    for (const rows of await Promise.all(probes)) {
      expect(rows).toEqual([{ statement: "0", lock: "0" }]);
    }
  }

  const seedEvent = async (over: Record<string, unknown> = {}) => {
    const [row] = await db
      .insert(events)
      .values({
        eventKey: `01J${String(++eventKeySeq).padStart(23, "0")}`,
        title: "Bounded inventory night",
        game: "Chess",
        description: "Boards out",
        startsAt: new Date("2099-11-04T20:00:00.000Z"),
        endsAt: new Date("2099-11-04T22:00:00.000Z"),
        timezone: "Europe/London",
        location: "Voice",
        capacity: 8,
        status: "draft",
        ...over,
      })
      .returning();
    return row!;
  };

  const seedFeatured = async (over: Record<string, unknown> = {}) => {
    const [row] = await db
      .insert(featuredContents)
      .values({
        title: "Bounded inventory slot",
        body: "Bounded body",
        url: null,
        imageUrl: null,
        imageAlt: null,
        isPublished: false,
        position: 3,
        startsAt: null,
        endsAt: null,
        ...over,
      })
      .returning();
    return row!;
  };

  const seedActivity = async (over: Record<string, unknown> = {}) => {
    const [row] = await db
      .insert(activityLog)
      .values({
        description: "updated event bounded inventory night",
        subjectType: "Event",
        subjectId: "01J00000000000000000000015",
        causerId: SUBJECT.userId,
        event: "updated",
        properties: { title: { before: "Old", after: "New" } },
        ...over,
      })
      .returning();
    return row!;
  };

  const get = (path: string) =>
    Promise.resolve(testApp.request(path, { headers: { cookie } }, liveEnv()));

  it("control: an uncontended event inventory keeps filters and Going-only occupancy", async () => {
    const full = await seedEvent({ title: "Zxq Full House", status: "published", capacity: 2 });
    const roomy = await seedEvent({ title: "Zxq Roomy Night", status: "draft", capacity: 4 });
    await db.insert(rsvps).values([
      { eventId: full.id, userId: "100000000000000201", status: "going" },
      { eventId: full.id, userId: "100000000000000202", status: "going" },
      { eventId: full.id, userId: "100000000000000203", status: "maybe" },
      { eventId: full.id, userId: "100000000000000204", status: "waitlisted" },
      { eventId: roomy.id, userId: "100000000000000201", status: "going" },
    ]);
    const all = await listEvents(db, {});
    expect(all.find((row) => row.id === full.id)?.goingCount).toBe(2);
    expect(all.find((row) => row.id === roomy.id)?.goingCount).toBe(1);
    expect((await listEvents(db, { fill: "full" })).map((row) => row.id)).toEqual([full.id]);
    expect((await listEvents(db, { fill: "has_seats" })).map((row) => row.id)).toEqual([roomy.id]);
    expect((await listEvents(db, { status: "published" })).map((row) => row.id)).toEqual([full.id]);
    expect((await listEvents(db, { q: "Roomy" })).map((row) => row.id)).toEqual([roomy.id]);
    await poolSettingsAllDefault();
  });

  it("control: an uncontended featured inventory keeps filters, order and bounds", async () => {
    await seedFeatured({ title: "Zxq Slot Alpha", isPublished: true, position: 3 });
    await seedFeatured({ title: "Zxq Slot Beta", isPublished: false, position: 1 });
    const all = await listFeatured(db, {});
    expect(all.map((row) => row.position)).toEqual([1, 3]);
    expect((await listFeatured(db, { published: true })).map((row) => row.title)).toEqual([
      "Zxq Slot Alpha",
    ]);
    expect((await listFeatured(db, { q: "Beta" })).map((row) => row.title)).toEqual([
      "Zxq Slot Beta",
    ]);
    expect(
      (await listFeatured(db, { sort: "updated_at", order: "desc" })).map((row) => row.id),
    ).toHaveLength(2);
    await poolSettingsAllDefault();
  });

  it("control: an uncontended activity inventory keeps filters and never selects properties", async () => {
    await seedActivity({ description: "older inventory row", causerId: SUBJECT.userId });
    await delay(5);
    await seedActivity({
      description: "newer inventory row",
      subjectType: "FeaturedContent",
      causerId: "100000000000000201",
    });
    const rows = await listActivityLog(db, {});
    expect(rows.map((row) => row.description)).toEqual([
      "newer inventory row",
      "older inventory row",
    ]);
    for (const row of rows) expect("properties" in row).toBe(false);
    expect(
      (await listActivityLog(db, { subject: "FeaturedContent" })).map((row) => row.id),
    ).toEqual([rows[0]!.id]);
    expect((await listActivityLog(db, { causer: SUBJECT.userId })).map((row) => row.id)).toEqual([
      rows[1]!.id,
    ]);
    await poolSettingsAllDefault();
  });

  it("control: ordinary live failures keep their classification and missing keys stay null", async () => {
    const bad = await fixture.client.unsafe("select * from no_such_inventory_table").then(
      () => null,
      (error: unknown) => error,
    );
    expect(bad).toBeInstanceOf(Error);
    expect(isDatabaseUnavailable(bad)).toBe(false);
    expect(isDatabaseQueryCancellation(bad)).toBe(false);
    await expect(getEvent(db, "01J00000000000000000000999")).resolves.toBeNull();
  });

  it("event inventory behind a held events lock fails bounded, settles, then succeeds", async () => {
    await seedEvent({ title: "Zxq Held Night" });
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE events IN ACCESS EXCLUSIVE MODE");
      pending = listEvents(db, {});
      await waitForBlockedOn(holderPid!.pid, /from "events"/);
      const outcome = await raceBounded(pending);
      expect(
        outcome.settled,
        "event inventory must settle bounded while the holder still parks its table lock",
      ).toBe(true);
      if (!outcome.settled) throw new Error("unbounded event inventory wait");
      expect("error" in outcome, "a timed-out inventory must reject, never resolve").toBe(true);
      const error = (outcome as { error: unknown }).error;
      expect(codesInChain(error)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^(55P03|57014)$/)]),
      );
      expect(isDatabaseUnavailable(error)).toBe(true);
      await settleHasNoWaiters(holderPid!.pid);
      await poolSettingsAllDefault();
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const rows = await listEvents(db, {});
    expect(rows.map((row) => row.title)).toContain("Zxq Held Night");
    await poolSettingsAllDefault();
  });

  it("event inventory fails bounded when only its second Going-count query blocks", async () => {
    const seeded = await seedEvent({ title: "Zxq Second Query Night", status: "published" });
    await db
      .insert(rsvps)
      .values({ eventId: seeded.id, userId: "100000000000000201", status: "going" });
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE rsvps IN ACCESS EXCLUSIVE MODE");
      pending = listEvents(db, {});
      // The first SELECT (events) succeeds; the contender parks on the
      // second statement's table, proving the bound covers both queries.
      await waitForBlockedOn(holderPid!.pid, /from "rsvps"/);
      const outcome = await raceBounded(pending);
      expect(
        outcome.settled,
        "event inventory must settle bounded while the Going-count table stays locked",
      ).toBe(true);
      if (!outcome.settled) throw new Error("unbounded Going-count wait");
      expect("error" in outcome, "a timed-out inventory must reject, never resolve").toBe(true);
      const error = (outcome as { error: unknown }).error;
      expect(codesInChain(error)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^(55P03|57014)$/)]),
      );
      expect(isDatabaseUnavailable(error)).toBe(true);
      await settleHasNoWaiters(holderPid!.pid);
      await poolSettingsAllDefault();
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const rows = await listEvents(db, {});
    expect(rows.find((row) => row.id === seeded.id)?.goingCount).toBe(1);
    await poolSettingsAllDefault();
  });

  it("featured inventory behind a held table lock fails bounded, settles, then succeeds", async () => {
    await seedFeatured({ title: "Zxq Held Slot" });
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE featured_contents IN ACCESS EXCLUSIVE MODE");
      pending = listFeatured(db, {});
      await waitForBlockedOn(holderPid!.pid, /from "featured_contents"/);
      const outcome = await raceBounded(pending);
      expect(
        outcome.settled,
        "featured inventory must settle bounded while the holder still parks its table lock",
      ).toBe(true);
      if (!outcome.settled) throw new Error("unbounded featured inventory wait");
      expect("error" in outcome, "a timed-out inventory must reject, never resolve").toBe(true);
      const error = (outcome as { error: unknown }).error;
      expect(codesInChain(error)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^(55P03|57014)$/)]),
      );
      expect(isDatabaseUnavailable(error)).toBe(true);
      await settleHasNoWaiters(holderPid!.pid);
      await poolSettingsAllDefault();
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const rows = await listFeatured(db, {});
    expect(rows.map((row) => row.title)).toContain("Zxq Held Slot");
    await poolSettingsAllDefault();
  });

  it("activity inventory behind a held table lock fails bounded, settles, then succeeds", async () => {
    await seedActivity({ description: "Zxq held audit row" });
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE activity_log IN ACCESS EXCLUSIVE MODE");
      pending = listActivityLog(db, {});
      await waitForBlockedOn(holderPid!.pid, /from "activity_log"/);
      const outcome = await raceBounded(pending);
      expect(
        outcome.settled,
        "activity inventory must settle bounded while the holder still parks its table lock",
      ).toBe(true);
      if (!outcome.settled) throw new Error("unbounded activity inventory wait");
      expect("error" in outcome, "a timed-out inventory must reject, never resolve").toBe(true);
      const error = (outcome as { error: unknown }).error;
      expect(codesInChain(error)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^(55P03|57014)$/)]),
      );
      expect(isDatabaseUnavailable(error)).toBe(true);
      await settleHasNoWaiters(holderPid!.pid);
      await poolSettingsAllDefault();
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const rows = await listActivityLog(db, {});
    expect(rows.map((row) => row.description)).toContain("Zxq held audit row");
    await poolSettingsAllDefault();
  });

  it("control: the events page renders with no audit row for its subject-free read", async () => {
    await seedEvent({ title: "Zxq Rendered Night", status: "published" });
    const res = await get("/admin/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toContain("Zxq Rendered Night");
    expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
  });

  it("control: the activity-log page attributes its causers to one access-log row", async () => {
    await seedActivity({ description: "Zxq attributed audit row", causerId: SUBJECT.userId });
    const res = await get("/admin/activity-log");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(SUBJECT.userId);
    const entries = await db.select().from(memberDataAccessLogs);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      viewerDiscordId: MODERATOR.userId,
      resource: "activity_log",
      action: "list",
      route: "admin.activity-log.index",
      subjectUserIds: [SUBJECT.userId],
      subjectCount: 1,
    });
  });

  it("held events page answers the sanitized 503 while parked, then renders", async () => {
    await seedEvent({ title: "Zxq Parked Night", status: "published" });
    const holder = holderClient();
    let pending: Promise<Response> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE events IN ACCESS EXCLUSIVE MODE");
      pending = get("/admin/events");
      await waitForBlockedOn(holderPid!.pid, /from "events"/);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "held events page must answer bounded while parked").toBe(true);
      if (!outcome.settled || "error" in outcome) throw new Error("unbounded events page wait");
      const res = (outcome as { value: Response }).value;
      expect(res.status, "a cancelled inventory never answers empty-success").toBe(503);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("cache-control")).toContain("private");
      const body = await res.text();
      expect(body).toContain(BRANDED_OUTAGE_MARK);
      expect(body).not.toContain("Zxq Parked Night");
      expect(body).not.toMatch(/55P03|57014/);
      await settleHasNoWaiters(holderPid!.pid);
      await poolSettingsAllDefault();
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const retry = await get("/admin/events");
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain("Zxq Parked Night");
  });

  it("held featured page answers the sanitized 503 while parked, then renders", async () => {
    await seedFeatured({ title: "Zxq Parked Slot", isPublished: true });
    const holder = holderClient();
    let pending: Promise<Response> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE featured_contents IN ACCESS EXCLUSIVE MODE");
      pending = get("/admin/featured");
      await waitForBlockedOn(holderPid!.pid, /from "featured_contents"/);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "held featured page must answer bounded while parked").toBe(true);
      if (!outcome.settled || "error" in outcome) throw new Error("unbounded featured page wait");
      const res = (outcome as { value: Response }).value;
      expect(res.status, "a cancelled inventory never answers empty-success").toBe(503);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("cache-control")).toContain("private");
      const body = await res.text();
      expect(body).toContain(BRANDED_OUTAGE_MARK);
      expect(body).not.toContain("Zxq Parked Slot");
      expect(body).not.toMatch(/55P03|57014/);
      await settleHasNoWaiters(holderPid!.pid);
      await poolSettingsAllDefault();
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const retry = await get("/admin/featured");
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain("Zxq Parked Slot");
  });

  it("held activity-log page answers the sanitized 503 while parked, then renders", async () => {
    await seedActivity({ description: "Zxq parked audit row", causerId: SUBJECT.userId });
    const holder = holderClient();
    let pending: Promise<Response> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE activity_log IN ACCESS EXCLUSIVE MODE");
      pending = get("/admin/activity-log");
      await waitForBlockedOn(holderPid!.pid, /from "activity_log"/);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "held activity page must answer bounded while parked").toBe(true);
      if (!outcome.settled || "error" in outcome) throw new Error("unbounded activity page wait");
      const res = (outcome as { value: Response }).value;
      expect(res.status, "a cancelled inventory never answers empty-success").toBe(503);
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.get("cache-control")).toContain("private");
      const body = await res.text();
      expect(body).toContain(BRANDED_OUTAGE_MARK);
      expect(body).not.toContain("Zxq parked audit row");
      expect(body).not.toContain(SUBJECT.userId);
      expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
      await settleHasNoWaiters(holderPid!.pid);
      await poolSettingsAllDefault();
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const retry = await get("/admin/activity-log");
    expect(retry.status).toBe(200);
    expect(await retry.text()).toContain("Zxq parked audit row");
    const entries = await db
      .select()
      .from(memberDataAccessLogs)
      .orderBy(asc(memberDataAccessLogs.id));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.subjectUserIds).toEqual([SUBJECT.userId]);
  });

  it("activity-log page behind a held audit table fails closed with no private bytes", async () => {
    await seedActivity({ description: "Zxq audit-locked row", causerId: SUBJECT.userId });
    const holder = holderClient();
    let pending: Promise<Response> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE member_data_access_logs IN ACCESS EXCLUSIVE MODE");
      pending = get("/admin/activity-log");
      // The inventory read succeeds; the contender parks on the audit
      // INSERT, which already carries its own transaction-local bound.
      await waitForBlockedOn(holderPid!.pid, /member_data_access_logs/);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "audit-blocked page must answer bounded while parked").toBe(true);
      if (!outcome.settled || "error" in outcome) throw new Error("unbounded audit-blocked wait");
      const res = (outcome as { value: Response }).value;
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).toContain(BRANDED_OUTAGE_MARK);
      expect(body).not.toContain("Zxq audit-locked row");
      expect(body).not.toContain(SUBJECT.userId);
      await settleHasNoWaiters(holderPid!.pid);
    } finally {
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    const retry = await get("/admin/activity-log");
    expect(retry.status).toBe(200);
    expect((await db.select().from(memberDataAccessLogs)).length).toBeGreaterThanOrEqual(1);
  });

  it("live missing-key reads keep their contracts, never the outage", async () => {
    await expect(getEvent(db, "01J00000000000000000000999")).resolves.toBeNull();
    expect(await db.select().from(events).where(eq(events.eventKey, "01JX"))).toHaveLength(0);
  });
});
