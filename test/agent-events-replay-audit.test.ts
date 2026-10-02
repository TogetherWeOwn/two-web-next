import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, digest, handleAgentEvent, type Answer } from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const CALLER = "replay-audit-fixture";
const cfg = { ...DEFAULT_CONFIG, enabled: true, callerAgentId: CALLER, lockWaitMs: 5000 };
const fields = {
  title: "Synthetic replay proof",
  game: "Chess",
  description: "No live event",
  starts_at: "2099-07-01 20:00",
  ends_at: "2099-07-01 22:00",
  timezone: "Europe/London",
  location: "Fixture",
  capacity: 2,
};

// Force every initial lookup to observe a miss before any operation starts. All
// SQL, transactions and advisory locks remain real; no sleep or mocked receipt.
function racedClient(client: postgres.Sql, deliveries: number) {
  let arrivals = 0;
  let racedReplays = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const isLookup = (args: unknown[]) =>
    Array.isArray(args[0]) &&
    args[0].join("").includes("SELECT payload_digest, status, body, event_key");
  const wrapTx = (tx: postgres.TransactionSql) =>
    new Proxy(tx, {
      apply: async (target, thisArg, args) => {
        const rows = await Reflect.apply(target, thisArg, args);
        if (isLookup(args) && rows.length) racedReplays++;
        return rows;
      },
    });
  const sql = new Proxy(client, {
    apply: async (target, thisArg, args) => {
      const rows = await Reflect.apply(target, thisArg, args);
      if (isLookup(args)) {
        expect(rows).toHaveLength(0);
        if (++arrivals === deliveries) release();
        await ready;
      }
      return rows;
    },
    get: (target, prop) =>
      prop === "begin"
        ? (fn: (tx: postgres.TransactionSql) => Promise<unknown>) =>
            target.begin((tx) => fn(wrapTx(tx)))
        : Reflect.get(target, prop),
  });
  return { sql, racedReplays: () => racedReplays };
}

describe.skipIf(!process.env.DATABASE_URL)(
  "successful replay audit receipts (isolated agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let sql: postgres.Sql;
    let eventTable: "agent_events" | "events";
    const writeBack = vi.fn(async () => {});
    const observe = vi.fn(async () => ({
      unavailable: "verification_unavailable",
      reason: "fixture",
    }));

    beforeAll(async () => {
      const url = testDatabaseUrl(process.env.DATABASE_URL!);
      fixture = await createMemberDataFixture(url.href, { max: 8 });
      // Standalone postgres client, without Drizzle's JSON serializers. This also
      // exercises the shared-event service when its migration replaces agent_events.
      sql = postgres(url.href, {
        max: 8,
        port: 5432,
        password: () => url.password,
        connection: { search_path: fixture.schemaName },
        onnotice: () => {},
      });
      const [tables] = await sql`SELECT to_regclass('agent_events') AS standalone`;
      eventTable = tables!.standalone ? "agent_events" : "events";
    });
    afterAll(async () => {
      await sql?.end();
      await fixture?.dispose();
    });

    async function caller() {
      const credential = `synthetic-replay-${randomUUID()}`;
      const verifier = await sha256Hex(credential);
      const [grant] =
        await sql`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      VALUES (${CALLER}, 'fixture-company', ${cfg.stagingGuildId}, ${verifier}) RETURNING id`;
      const grantId = grant!.id as string;
      const call = (body: unknown, config = cfg, client = sql): Promise<Answer> =>
        // Main has no effects argument; the shared-event head uses these hermetic
        // seams. Extra arguments are inert on main, never a live queue/bot binding.
        Reflect.apply(handleAgentEvent, undefined, [
          client,
          config,
          body,
          credential,
          null,
          { writeBack, observe },
        ]);
      const receipts = (key: string) => sql`SELECT * FROM agent_event_audits
      WHERE grant_id = ${grantId} AND idempotency_key = ${key} ORDER BY id`;
      const stored = (key: string) => sql`SELECT * FROM agent_event_idempotency_keys
      WHERE grant_id = ${grantId} AND key = ${key}`;
      const event = () =>
        sql.unsafe(`SELECT * FROM ${eventTable} WHERE agent_grant_id = $1`, [grantId]);
      const hits = () => sql`SELECT bucket, count(*)::int AS n FROM agent_event_hits
      WHERE bucket IN (${`mutating:${grantId}`}, ${`read:${grantId}`}, ${`shield:${verifier}`}) GROUP BY bucket ORDER BY bucket`;
      const secretFree = async () => {
        const dump = JSON.stringify(await sql`SELECT * FROM agent_event_audits`);
        expect(dump).not.toContain(credential);
        expect(dump).not.toContain(verifier);
      };
      return { call, receipts, stored, event, hits, secretFree, grantId };
    }

    it("audits a fast replay and a conflict once each with fresh response IDs, preserving original evidence", async () => {
      const c = await caller();
      const key = randomUUID();
      const body = { op: "create", idempotency_key: key, fields };
      const first = await c.call(body);
      expect(first.status).toBe(201);
      const saved = await c.stored(key);
      const originalEvent = await c.event();
      const replay = await c.call({ fields: { ...fields }, idempotency_key: key, op: "create" });
      expect(replay).toEqual({
        status: first.status,
        body: { ...first.body, replayed: true, request_id: replay.body.request_id },
      });
      expect(replay.body.request_id).not.toBe(first.body.request_id);
      const conflictBody = { ...body, fields: { ...fields, title: "Changed payload" } };
      const conflict = await c.call(conflictBody);
      expect(conflict.status).toBe(409);
      const rows = await c.receipts(key);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => [r.request_id, r.result, r.reason_code])).toEqual([
        [first.body.request_id, "ok", null],
        [replay.body.request_id, "replayed", null],
        [conflict.body.request_id, "conflict", "idempotency_conflict"],
      ]);
      expect(rows.map((r) => r.payload_digest)).toEqual([
        await digest(body),
        await digest(body),
        await digest(conflictBody),
      ]);
      expect(
        rows.every((r) => r.event_key === first.body.event_key && r.operation === "create"),
      ).toBe(true);
      expect(await c.stored(key)).toEqual(saved);
      expect(await c.event()).toEqual(originalEvent);
      await c.secretFree();
    });

    it("replays all five operations without changing events, receipt snapshots, inner budgets or effects", async () => {
      const c = await caller();
      writeBack.mockClear();
      observe.mockClear();
      const requests = [
        { op: "create", fields },
        { op: "read" },
        { op: "update", version: 1, fields: { ...fields, title: "Version two" } },
        { op: "publish" },
        { op: "cancel" },
      ];
      for (const request of requests) {
        const key = randomUUID();
        const body = { ...request, idempotency_key: key };
        const first = await c.call(body);
        expect(first.status).toBe(request.op === "create" ? 201 : 200);
        const saved = await c.stored(key);
        const event = await c.event();
        const hits = await c.hits();
        const writes = writeBack.mock.calls.length;
        const reads = observe.mock.calls.length;
        const replay = await c.call(body);
        expect(replay).toEqual({
          status: first.status,
          body: { ...first.body, replayed: true, request_id: replay.body.request_id },
        });
        expect(replay.body.request_id).not.toBe(first.body.request_id);
        expect(await c.receipts(key)).toHaveLength(2);
        expect(await c.stored(key)).toEqual(saved);
        expect(await c.event()).toEqual(event);
        const after = await c.hits();
        expect(after.filter((r) => !r.bucket.startsWith("shield:"))).toEqual(
          hits.filter((r) => !r.bucket.startsWith("shield:")),
        );
        expect(after.find((r) => r.bucket.startsWith("shield:"))!.n).toBe(
          hits.find((r) => r.bucket.startsWith("shield:"))!.n + 1,
        );
        expect(writeBack.mock.calls).toHaveLength(writes);
        expect(observe.mock.calls).toHaveLength(reads);
      }
      expect(writeBack.mock.calls).toHaveLength(eventTable === "events" ? 2 : 0);
      await c.secretFree();
    });

    it("concurrent identical creates mutate once and audit every delivery through the raced path", async () => {
      const c = await caller();
      const key = randomUUID();
      const body = { op: "create", idempotency_key: key, fields };
      const race = racedClient(sql, 6);
      const answers = await Promise.all(
        Array.from({ length: 6 }, () => c.call(body, cfg, race.sql)),
      );
      expect(answers.map((r) => r.status)).toEqual(Array(6).fill(201));
      expect(answers.filter((r) => r.body.replayed !== true)).toHaveLength(1);
      expect(race.racedReplays()).toBe(5);
      expect(await c.event()).toHaveLength(1);
      expect(await c.stored(key)).toHaveLength(1);
      const rows = await c.receipts(key);
      expect(rows).toHaveLength(6);
      expect(rows.filter((r) => r.result === "ok")).toHaveLength(1);
      expect(rows.filter((r) => r.result === "replayed")).toHaveLength(5);
      expect(new Set(rows.map((r) => r.request_id))).toEqual(
        new Set(answers.map((r) => r.body.request_id)),
      );
      expect(new Set(rows.map((r) => r.event_key)).size).toBe(1);
      const original = answers.find((r) => !r.body.replayed)!;
      for (const answer of answers)
        expect(answer.body).toMatchObject({
          event_key: original.body.event_key,
          agent_version: 1,
          proof_marker: original.body.proof_marker,
        });
      await c.secretFree();
    });

    it("a raced publish audits each delivery but dispatches only the original operation", async () => {
      const c = await caller();
      expect((await c.call({ op: "create", fields, idempotency_key: randomUUID() })).status).toBe(
        201,
      );
      writeBack.mockClear();
      const key = randomUUID();
      const body = { op: "publish", idempotency_key: key };
      const race = racedClient(sql, 3);
      const answers = await Promise.all(
        Array.from({ length: 3 }, () => c.call(body, cfg, race.sql)),
      );
      expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(race.racedReplays()).toBe(2);
      expect(await c.receipts(key)).toHaveLength(3);
      expect(writeBack.mock.calls).toHaveLength(eventTable === "events" ? 1 : 0);
      expect(await c.event()).toMatchObject([{ status: "published", agent_version: 1 }]);
    });

    it("exempts fast replay from spent inner budgets but preserves the outer shield's no-write denial", async () => {
      const c = await caller();
      const key = randomUUID();
      const body = { op: "create", idempotency_key: key, fields };
      const small = {
        ...cfg,
        mutatingPerMinute: 1,
        serviceMutatingPerMinute: 100,
        routePerMinute: 3,
      };
      const first = await c.call(body, small);
      expect(first.status).toBe(201);
      const replay = await c.call(body, small);
      expect(replay.status).toBe(201);
      expect(replay.body.replayed).toBe(true);
      expect(await c.receipts(key)).toHaveLength(2);
      const limited = await c.call({ op: "publish", idempotency_key: randomUUID() }, small);
      expect(limited.status).toBe(429);
      const audits = await sql`SELECT * FROM agent_event_audits WHERE grant_id = ${c.grantId}`;
      const hits = await c.hits();
      expect((await c.call(body, small)).status).toBe(429);
      expect(await sql`SELECT * FROM agent_event_audits WHERE grant_id = ${c.grantId}`).toEqual(
        audits,
      );
      expect(await c.hits()).toEqual(hits);
    });

    it.each(["grant", "audit table"] as const)(
      "bounds fast replay and its failure receipt while the %s is locked",
      async (lockedResource) => {
        const c = await caller();
        const key = randomUUID();
        const body = { op: "create", idempotency_key: key, fields };
        const small = { ...cfg, lockWaitMs: 50 };
        const first = await c.call(body, small);
        expect(first.status).toBe(201);
        const saved = await c.stored(key);
        const event = await c.event();
        const hits = await c.hits();
        const writes = writeBack.mock.calls.length;
        const reads = observe.mock.calls.length;
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let signal!: () => void;
        const locked = new Promise<void>((resolve) => {
          signal = resolve;
        });
        const rollback = new Error("fixture lock rollback");
        const holder = sql
          .begin(async (tx) => {
            // The grant row lock a provisioning DELETE would take. The DELETE itself is
            // refused once audits reference the grant (append-only audits, 1018).
            if (lockedResource === "grant")
              await tx`SELECT id FROM agent_event_grants WHERE id = ${c.grantId} FOR UPDATE`;
            else await tx`LOCK TABLE agent_event_audits IN ACCESS EXCLUSIVE MODE`;
            signal();
            await held;
            throw rollback;
          })
          .catch((err) => {
            if (err !== rollback) throw err;
          });
        let pending: Promise<Answer> | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let busy!: Answer;
        try {
          await Promise.race([
            locked,
            holder.then(() => {
              throw new Error("lock holder ended before release");
            }),
          ]);
          pending = c.call(body, small);
          busy = await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      "fast replay or failure receipt blocked beyond 750ms with lockWaitMs=50",
                    ),
                  ),
                750,
              );
            }),
          ]);
          // Assert before releasing the lock: cleanup cannot mask a hung request.
          expect(busy.status).toBe(503);
          expect(busy.body.reason).toBe("operation_busy");
          expect(busy.body.request_id).not.toBe(first.body.request_id);
          expect(busy.body.replayed).toBeUndefined();
        } finally {
          if (timer) clearTimeout(timer);
          release();
          await holder;
          await pending;
        }
        const rows =
          await sql`SELECT * FROM agent_event_audits WHERE idempotency_key = ${key} ORDER BY id`;
        expect(rows.filter((r) => r.result === "replayed")).toHaveLength(0);
        if (lockedResource === "grant") {
          expect(rows).toHaveLength(2);
          expect(rows[1]).toMatchObject({
            grant_id: null,
            event_key: first.body.event_key,
            operation: "create",
            request_id: busy.body.request_id,
            result: "error",
            reason_code: "operation_busy",
            payload_digest: await digest(body),
          });
        } else expect(rows).toHaveLength(1); // No receipt is writable under a table lock; never claim success.
        expect(await c.stored(key)).toEqual(saved);
        expect(await c.event()).toEqual(event);
        const after = await c.hits();
        expect(after.filter((r) => !r.bucket.startsWith("shield:"))).toEqual(
          hits.filter((r) => !r.bucket.startsWith("shield:")),
        );
        expect(after.find((r) => r.bucket.startsWith("shield:"))!.n).toBe(
          hits.find((r) => r.bucket.startsWith("shield:"))!.n + 1,
        );
        expect(writeBack.mock.calls).toHaveLength(writes);
        expect(observe.mock.calls).toHaveLength(reads);
        const retry = await c.call(body, small);
        expect(retry).toEqual({
          status: first.status,
          body: { ...first.body, replayed: true, request_id: retry.body.request_id },
        });
        expect(retry.body.request_id).not.toBe(busy.body.request_id);
        expect((await c.receipts(key)).filter((r) => r.result === "replayed")).toHaveLength(1);
        expect(await c.stored(key)).toEqual(saved);
        expect(await c.event()).toEqual(event);
        await c.secretFree();
      },
    );

    it("retains historical double-encoded replay evidence on the shared-event head", async (context) => {
      // PR #124 owns decoding compatibility. Main's standalone client stores
      // objects; do not port or alter the adjacent serializer fix in this slice.
      if (eventTable !== "events")
        context.skip("Historical decoding belongs to PR #124, not standalone main");
      const c = await caller();
      const key = randomUUID();
      const body = { op: "create", idempotency_key: key, fields };
      const first = await c.call(body);
      await sql`UPDATE agent_event_idempotency_keys SET body = ${JSON.stringify(JSON.stringify(first.body))}::text::jsonb
      WHERE grant_id = ${c.grantId} AND key = ${key}`;
      const saved = await c.stored(key);
      const replay = await c.call(body);
      expect(replay.body).toEqual({
        ...first.body,
        replayed: true,
        request_id: replay.body.request_id,
      });
      expect(await c.stored(key)).toEqual(saved);
      expect(await c.receipts(key)).toHaveLength(2);
    });
  },
);
