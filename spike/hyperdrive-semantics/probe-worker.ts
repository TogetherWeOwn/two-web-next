// W1 local Worker control probe. This does NOT verify the Hyperdrive pooler.
// Only agent-testdb is permitted; no remote dev, staging, or production target.
import { Hono } from "hono";
import postgres from "postgres";

// Local binding arrives as a plain `vars` string (see wrangler.probe.jsonc:
// a Hyperdrive binding cannot express the passwordless test container).
// The `DB` Hyperdrive shape stays as a fallback for direct injection.
type Env = { TEST_DB_CONNECTION_STRING?: string; DB?: { connectionString: string } };
type Check = { name: string; pass: boolean; detail: string };

export function isTestDatabase(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.hostname === "agent-testdb" && (url.port === "" || url.port === "5432") &&
      url.username === "agent_test" && url.password === "" &&
      url.pathname === "/agent_test" && url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

const app = new Hono<{ Bindings: Env }>();

app.post("/spike-run", async (c) => {
  const cs = c.env.TEST_DB_CONNECTION_STRING ?? c.env.DB?.connectionString;
  // Reject before opening a connection or executing any SQL. Do not print URLs.
  if (!cs || !isTestDatabase(cs)) return c.json({ ok: false, error: "test_database_required" }, 400);
  if (new URL(c.req.url).search) return c.json({ ok: false, error: "query_options_not_supported" }, 400);
  const schema = "w1_spike_" + crypto.randomUUID().replaceAll("-", "");
  const clients: ReturnType<typeof postgres>[] = [];
  const open = () => {
    // Do not let omitted URL fields select ambient PGPORT/PGPASSWORD values.
    // postgres.js treats an empty password string as absent; a function is explicit.
    const sql = postgres({
      host: "agent-testdb", port: 5432, username: "agent_test", database: "agent_test",
      password: () => "", ssl: false,
      max: 1, fetch_types: false, prepare: false, connect_timeout: 5,
      connection: { application_name: "w1-local-control", statement_timeout: 5000, lock_timeout: 2000 },
    });
    clients.push(sql);
    return sql;
  };
  const checks: Check[] = [];
  const admin = open();
  let created = false;
  try {
    const [server] = await admin`SELECT version() AS version`;
    if (!server) throw new Error("missing_server_version");
    // Never drop a pre-existing schema. Cleanup owns only this invocation's UUID.
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    created = true;
    await admin.unsafe(`CREATE TABLE ${schema}.spike_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_key text NOT NULL UNIQUE, status text NOT NULL, capacity integer NULL,
      starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL)`);
    await admin.unsafe(`CREATE TABLE ${schema}.spike_rsvps (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_id bigint NOT NULL REFERENCES ${schema}.spike_events (id) ON DELETE CASCADE,
      user_id bigint NOT NULL, status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (event_id, user_id))`);
    await admin.unsafe(`CREATE TABLE ${schema}.spike_access_logs (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      viewer_discord_id text NOT NULL, viewer_user_id bigint NULL,
      resource text NOT NULL, action text NOT NULL,
      subject_user_ids jsonb NOT NULL, subject_count integer NOT NULL,
      route text NULL, occurred_at timestamptz NOT NULL)`);
    await admin.unsafe(`CREATE INDEX spike_access_logs_subject_user_ids_gin
      ON ${schema}.spike_access_logs USING gin (subject_user_ids jsonb_path_ops)`);
    await admin.unsafe(`INSERT INTO ${schema}.spike_events
      (event_key, status, capacity, starts_at, ends_at)
      VALUES ('evt-cap1', 'published', 1, now(), now() + interval '1 hour')`);

    // (a) Establish holder first; a bounded SQL timeout proves actual contention.
    const a = open();
    const b = open();
    const ra = await a.reserve();
    try {
      const rb = await b.reserve();
      try {
        await ra`BEGIN`;
        const [event] = await ra.unsafe(`SELECT id FROM ${schema}.spike_events
          WHERE event_key = 'evt-cap1' FOR UPDATE`);
        if (!event) throw new Error("missing_event");
        await rb`BEGIN`;
        await rb`SET LOCAL lock_timeout = '250ms'`;
        let blocked = false;
        try {
          await rb.unsafe(`SELECT id FROM ${schema}.spike_events WHERE event_key = 'evt-cap1' FOR UPDATE`);
        } catch (err) {
          if ((err as { code?: string }).code !== "55P03") throw err;
          blocked = true;
        }
        await rb`ROLLBACK`;
        await ra.unsafe(`INSERT INTO ${schema}.spike_rsvps (event_id, user_id, status)
          VALUES ($1, 11, 'going')`, [event.id]);
        await ra`COMMIT`;
        // Retry under the same event lock and execute the capacity decision.
        await rb`BEGIN`;
        const [capacity] = await rb.unsafe(`SELECT capacity FROM ${schema}.spike_events
          WHERE id = $1 FOR UPDATE`, [event.id]);
        const [count] = await rb.unsafe(`SELECT count(*)::int AS n FROM ${schema}.spike_rsvps
          WHERE event_id = $1 AND status = 'going'`, [event.id]);
        if (!capacity || !count) throw new Error("missing_capacity_count");
        const refused = count.n >= capacity.capacity;
        if (!refused) await rb.unsafe(`INSERT INTO ${schema}.spike_rsvps (event_id, user_id, status)
          VALUES ($1, 22, 'going')`, [event.id]);
        await rb`COMMIT`;
        checks.push({ name: "(a) FOR UPDATE", pass: blocked && refused && count.n === 1,
          detail: `blocked_55P03=${blocked} second_seat_refused=${refused} going=${count.n}` });

        // (b) Transaction-scoped single-flight. No session-lock pooler claim.
        await ra`BEGIN`;
        const [key] = await ra`SELECT pg_backend_pid() AS id`;
        if (!key) throw new Error("missing_lock_key");
        await ra`SELECT pg_advisory_xact_lock(${key.id})`;
        await rb`BEGIN`;
        const [held] = await rb`SELECT pg_try_advisory_xact_lock(${key.id}) AS ok`;
        await ra`COMMIT`;
        const [free] = await rb`SELECT pg_try_advisory_xact_lock(${key.id}) AS ok`;
        await rb`COMMIT`;
        if (!held || !free) throw new Error("missing_advisory_result");
        checks.push({ name: "(b) advisory xact lock", pass: held.ok === false && free.ok === true,
          detail: `concurrent_refused=${held.ok === false} reacquired=${free.ok === true}` });
      } finally {
        try { await rb`ROLLBACK`; } finally { rb.release(); }
      }
    } finally {
      try { await ra`ROLLBACK`; } finally { ra.release(); }
    }

    // (c) Native containment and planner index use, not a forced index plan.
    await admin.unsafe(`INSERT INTO ${schema}.spike_access_logs
      (viewer_discord_id, resource, action, subject_user_ids, subject_count, route, occurred_at)
      SELECT 'snowflake-' || (g % 50), 'member', 'view',
        jsonb_build_array(1000 + g, 2000 + (g % 97)), 2, 'members.index', now()
      FROM generate_series(0, 1999) g`);
    await admin.unsafe(`INSERT INTO ${schema}.spike_access_logs
      (viewer_discord_id, resource, action, subject_user_ids, subject_count, route, occurred_at)
      VALUES ('snowflake-7', 'member', 'list', '[424242, 1001]', 2, 'members.index', now())`);
    await admin.unsafe(`ANALYZE ${schema}.spike_access_logs`);
    const plan = await admin.unsafe(`EXPLAIN (COSTS OFF) SELECT id FROM ${schema}.spike_access_logs
      WHERE subject_user_ids @> '[424242]'::jsonb`);
    const [count] = await admin.unsafe(`SELECT count(*)::int AS n FROM ${schema}.spike_access_logs
      WHERE subject_user_ids @> '[424242]'::jsonb`);
    if (!count) throw new Error("missing_containment_count");
    const usesGin = plan.some((row) => String(row["QUERY PLAN"]).includes("spike_access_logs_subject_user_ids_gin"));
    checks.push({ name: "(c) jsonb+GIN", pass: usesGin && count.n === 1,
      detail: `uses_gin=${usesGin} rows=2001 hits=${count.n}` });
    const passed = checks.filter((check) => check.pass).length;
    return c.json({ ok: passed === 3, path: "local-worker-direct-agent-testdb", version: server.version,
      passed, total: 3, checks }, passed === 3 ? 200 : 500);
  } finally {
    try {
      if (created) await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await Promise.all(clients.map((client) => client.end({ timeout: 2 })));
    }
  }
});

app.onError((_err, c) => c.json({ ok: false, error: "probe_error" }, 500));
export default app;
