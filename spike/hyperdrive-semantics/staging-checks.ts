// Fixed W1 synthetic checks; no SQL, schema or connection URL is caller-selected.
// Kept separate from the local-only Worker: Hyperdrive requires prepared queries.
import postgres from "postgres";
type Sql = ReturnType<typeof postgres>;
type Stage = "connect" | "create_schema" | "setup" | "a" | "b" | "c" | "cleanup" | "close";
type Check = {
  name: string;
  pass: boolean;
  detail: string;
  status: "passed" | "failed" | "not_attempted";
};
export type SchemaState = {
  schema: string;
  created: boolean | "not_verified";
  cleanup: boolean | "not_verified";
};
export class StagingCheckFailure extends Error {
  constructor(readonly result: StagingResult) {
    super("staging_probe_failed");
  }
}
export type StagingResult = SchemaState & {
  ok: boolean;
  version?: string;
  passed: number;
  total: number;
  checks: Check[];
  failedStage?: Stage;
  teardownFailures: Stage[];
};
// The driver implements simple, but 3.4.9's UnsafeQueryOptions omits its type.
const preparedQueryOptions = { prepare: true, simple: false };
export const query = (
  client: Pick<Sql, "unsafe">,
  statement: string,
  parameters: (number | string)[] = [],
) => client.unsafe(statement, parameters, preparedQueryOptions);

export async function runFixedStagingChecks(
  open: () => Sql,
  report?: (state: SchemaState) => void,
) {
  const schema = "w1_staging_" + crypto.randomUUID().replaceAll("-", "");
  const checks: Check[] = ["(a) FOR UPDATE", "(b) advisory xact lock", "(c) jsonb+GIN"].map(
    (name) => ({ name, pass: false, status: "not_attempted", detail: "not_attempted" }),
  );
  let stage: Stage = "connect";
  let failedStage: Stage | undefined;
  const teardownFailures: Stage[] = [];
  const recordFailure = () => {
    failedStage ??= stage;
    if (stage === "cleanup" || stage === "close") teardownFailures.push(stage);
    const index = ["a", "b", "c"].indexOf(stage);
    if (index >= 0 && checks[index]!.status === "not_attempted") {
      checks[index] = { ...checks[index]!, status: "failed", detail: "stage_exception" };
    }
  };
  const complete = (index: number, check: Omit<Check, "status">) => {
    checks[index] = { ...check, status: check.pass ? "passed" : "failed" };
  };
  const clients: Sql[] = [];
  const connect = () => {
    const client = open();
    clients.push(client);
    return client;
  };
  let created: SchemaState["created"] = false;
  let cleaned: SchemaState["cleanup"] = true;
  let serverVersion: string | undefined;
  try {
    const admin = connect();
    try {
      const [server] = await admin`SELECT version() AS version`;
      if (!server) throw new Error("missing_server_version");
      serverVersion = String(server.version);
      // Persist identity before CREATE: a lost acknowledgement is not proof of refusal.
      stage = "create_schema";
      created = "not_verified";
      cleaned = "not_verified";
      report?.({ schema, created, cleanup: cleaned });
      try {
        await query(admin, `CREATE SCHEMA ${schema}`);
      } catch (err) {
        // Only explicit server refusals establish that this invocation created nothing.
        if (["42P06", "42501"].includes((err as { code?: string }).code ?? "")) {
          created = false;
          cleaned = true;
          report?.({ schema, created, cleanup: cleaned });
        }
        throw err;
      }
      created = true;
      cleaned = "not_verified";
      report?.({ schema, created, cleanup: cleaned });
      stage = "setup";
      await query(
        admin,
        `CREATE TABLE ${schema}.spike_events (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_key text NOT NULL UNIQUE, status text NOT NULL, capacity integer NULL,
        starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL)`,
      );
      await query(
        admin,
        `CREATE TABLE ${schema}.spike_rsvps (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_id bigint NOT NULL REFERENCES ${schema}.spike_events (id) ON DELETE CASCADE,
        user_id bigint NOT NULL, status text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (event_id, user_id))`,
      );
      await query(
        admin,
        `CREATE TABLE ${schema}.spike_access_logs (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        viewer_discord_id text NOT NULL, viewer_user_id bigint NULL,
        resource text NOT NULL, action text NOT NULL,
        subject_user_ids jsonb NOT NULL, subject_count integer NOT NULL,
        route text NULL, occurred_at timestamptz NOT NULL)`,
      );
      await query(
        admin,
        `CREATE INDEX spike_access_logs_subject_user_ids_gin
        ON ${schema}.spike_access_logs USING gin (subject_user_ids jsonb_path_ops)`,
      );
      await query(
        admin,
        `INSERT INTO ${schema}.spike_events
        (event_key, status, capacity, starts_at, ends_at)
        VALUES ('evt-cap1', 'published', 1, now(), now() + interval '1 hour')`,
      );

      // (a) Establish holder first; a bounded SQL timeout proves actual contention.
      stage = "a";
      const a = connect();
      const b = connect();
      // postgres.js 3.4.9 can leave a fresh reserve() pending with fetch_types:false.
      // Warm both bounded connections before reserving transaction-local clients.
      // VOLATILE reads bypass enabled Hyperdrive caching without changing the resource.
      // Source: https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
      await a`SELECT random()`;
      await b`SELECT random()`;
      const ra = await a.reserve();
      try {
        const rb = await b.reserve();
        try {
          await ra`BEGIN`;
          const [event] = await query(
            ra,
            `SELECT id, random() FROM ${schema}.spike_events
            WHERE event_key = 'evt-cap1' FOR UPDATE`,
          );
          if (!event) throw new Error("missing_event");
          await rb`BEGIN`;
          await rb`SET LOCAL lock_timeout = '250ms'`;
          let blocked = false;
          try {
            await query(
              rb,
              `SELECT id, random() FROM ${schema}.spike_events WHERE event_key = 'evt-cap1' FOR UPDATE`,
            );
          } catch (err) {
            if ((err as { code?: string }).code !== "55P03") throw err;
            blocked = true;
          }
          await rb`ROLLBACK`;
          await query(
            ra,
            `INSERT INTO ${schema}.spike_rsvps (event_id, user_id, status)
            VALUES ($1, 11, 'going')`,
            [event.id],
          );
          await ra`COMMIT`;
          // Retry under the same event lock and execute the capacity decision.
          await rb`BEGIN`;
          const [capacity] = await query(
            rb,
            `SELECT capacity, random() FROM ${schema}.spike_events
            WHERE id = $1 FOR UPDATE`,
            [event.id],
          );
          const [count] = await query(
            rb,
            `SELECT count(*)::int AS n, random() FROM ${schema}.spike_rsvps
            WHERE event_id = $1 AND status = 'going'`,
            [event.id],
          );
          if (!capacity || !count) throw new Error("missing_capacity_count");
          const refused = count.n >= capacity.capacity;
          if (!refused)
            await query(
              rb,
              `INSERT INTO ${schema}.spike_rsvps (event_id, user_id, status)
            VALUES ($1, 22, 'going')`,
              [event.id],
            );
          await rb`COMMIT`;
          complete(0, {
            name: "(a) FOR UPDATE",
            pass: blocked && refused && count.n === 1,
            detail: `blocked_55P03=${blocked} second_seat_refused=${refused} going=${count.n}`,
          });

          // (b) Transaction-scoped single-flight. No session-lock pooler claim.
          stage = "b";
          await ra`BEGIN`;
          const [key] = await ra`SELECT pg_backend_pid() AS id, random()`;
          if (!key) throw new Error("missing_lock_key");
          await ra`SELECT pg_advisory_xact_lock(${key.id})`;
          await rb`BEGIN`;
          const [held] = await rb`SELECT pg_try_advisory_xact_lock(${key.id}) AS ok`;
          await ra`COMMIT`;
          const [free] = await rb`SELECT pg_try_advisory_xact_lock(${key.id}) AS ok`;
          await rb`COMMIT`;
          if (!held || !free) throw new Error("missing_advisory_result");
          complete(1, {
            name: "(b) advisory xact lock",
            pass: held.ok === false && free.ok === true,
            detail: `concurrent_refused=${held.ok === false} reacquired=${free.ok === true}`,
          });
        } finally {
          try {
            await rb`ROLLBACK`;
          } finally {
            rb.release();
          }
        }
      } finally {
        try {
          await ra`ROLLBACK`;
        } finally {
          ra.release();
        }
      }

      // (c) Native containment and planner index use, not a forced index plan.
      stage = "c";
      await query(
        admin,
        `INSERT INTO ${schema}.spike_access_logs
        (viewer_discord_id, resource, action, subject_user_ids, subject_count, route, occurred_at)
        SELECT 'snowflake-' || (g % 50), 'member', 'view',
          jsonb_build_array(1000 + g, 2000 + (g % 97)), 2, 'members.index', now()
        FROM generate_series(0, 1999) g`,
      );
      await query(
        admin,
        `INSERT INTO ${schema}.spike_access_logs
        (viewer_discord_id, resource, action, subject_user_ids, subject_count, route, occurred_at)
        VALUES ('snowflake-7', 'member', 'list', '[424242, 1001]', 2, 'members.index', now())`,
      );
      await query(admin, `ANALYZE ${schema}.spike_access_logs`);
      const plan = await query(
        admin,
        `EXPLAIN (COSTS OFF) SELECT id, random() FROM ${schema}.spike_access_logs
        WHERE subject_user_ids @> '[424242]'::jsonb`,
      );
      const [count] = await query(
        admin,
        `SELECT count(*)::int AS n, random() FROM ${schema}.spike_access_logs
        WHERE subject_user_ids @> '[424242]'::jsonb`,
      );
      if (!count) throw new Error("missing_containment_count");
      const usesGin = plan.some((row) =>
        String(row["QUERY PLAN"]).includes("spike_access_logs_subject_user_ids_gin"),
      );
      complete(2, {
        name: "(c) jsonb+GIN",
        pass: usesGin && count.n === 1,
        detail: `uses_gin=${usesGin} rows=2001 hits=${count.n}`,
      });
    } catch {
      recordFailure();
    } finally {
      // An unacknowledged CREATE does not establish ownership: retain its exact name
      // for recovery, but never DROP an uncertain or explicitly pre-existing schema.
      if (created === true) {
        stage = "cleanup";
        await query(admin, `DROP SCHEMA ${schema} CASCADE`);
        const [remaining] =
          await admin`SELECT count(*)::int AS n, random() FROM pg_namespace WHERE nspname = ${schema}`;
        if (remaining?.n !== 0) throw new Error("schema_cleanup_not_verified");
        cleaned = true;
        report?.({ schema, created, cleanup: true });
      }
    }
  } catch {
    recordFailure();
  } finally {
    // Attempt every close even when one connection refuses to terminate.
    const closed = await Promise.allSettled(
      clients.map(async (client) => client.end({ timeout: 2 })),
    );
    if (closed.some((result) => result.status === "rejected")) {
      stage = "close";
      recordFailure();
    }
  }
  const passed = checks.filter((check) => check.pass).length;
  const result: StagingResult = {
    ok: !failedStage && passed === 3 && cleaned === true,
    schema,
    created,
    version: serverVersion,
    passed,
    total: 3,
    checks,
    cleanup: cleaned,
    failedStage,
    teardownFailures,
  };
  if (failedStage) throw new StagingCheckFailure(result);
  return result;
}
