// route-inventory: GET /up
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import app from "./app";
import type { Env } from "../src/env";
import { pgQueueDepth, pgQueueLedger } from "../src/jobs/postgres";
import { discardFailedJob, listFailedJobs } from "../src/jobs/redrive";
import {
  configReadiness,
  databaseReadiness,
  missingSecrets,
  pendingWebMigrations,
  QUEUE_CRITICAL_AT,
  QUEUE_READ_TIMEOUT_MS,
  QUEUE_WARN_AT,
  REQUIRED_SECRETS,
  upBody,
  WEB_MIGRATIONS,
  withHealthReadTimeout,
} from "../src/up";
import { createLedgerFixture } from "./helpers/queue-ledger-fixture";
import { healthSql } from "./helpers/up";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const depthRow = (over: Record<string, unknown> = {}) => ({
  pending: 3,
  delayed: 1,
  reserved: 0,
  total: 4,
  failed: 2,
  oldest_pending_age_seconds: 42,
  ...over,
});
const withStore = (sql: unknown) => ({ ...env, QUEUE_DEPTH_STORE: sql }) as Env;
const applied = WEB_MIGRATIONS.map((entry) => ({ created_at: String(entry.when) }));
const never = () => new Promise<Record<string, unknown>[]>(() => {});

const healthyQueue = {
  status: "healthy",
  pending: 3,
  delayed: 1,
  reserved: 0,
  total: 4,
  failed: 2,
  oldest_pending_age_seconds: 42,
  warn_at: 20,
  critical_at: 100,
  detail: null,
};
const unknownQueue = {
  status: "unknown",
  pending: null,
  delayed: null,
  reserved: null,
  total: null,
  failed: null,
  oldest_pending_age_seconds: null,
  warn_at: 20,
  critical_at: 100,
  detail: null,
};

describe("web migration journal comparison", () => {
  it("bundles only the web 1000-series tags", () => {
    expect(WEB_MIGRATIONS.length).toBeGreaterThan(0);
    expect(WEB_MIGRATIONS.every((entry) => /^1\d{3}_/.test(entry.tag))).toBe(true);
    expect(pendingWebMigrations([])).toBe(WEB_MIGRATIONS.length);
  });
  it("recognizes exact timestamps, not row counts or the latest bot watermark", () => {
    expect(pendingWebMigrations(applied)).toBe(0);
    const missingMiddle = applied.filter((_, i) => i !== 1);
    expect(pendingWebMigrations([...missingMiddle, { created_at: "9999999999999" }])).toBe(1);
    expect(pendingWebMigrations([...applied, applied[0]!])).toBe(0);
    expect(pendingWebMigrations([{ created_at: String(WEB_MIGRATIONS.at(-1)!.when) }])).toBe(
      WEB_MIGRATIONS.length - 1,
    );
  });
  it.each([null, "", "bad", -1, 1.5, Infinity, "9007199254740993"])(
    "fails closed on malformed ledger timestamps (%s)",
    (created_at) => {
      expect(() => pendingWebMigrations([{ created_at }])).toThrow();
    },
  );
});

describe("upBody queue compatibility", () => {
  it("is degraded at exactly warn, healthy below; critical has no separate status", async () => {
    for (const pending of [QUEUE_WARN_AT - 1, QUEUE_WARN_AT, QUEUE_CRITICAL_AT]) {
      const body = await upBody(
        async () => ({
          pending,
          delayed: 0,
          reserved: 0,
          total: pending,
          failed: 0,
          oldestPendingAgeSeconds: 9,
        }),
        healthSql(),
      );
      expect(body.status).toBe(pending >= QUEUE_WARN_AT ? "degraded" : "healthy");
      expect(body.queue.status).toBe(body.status);
    }
  });
  it("a throwing measure reports unknown without making a ready DB fail", async () => {
    const body = await upBody(async () => {
      throw new Error("private SQL/credential");
    }, healthSql());
    expect(body.status).toBe("healthy");
    expect(body.queue).toEqual(unknownQueue);
    expect(body).toMatchObject({ db: "ok", pending_migrations: 0 });
  });
  it("an unconfigured queue backend retains its detail", async () => {
    const body = await upBody(null, healthSql());
    expect(body.status).toBe("healthy");
    expect(body.queue).toEqual({ ...unknownQueue, detail: "queue ledger is not configured." });
  });
});

describe("GET /up", () => {
  it("answers 200 fully migrated with the existing queue payload unchanged", async () => {
    const res = await app.request("/up", {}, withStore(healthSql({ queue: [depthRow()] })));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-two-origin")).toBe("two-web-next");
    expect(await res.json()).toEqual({
      status: "healthy",
      db: "ok",
      pending_migrations: 0,
      queue: healthyQueue,
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.getSetCookie()).toEqual([]);
  });
  it("answers 200 for queue-only degradation", async () => {
    const res = await app.request(
      "/up",
      {},
      withStore(healthSql({ queue: [depthRow({ pending: 25, total: 26 })] })),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-two-origin")).toBe("two-web-next");
    expect(await res.json()).toMatchObject({
      status: "degraded",
      db: "ok",
      pending_migrations: 0,
      queue: { status: "degraded", warn_at: QUEUE_WARN_AT, critical_at: QUEUE_CRITICAL_AT },
    });
  });
  it("stays 200 when only the queue ledger fails", async () => {
    const res = await app.request(
      "/up",
      {},
      withStore(healthSql({ queue: new Error("queue table missing") })),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-two-origin")).toBe("two-web-next");
    expect(await res.json()).toEqual({
      status: "healthy",
      db: "ok",
      pending_migrations: 0,
      queue: unknownQueue,
    });
  });
  it("answers 503 without DB configuration", async () => {
    const res = await app.request("/up", {}, env);
    expect(res.status).toBe(503);
    expect(res.headers.get("x-two-origin")).toBe("two-web-next");
    expect(await res.json()).toEqual({
      status: "degraded",
      db: "error",
      pending_migrations: null,
      queue: { ...unknownQueue, detail: "queue ledger is not configured." },
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.getSetCookie()).toEqual([]);
  });
  it("answers 503 with one missing migration, even if a newer bot row exists", async () => {
    const migrations = [...applied.filter((_, i) => i !== 1), { created_at: "9999999999999" }];
    const res = await app.request(
      "/up",
      {},
      withStore(healthSql({ migrations, queue: [depthRow()] })),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "degraded",
      db: "ok",
      pending_migrations: 1,
      queue: healthyQueue,
    });
  });
  it("answers 503 when the migration repository will not answer, preserving a successful ping", async () => {
    const res = await app.request(
      "/up",
      {},
      withStore(healthSql({ migrations: new Error("secret query"), queue: [depthRow()] })),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "degraded",
      db: "ok",
      pending_migrations: null,
      queue: healthyQueue,
    });
  });
  it("answers 503 db:error for a failed DB ping and never leaks error messages", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await app.request(
        "/up",
        {},
        withStore(
          healthSql({
            ping: new Error("private credential"),
            queue: new Error("private credential"),
          }),
        ),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        status: "degraded",
        db: "error",
        pending_migrations: null,
        queue: unknownQueue,
      });
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private credential");
    } finally {
      warning.mockRestore();
    }
  });
  it("a malformed DATABASE_URL answers 503 db:error, not 500", async () => {
    const res = await app.request("/up", {}, { ...env, DATABASE_URL: "not a url" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      db: "error",
      pending_migrations: null,
      queue: { status: "unknown" },
    });
    expect(res.headers.get("x-two-origin")).toBe("two-web-next");
  });
});

describe("/up required Worker secrets", () => {
  const secretValues = REQUIRED_SECRETS.map((name) => env[name]);
  const without = (name: string, value: "absent" | "" | "  ", base: Env) => {
    const next = { ...base } as Record<string, unknown>;
    if (value === "absent") delete next[name];
    else next[name] = value;
    return next as Env;
  };

  it("lists missing names in a fixed order and adds nothing when all are present", () => {
    expect(missingSecrets(env)).toEqual([]);
    expect(configReadiness(env)).toEqual({});
    expect(missingSecrets({})).toEqual([
      "SESSION_SECRET",
      "DISCORD_CLIENT_SECRET",
      "DISCORD_BOT_TOKEN",
    ]);
  });
  it("answers 200 with the unchanged body shape when every secret is present", async () => {
    const res = await app.request("/up", {}, withStore(healthSql({ queue: [depthRow()] })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["db", "pending_migrations", "queue", "status"]);
    expect(body).toEqual({
      status: "healthy",
      db: "ok",
      pending_migrations: 0,
      queue: healthyQueue,
    });
  });
  it.each(
    REQUIRED_SECRETS.flatMap((name) =>
      (["absent", "", "  "] as const).map((value) => [name, value] as const),
    ),
  )(
    "answers 503 config:missing when %s is %j, naming neither secret nor value",
    async (name, value) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const res = await app.request(
          "/up",
          {},
          without(name, value, withStore(healthSql({ queue: [depthRow()] }))),
        );
        expect(res.status).toBe(503);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.headers.get("x-two-origin")).toBe("two-web-next");
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({
          status: "degraded",
          db: "ok",
          pending_migrations: 0,
          config: "missing",
          queue: healthyQueue,
        });
        for (const secret of [...REQUIRED_SECRETS, ...secretValues])
          expect(text).not.toContain(secret);
        // Server-side only, names only.
        expect(warning).toHaveBeenCalledExactlyOnceWith(
          "Health check found required Worker secrets missing.",
          { missing: [name] },
        );
        for (const secret of secretValues)
          expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
      } finally {
        warning.mockRestore();
      }
    },
  );
  it("still answers 503 for a DB failure with every secret present, adding no config key", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await app.request(
        "/up",
        {},
        withStore(healthSql({ ping: new Error("down"), queue: [depthRow()] })),
      );
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        status: "degraded",
        db: "error",
        pending_migrations: null,
        queue: healthyQueue,
      });
    } finally {
      warning.mockRestore();
    }
  });
  it("reports both a DB failure and missing secrets in one 503", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const broken = REQUIRED_SECRETS.reduce((next, name) => without(name, "absent", next), env);
      const res = await app.request("/up", {}, broken);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({
        status: "degraded",
        db: "error",
        pending_migrations: null,
        config: "missing",
        queue: { ...unknownQueue, detail: "queue ledger is not configured." },
      });
      for (const name of REQUIRED_SECRETS) expect(text).not.toContain(name);
      expect(warning).toHaveBeenCalledWith("Health check found required Worker secrets missing.", {
        missing: [...REQUIRED_SECRETS],
      });
    } finally {
      warning.mockRestore();
    }
  });
  it("missing config degrades a healthy queue body without touching queue measurements", async () => {
    const body = await upBody(
      async () => ({
        pending: 1,
        delayed: 0,
        reserved: 0,
        total: 1,
        failed: 0,
        oldestPendingAgeSeconds: 1,
      }),
      healthSql(),
      { config: "missing" },
    );
    expect(body).toMatchObject({
      status: "degraded",
      db: "ok",
      pending_migrations: 0,
      config: "missing",
      queue: { status: "healthy", pending: 1 },
    });
  });
});

describe("/up transaction-local server budgets", () => {
  it.each([
    [3000, "1000ms", "750ms"],
    [450, "200ms", "199ms"],
  ])(
    "uses a read-only scoped connection and shrinks limits for %i ms remaining",
    async (remaining, statement, lock) => {
      vi.useFakeTimers();
      const query = vi.fn(async () => []);
      const tx = query as unknown as TransactionSql;
      const begin = vi.fn(
        async (_options: string, read: (tx: TransactionSql) => Promise<unknown>) => read(tx),
      );
      const read = vi.fn(async () => "measured");
      try {
        expect(
          await withHealthReadTimeout(
            { begin } as unknown as Sql,
            read,
            Date.now() + Number(remaining),
          ),
        ).toBe("measured");
        expect(begin.mock.calls[0]?.[0]).toBe("read only");
        const [strings, ...values] = query.mock.calls[0] as unknown as [
          TemplateStringsArray,
          ...unknown[],
        ];
        expect(strings.join("?")).toContain("set_config('statement_timeout', ?, true)");
        expect(strings.join("?")).toContain("set_config('lock_timeout', ?, true)");
        expect(values).toEqual([statement, lock]);
        expect(read).toHaveBeenCalledExactlyOnceWith(tx);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("starts no read when connection acquisition consumes the response budget", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => []);
    const begin = async (_options: string, read: (tx: TransactionSql) => Promise<unknown>) => {
      vi.setSystemTime(Date.now() + 2800);
      return read(query as unknown as TransactionSql);
    };
    const read = vi.fn(async () => []);
    try {
      await expect(withHealthReadTimeout({ begin } as unknown as Sql, read)).rejects.toThrow(
        "Health read deadline elapsed",
      );
      expect(query).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [1500, true],
    [1750, true],
    [1751, false],
    [2600, false],
    [2800, false],
  ])("validates the installed limit after a %i ms successful setup delay", async (delay, fits) => {
    vi.useFakeTimers();
    const query = vi.fn(async () => {
      vi.setSystemTime(Date.now() + Number(delay));
      return [];
    });
    const begin = async (_options: string, fn: (tx: TransactionSql) => Promise<unknown>) =>
      fn(query as unknown as TransactionSql);
    const read = vi.fn(async () => "measured");
    try {
      const result = withHealthReadTimeout({ begin } as unknown as Sql, read);
      if (fits) {
        expect(await result).toBe("measured");
        expect(read).toHaveBeenCalledOnce();
      } else {
        await expect(result).rejects.toThrow("Health read deadline elapsed");
        expect(read).not.toHaveBeenCalled();
      }
      const [, ...values] = query.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
      expect(values).toEqual(["1000ms", "750ms"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a previously shrunk limit when setup consumes more of the remaining budget", async () => {
    vi.useFakeTimers();
    const query = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 1);
      return [];
    });
    const begin = async (_options: string, fn: (tx: TransactionSql) => Promise<unknown>) =>
      fn(query as unknown as TransactionSql);
    const read = vi.fn(async () => []);
    try {
      await expect(
        withHealthReadTimeout({ begin } as unknown as Sql, read, Date.now() + 450),
      ).rejects.toThrow("Health read deadline elapsed");
      const [, ...values] = query.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
      expect(values).toEqual(["200ms", "199ms"]);
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed rather than issuing an unbounded read if timeout setup fails", async () => {
    const query = vi.fn(async () => {
      throw new Error("setting refused");
    });
    const begin = async (_options: string, read: (tx: TransactionSql) => Promise<unknown>) =>
      read(query as unknown as TransactionSql);
    const read = vi.fn(async () => []);
    await expect(withHealthReadTimeout({ begin } as unknown as Sql, read)).rejects.toThrow(
      "setting refused",
    );
    expect(read).not.toHaveBeenCalled();
  });
});

describe("/up bounded reads", () => {
  it.each(["ping", "migrations"] as const)(
    "a hung %s read and queue share a single 3 s response deadline",
    async (stage) => {
      vi.useFakeTimers();
      try {
        const res = Promise.resolve(
          app.request("/up", {}, withStore(healthSql({ [stage]: never, queue: never }))),
        );
        await vi.advanceTimersByTimeAsync(QUEUE_READ_TIMEOUT_MS - 1);
        let resolved = false;
        void res.then(() => {
          resolved = true;
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(resolved).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const response = await res;
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
          status: "degraded",
          db: stage === "ping" ? "error" : "ok",
          pending_migrations: null,
          queue: unknownQueue,
        });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("a late failure after timeout is handled", async () => {
    vi.useFakeTimers();
    try {
      let reject!: (error: Error) => void;
      const p = databaseReadiness(
        healthSql({
          ping: () =>
            new Promise((_, rej) => {
              reject = rej;
            }),
        }),
      );
      await vi.advanceTimersByTimeAsync(QUEUE_READ_TIMEOUT_MS);
      expect(await p).toEqual({ db: "error", pending_migrations: null });
      reject(new Error("late failure"));
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// TOG-12860: links GET /up `queue.failed` to the redrive runbook
// (docs/queue-redrive-runbook.md) against real SQL — the count /up reports is
// the dead-letter depth `listFailedJobs` inspects newest-first, one confirmed
// `discardFailedJob` drops it by exactly one, and an unreadable ledger stays
// `unknown`/`null` on a 200, never a 500. Isolated schema through
// createLedgerFixture; skipped when DATABASE_URL is unset.
describe.skipIf(!process.env.DATABASE_URL)("/up queue.failed redrive linkage", () => {
  let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
  let sql: Awaited<ReturnType<typeof createLedgerFixture>>["sql"];
  // The route reads `drizzle.__drizzle_migrations` schema-qualified, so point
  // it at this fixture's seeded ledger table (same redirect as up-db.test.ts).
  const redirectMigrations = (reader: Sql): Sql => {
    const wrap = (target: Pick<Sql, "unsafe">): Sql =>
      (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.reduce((text, part, i) => text + (i ? `$${i}` : "") + part, "");
        return target.unsafe(
          query.replaceAll("drizzle.__drizzle_migrations", "__drizzle_migrations"),
          values as Parameters<Sql["unsafe"]>[1],
          { prepare: true },
        );
      }) as unknown as Sql;
    return Object.assign(wrap(reader), {
      begin: (options: string, fn: (sql: Sql) => Promise<unknown>) =>
        reader.begin(options, (tx) => fn(wrap(tx))),
    });
  };
  const live = (n: number, tag: string) =>
    Promise.all(
      Array.from({ length: n }, (_, i) =>
        pgQueueLedger(sql).enqueued({
          jobId: crypto.randomUUID(),
          kind: "sync-event",
          key: `sync-event:${tag}-${i}`,
          availableAt: new Date(Date.now() - 1000),
        }),
      ),
    );
  const fail = async (kind: string, key: string | null, reason: string) => {
    const jobId = crypto.randomUUID();
    await pgQueueLedger(sql).enqueued({
      jobId,
      kind,
      key,
      availableAt: new Date(Date.now() - 1000),
    });
    await pgQueueLedger(sql).failed(jobId, kind, key, reason);
    return jobId;
  };
  beforeAll(async () => {
    fixture = await createLedgerFixture(process.env.DATABASE_URL!);
    sql = fixture.sql;
    await sql`create table __drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`;
    for (const entry of WEB_MIGRATIONS) {
      await sql`insert into __drizzle_migrations (hash, created_at) values (${entry.tag}, ${entry.when})`;
    }
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture.dispose();
  });

  it("queue.failed mirrors the dead letter newest-first, independent of live backlog", async () => {
    await live(5, "base");
    const first = await fail("sync-event", "sync-event:e1", "bot down");
    const second = await fail("announcement", null, "bot refused");

    // The /up count and the inspect listing read the same rows.
    expect(await pgQueueDepth(sql)).toMatchObject({ pending: 5, total: 5, failed: 2 });
    expect((await listFailedJobs(sql)).map((r) => r.jobId)).toEqual([second, first]);

    const body = await upBody(() => pgQueueDepth(sql), healthSql());
    expect(body.queue.failed).toBe(2);
    expect(body.status).toBe("healthy");

    const res = await app.request("/up", {}, withStore(redirectMigrations(sql)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "healthy", queue: { failed: 2 } });

    // Backlog crosses the warn threshold: status degrades on pending, failed unmoved.
    await live(25, "surge");
    expect(await pgQueueDepth(sql)).toMatchObject({ pending: 30, total: 30, failed: 2 });
    expect((await listFailedJobs(sql)).map((r) => r.jobId)).toEqual([second, first]);
    const degraded = await upBody(() => pgQueueDepth(sql), healthSql());
    expect(degraded.status).toBe("degraded");
    expect(degraded.queue.failed).toBe(2);
  });

  it("a confirmed discard drops queue.failed by exactly one; unknown ids change nothing", async () => {
    const keep = await fail("sync-event", "sync-event:k", "recovered elsewhere");
    const drop = await fail("announcement", null, "poison payload");
    expect((await pgQueueDepth(sql)).failed).toBe(2);

    const [dropRow] = await sql`select id from queue_failed_jobs where job_id = ${drop}::uuid`;
    expect(await discardFailedJob(sql, Number((dropRow as { id: unknown }).id))).toBe(true);
    expect((await pgQueueDepth(sql)).failed).toBe(1);
    expect((await listFailedJobs(sql)).map((r) => r.jobId)).toEqual([keep]);

    const res = await app.request("/up", {}, withStore(redirectMigrations(sql)));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ queue: { failed: 1 } });

    expect(await discardFailedJob(sql, 2_147_483_647)).toBe(false);
    expect((await pgQueueDepth(sql)).failed).toBe(1);
  });

  it("an unreadable ledger reports unknown with failed null on a 200, never a 500", async () => {
    await fail("sync-event", "sync-event:x", "transport error");
    expect((await pgQueueDepth(sql)).failed).toBe(1);
    await sql`drop table queue_failed_jobs`;
    try {
      const body = await upBody(() => pgQueueDepth(sql), healthSql());
      expect(body.status).toBe("healthy");
      expect(body.queue).toMatchObject({ status: "unknown", failed: null });

      // Real SQL end to end: the DB gate stays ok, so the route stays 200.
      const res = await app.request("/up", {}, withStore(redirectMigrations(sql)));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        status: "healthy",
        db: "ok",
        pending_migrations: 0,
        queue: { status: "unknown", failed: null },
      });
    } finally {
      await sql`create table queue_failed_jobs (like public.queue_failed_jobs including all)`;
    }
  });
});
