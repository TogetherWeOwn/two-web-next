import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkJoinThrottle, migrateJoin } from "../src/join/service";
import type { Sql } from "../src/sessions";
import { testDatabaseUrl } from "./helpers/member-data-db";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("preserves missing-store admission", async () => {
  expect(await checkJoinThrottle(null, "join:missing", 10)).toEqual({ limited: false });
});

// Only isolated agent-testdb / CI Postgres is permitted, before any connection.
const raw = process.env.DATABASE_URL;
describe.skipIf(!raw)("human throttle real-transaction admission", () => {
  const schemaName = `throttle_${randomUUID().replaceAll("-", "")}`;
  const applicationName = schemaName;
  let admin: postgres.Sql;
  let client: postgres.Sql;
  let sql: Sql;
  let created = false;

  beforeAll(async () => {
    const url = testDatabaseUrl(raw!);
    const options = {
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      onnotice: () => {},
    };
    admin = postgres(url.href, { ...options, max: 1 });
    client = postgres(url.href, {
      ...options,
      max: 16,
      connection: { search_path: schemaName, application_name: applicationName },
    });
    sql = client as unknown as Sql;
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    await migrateJoin(sql);
  });

  beforeEach(async () => {
    await client`DELETE FROM web_throttle_hits`;
  });

  afterAll(async () => {
    try {
      await client?.end({ timeout: 1 });
      if (created) await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
    } finally {
      await admin?.end({ timeout: 1 });
    }
  });

  const waiting = async () => {
    const [row] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name = ${applicationName} AND wait_event_type = 'Lock'`;
    return row!.n;
  };

  it.each([10, 30])(
    "admits exactly one of eight concurrent requests with one of %i tokens left",
    async (max) => {
      const bucket = `human:${max}:burst`;
      await client`INSERT INTO web_throttle_hits (bucket, at)
      SELECT ${bucket}, clock_timestamp() FROM generate_series(1, ${max - 1})`;
      const ready = deferred();
      const release = deferred();
      const holder = client.begin(async (tx) => {
        // Counts can run, but no admission INSERT can finish before release.
        await tx`LOCK TABLE web_throttle_hits IN SHARE MODE`;
        ready.resolve();
        await release.promise;
      });
      await ready.promise;
      const burst = Promise.all(
        Array.from({ length: 8 }, () => checkJoinThrottle(sql, bucket, max)),
      );
      try {
        await expect.poll(waiting, { interval: 10, timeout: 5000 }).toBe(8);
      } finally {
        release.resolve();
        await holder;
      }
      const verdicts = await burst;
      expect(verdicts.filter((v) => !v.limited)).toHaveLength(1);
      for (const verdict of verdicts) {
        if (verdict.limited) expect(verdict.retryAfter).toBeGreaterThan(0);
      }
      const [row] = await client<
        { n: number }[]
      >`SELECT count(*)::int AS n FROM web_throttle_hits WHERE bucket = ${bucket}`;
      expect(row!.n).toBe(max);
    },
  );

  it("does not block an independent bucket while another bucket's admission is waiting", async () => {
    const ready = deferred();
    const release = deferred();
    const bucket = "human:locked";
    const holder = client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`web-throttle:${bucket}`}, 0))`;
      ready.resolve();
      await release.promise;
    });
    await ready.promise;
    const blocked = checkJoinThrottle(sql, bucket, 10);
    let independent: ReturnType<typeof checkJoinThrottle> | undefined;
    try {
      await expect.poll(waiting, { interval: 10, timeout: 5000 }).toBe(1);
      independent = checkJoinThrottle(sql, "human:independent", 10);
      await expect
        .poll(
          async () => {
            const [row] = await client<{ n: number }[]>`
          SELECT count(*)::int AS n FROM web_throttle_hits
          WHERE bucket = 'human:independent'`;
            return row!.n;
          },
          { interval: 10, timeout: 5000 },
        )
        .toBe(1);
    } finally {
      release.resolve();
      await holder;
      await Promise.all([blocked, independent]);
    }
    expect(await independent).toEqual({ limited: false });
    expect(await blocked).toEqual({ limited: false });
  });

  it.each([10, 30])(
    "preserves the sequential %i/min budget and active-window Retry-After",
    async (max) => {
      const bucket = `human:${max}:sequential`;
      for (let i = 0; i < max; i++)
        expect(await checkJoinThrottle(sql, bucket, max)).toEqual({ limited: false });
      expect(await checkJoinThrottle(sql, bucket, max)).toEqual({
        limited: true,
        retryAfter: expect.any(Number),
      });
      await client`UPDATE web_throttle_hits SET at = clock_timestamp() - interval '45 seconds' WHERE bucket = ${bucket}`;
      const verdict = await checkJoinThrottle(sql, bucket, max);
      expect(verdict.limited).toBe(true);
      if (verdict.limited) expect(verdict.retryAfter).toBeGreaterThan(0);
      if (verdict.limited) expect(verdict.retryAfter).toBeLessThanOrEqual(15);
      await client`UPDATE web_throttle_hits SET at = clock_timestamp() - interval '61 seconds' WHERE bucket = ${bucket}`;
      expect(await checkJoinThrottle(sql, bucket, max)).toEqual({ limited: false });
      const [row] = await client<{ n: number }[]>`
      SELECT count(*)::int AS n FROM web_throttle_hits WHERE bucket = ${bucket} AND at > clock_timestamp() - interval '60 seconds'`;
      expect(row!.n).toBe(1);
    },
  );

  it("uses post-lock time for expiry, hit timestamps and five-minute cleanup", async () => {
    const bucket = "human:expiry";
    await client`INSERT INTO web_throttle_hits (bucket, at) VALUES
      (${bucket}, clock_timestamp() - interval '59 seconds'),
      ('expired:cleanup', clock_timestamp() - interval '6 minutes')`;
    const ready = deferred();
    const release = deferred();
    let releasedAt: Date;
    const holder = client.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`web-throttle:${bucket}`}, 0))`;
      ready.resolve();
      await release.promise;
      const [row] = await tx<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
      releasedAt = row!.at;
    });
    await ready.promise;
    const admission = checkJoinThrottle(sql, bucket, 1);
    try {
      await expect.poll(waiting, { interval: 10, timeout: 5000 }).toBe(1);
      await admin`SELECT pg_sleep(1.1)`;
    } finally {
      release.resolve();
      await holder;
    }
    expect(await admission).toEqual({ limited: false });
    const hits = await client<
      { bucket: string; at: Date }[]
    >`SELECT bucket, at FROM web_throttle_hits ORDER BY at`;
    expect(hits.filter((hit) => hit.bucket === "expired:cleanup")).toHaveLength(0);
    expect(hits.filter((hit) => hit.bucket === bucket)).toHaveLength(2);
    expect(hits.at(-1)!.at.getTime()).toBeGreaterThanOrEqual(releasedAt!.getTime());
  });
});
