#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

export function parseOptions(args) {
  const allowed = new Set(["--dry-run", "--apply", "--enable-grants", "--help"]);
  if (
    args.some((arg) => !allowed.has(arg)) ||
    (args.includes("--apply") && args.includes("--dry-run"))
  ) {
    throw new Error("invalid_options");
  }
  return {
    dryRun: !args.includes("--apply"),
    enableGrants: args.includes("--enable-grants"),
    help: args.includes("--help"),
  };
}

function validIdentifier(value) {
  // trim also rejects a final newline, which JavaScript's $ anchor permits.
  return (
    typeof value === "string" && value === value.trim() && /^[a-z_][a-z0-9_]{0,62}$/.test(value)
  );
}

export function databaseConfig(env) {
  for (const name of ["LEGACY_DATABASE_URL", "DATABASE_URL"]) {
    if (!env[name]) throw new Error("missing_database_configuration");
    try {
      const url = new URL(env[name]);
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        !url.hostname ||
        !url.username ||
        url.pathname.length < 2
      )
        throw new Error();
    } catch {
      throw new Error("invalid_database_configuration");
    }
  }
  const legacySchema = env.LEGACY_DATABASE_SCHEMA || "public";
  const targetSchema = env.DATABASE_SCHEMA || "public";
  for (const schema of [legacySchema, targetSchema]) {
    if (!validIdentifier(schema)) throw new Error("invalid_schema");
  }
  if (env.LEGACY_DATABASE_URL === env.DATABASE_URL && legacySchema === targetSchema) {
    throw new Error("source_equals_target");
  }
  return { legacySchema, targetSchema };
}

// The database driver can include SQL values, URLs and server details in errors.
// Only a static message and an allowlisted SQLSTATE may leave this CLI.
export function safeFailure(error) {
  const code =
    typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
      ? ` (SQLSTATE ${error.code})`
      : "";
  return `Audit import failed${code}; no row data or connection details logged.`;
}

export function validateGrant(row) {
  if (!/^[a-f0-9]{64}$/.test(row.verifier_hash)) throw new Error("invalid_grant_digest");
}

// Pinned to src/jobs/constants.ts by a test: this tool does not change retention.
export const IDEMPOTENCY_RETENTION_DAYS = 90;
const PAGE_SIZE = 500;
const TABLES = [
  {
    name: "member_data_access_logs",
    columns: [
      "id",
      "viewer_discord_id",
      "viewer_user_id",
      "resource",
      "action",
      "subject_user_ids",
      "subject_count",
      "route",
      "occurred_at",
    ],
    timestamps: ["occurred_at"],
    json: ["subject_user_ids"],
    text: ["viewer_user_id"],
  },
  {
    name: "activity_log",
    columns: [
      "id",
      "log_name",
      "description",
      "subject_type",
      "subject_id",
      "causer_type",
      "causer_id",
      "properties",
      "created_at",
      "updated_at",
      "event",
      "batch_uuid",
    ],
    timestamps: ["created_at", "updated_at"],
    json: ["properties"],
    text: ["subject_id", "causer_id"],
  },
  {
    name: "agent_event_grants",
    columns: [
      "id",
      "agent_id",
      "company_id",
      "guild_id",
      "verifier_hash",
      "expires_at",
      "disabled_at",
      "max_events",
      "created_at",
      "updated_at",
    ],
    timestamps: ["expires_at", "disabled_at", "created_at", "updated_at"],
    json: [],
    text: [],
  },
  {
    name: "agent_event_audits",
    columns: [
      "id",
      "grant_id",
      "operation",
      "event_key",
      "idempotency_key",
      "payload_digest",
      "request_id",
      "result",
      "reason_code",
      "discord_event_id",
      "created_at",
      "updated_at",
    ],
    timestamps: ["created_at", "updated_at"],
    json: [],
    text: [],
  },
  {
    name: "agent_event_idempotency_keys",
    columns: [
      "id",
      "grant_id",
      "key",
      "payload_digest",
      "status",
      "body",
      "event_key",
      "created_at",
      "updated_at",
    ],
    timestamps: ["created_at", "updated_at"],
    json: ["body"],
    text: [],
  },
];

function identifier(value) {
  // ASCII names fit PostgreSQL's 63-byte limit: unequal schemas cannot alias
  // through identifier truncation and bypass the same-schema identity probe.
  if (!validIdentifier(value)) throw new Error("invalid_identifier");
  return `"${value}"`;
}

function tableName(schema, name) {
  return `${identifier(schema)}.${identifier(name)}`;
}

async function assertSeparateDatabase(source, destination) {
  // Advisory locks identify the effective database-local lock domain without
  // privileged server metadata or trusting URL/database-name equality. Probe
  // these exact transactions so transaction-pooling proxies cannot switch the
  // sessions between the check and import. Locks release on transaction exit.
  const key = randomBytes(8).readBigInt64BE().toString();
  const [held] = await source`SELECT pg_try_advisory_xact_lock(${key}::bigint) AS acquired`;
  if (held?.acquired !== true) throw new Error("source_identity_unavailable");
  const [probe] = await destination`SELECT pg_try_advisory_xact_lock(${key}::bigint) AS acquired`;
  // An alias, collision, denied probe or incomplete result must fail closed.
  if (probe?.acquired !== true) throw new Error("destination_identity_unavailable");
}

export async function importAudit({
  legacy,
  target,
  legacySchema = "public",
  targetSchema = "public",
  dryRun = true,
  enableGrants = false,
  now = new Date(),
}) {
  identifier(legacySchema);
  identifier(targetSchema);
  const at = now.toISOString();
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_RETENTION_DAYS * 86400000).toISOString();
  const counts = {};
  // One frozen source snapshot and one atomic destination transaction. A dry run
  // is genuinely read-only, not an INSERT followed by a rollback (which can
  // still advance sequences or invoke triggers).
  await legacy.begin("isolation level repeatable read read only", async (source) => {
    await source`SET LOCAL TIME ZONE 'UTC'`;
    // Timestamp text must use the same unambiguous format at both boundaries,
    // including when callers supply clients with hostile session defaults.
    await source`SET LOCAL DateStyle TO 'ISO, YMD'`;
    await target.begin(dryRun ? "isolation level repeatable read read only" : "", async (dest) => {
      await dest`SET LOCAL TIME ZONE 'UTC'`;
      await dest`SET LOCAL DateStyle TO 'ISO, YMD'`;
      if (legacySchema === targetSchema) await assertSeparateDatabase(source, dest);
      const ownershipTable = tableName(legacySchema, "events");
      const [ownership] = enableGrants
        ? await source`
        SELECT EXISTS (SELECT 1 FROM pg_attribute
          WHERE attrelid = to_regclass(${ownershipTable}) AND attname = 'agent_grant_id'
            AND atttypid = 'uuid'::regtype AND NOT attisdropped) AS available
      `
        : [{ available: false }];
      if (!dryRun) {
        // Also protects sequence alignment against concurrent default-id INSERTs.
        const names = TABLES.map((t) => tableName(targetSchema, t.name)).join(", ");
        await dest.unsafe(`LOCK TABLE ${names} IN SHARE ROW EXCLUSIVE MODE`);
      }
      for (const table of TABLES) {
        const from = tableName(legacySchema, table.name);
        const to = tableName(targetSchema, table.name);
        const count = {
          read: 0,
          inserted: 0,
          would_insert: 0,
          existing: 0,
          expired: 0,
          updated: 0,
        };
        counts[table.name] = count;
        // text casts avoid JS integer rounding and millisecond Date truncation.
        const select = table.columns
          .map((col) => {
            const id = identifier(col);
            if (table.timestamps.includes(col)) return `(${id} AT TIME ZONE 'UTC')::text AS ${id}`;
            if (col === "id" || table.json.includes(col) || table.text.includes(col))
              return `${id}::text AS ${id}`;
            return id;
          })
          .join(", ");
        const isReplay = table.name === "agent_event_idempotency_keys";
        // Let Postgres compare the UTC timestamps at full precision. Non-finite
        // timestamps cannot establish membership in a bounded retention window.
        const expiry = isReplay
          ? ", (created_at IS NULL OR NOT isfinite(created_at) OR created_at < $1::timestamp) AS import_expired"
          : "";
        // Ownership is not copied into Next agent_events by this importer.
        // Admit only demonstrably untouched grants; any history (including
        // expired replay keys) is conservatively spent/unknown, not new quota.
        const admission =
          table.name === "agent_event_grants"
            ? `, (${
                enableGrants && ownership.available
                  ? `max_events > 0
              AND NOT EXISTS (SELECT 1 FROM ${ownershipTable} WHERE agent_grant_id = source.id)
              AND NOT EXISTS (SELECT 1 FROM ${tableName(legacySchema, "agent_event_audits")} WHERE grant_id = source.id)
              AND NOT EXISTS (SELECT 1 FROM ${tableName(legacySchema, "agent_event_idempotency_keys")} WHERE grant_id = source.id)`
                  : "false"
              }) AS import_unused`
            : "";
        let cursor = null;
        while (true) {
          const params = isReplay ? [cutoff] : [];
          if (cursor !== null) params.push(cursor);
          const rows = await source.unsafe(
            `SELECT ${select}${expiry}${admission} FROM ${from} AS source
             ${cursor === null ? "" : `WHERE source.id > $${params.length}`}
             ORDER BY source.id LIMIT ${PAGE_SIZE}`,
            params,
          );
          if (!rows.length) break;
          for (const row of rows) {
            count.read++;
            if (isReplay && row.import_expired) {
              count.expired++;
              continue;
            }
            if (table.name === "agent_event_grants") {
              validateGrant(row);
              if (!row.import_unused && row.disabled_at === null) row.disabled_at = at;
            }
            const existing = await dest.unsafe(
              `SELECT id::text FROM ${to} WHERE id = $1${isReplay ? " OR (grant_id = $2 AND key = $3)" : ""}`,
              isReplay ? [row.id, row.grant_id, row.key] : [row.id],
            );
            if (existing.length) {
              count.existing++;
              continue;
            }
            if (dryRun) {
              count.would_insert++;
              continue;
            }
            const columns = table.columns.map(identifier).join(", ");
            // Bind projected evidence as text before server-side conversion:
            // raw postgres.js JSON/Date serializers otherwise re-encode JSON
            // strings and truncate timestamp microseconds at the write boundary.
            const values = table.columns
              .map((col, i) => {
                const param = `$${i + 1}`;
                if (table.json.includes(col)) return `${param}::text::jsonb`;
                if (table.timestamps.includes(col)) return `${param}::text::timestamptz`;
                return param;
              })
              .join(", ");
            // Only known identifiers enter SQL text; all row values are parameters.
            const inserted = await dest.unsafe(
              `INSERT INTO ${to} (${columns}) VALUES (${values}) ON CONFLICT (id) DO NOTHING RETURNING id`,
              table.columns.map((col) => row[col]),
            );
            count.inserted += inserted.length;
            count.existing += inserted.length ? 0 : 1;
          }
          cursor = rows[rows.length - 1].id;
        }
      }
      if (!dryRun) {
        for (const table of TABLES.filter((t) => t.name !== "agent_event_grants")) {
          const name = tableName(targetSchema, table.name);
          const [sequence] = await dest`SELECT pg_get_serial_sequence(${name}, 'id') AS name`;
          if (!sequence.name) throw new Error("missing_import_sequence");
          // setval is the sole non-row write. Never lower an already-used sequence;
          // no audit UPDATE/DELETE or trigger bypass is needed for explicit IDs.
          await dest.unsafe(
            `SELECT setval($1::regclass,
            GREATEST((SELECT COALESCE(MAX(id), 1) FROM ${name}),
              (SELECT last_value FROM ${sequence.name})), true)`,
            [sequence.name],
          );
        }
      }
    });
  });
  return { mode: dryRun ? "dry-run" : "apply", grants_enabled: enableGrants, tables: counts };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let legacy;
  let target;
  try {
    const options = parseOptions(args);
    if (options.help) {
      console.log("Usage: node bin/import/audit.mjs [--dry-run | --apply] [--enable-grants]");
      console.log("Connection URLs come only from LEGACY_DATABASE_URL and DATABASE_URL.");
      return 0;
    }
    const schemas = databaseConfig(env);
    const connectionOptions = (url) => ({
      max: 1,
      connect_timeout: 10,
      onnotice: () => {},
      // Pin even an empty URL password: postgres.js otherwise falls back to
      // inherited PGPASSWORD. No alternative credential may be substituted.
      password: () => decodeURIComponent(new URL(url).password),
    });
    legacy = postgres(env.LEGACY_DATABASE_URL, connectionOptions(env.LEGACY_DATABASE_URL));
    target = postgres(env.DATABASE_URL, connectionOptions(env.DATABASE_URL));
    const result = await importAudit({ legacy, target, ...schemas, ...options });
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error(safeFailure(error));
    return 1;
  } finally {
    await Promise.allSettled([legacy?.end({ timeout: 5 }), target?.end({ timeout: 5 })]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
