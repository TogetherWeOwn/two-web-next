#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import postgres from "postgres";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const BATCH_SIZE = 500;
const tables = [
  {
    name: "featured_contents",
    columns: ["legacy_id", "title", "body", "url", "image_url", "image_alt", "is_published", "position", "starts_at", "ends_at", "created_by", "created_at", "updated_at"],
    timestamps: ["starts_at", "ends_at", "created_at", "updated_at"],
    clock: "created_at",
    prune: false,
  },
  {
    name: "join_attempts",
    columns: ["legacy_id", "outcome", "source", "request_id", "discord_id", "created_at"],
    timestamps: ["created_at"],
    clock: "created_at",
    prune: true,
  },
  {
    name: "event_search_logs",
    columns: ["legacy_id", "normalized_query", "result_count", "occurred_at"],
    timestamps: ["occurred_at"],
    clock: "occurred_at",
    prune: true,
  },
];

function schemaName(value) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("Invalid import schema name");
  return value;
}

function qualified(sql, schema, table) {
  return sql`${sql(schema)}.${sql(table)}`;
}

function sourceColumns(sql, table) {
  return table.columns.map((column) => {
    if (column === "legacy_id") return sql`l.id::text as legacy_id`;
    if (column === "created_by") return sql`u.discord_id as created_by`;
    const value = column === "updated_at"
      ? sql`coalesce(l.updated_at, l.created_at)`
      : sql`l.${sql(column)}`;
    // Laravel timestamps have no zone and are UTC. Text preserves microseconds.
    // Both sessions pin ISO, YMD DateStyle below, so the text round-trip is
    // independent of server or role DateStyle defaults.
    return table.timestamps.includes(column)
      ? sql`(${value} at time zone 'UTC')::text as ${sql(column)}`
      : sql`${value} as ${sql(column)}`;
  }).reduce((a, b) => sql`${a}, ${b}`);
}

function targetColumns(sql, table) {
  return table.columns.map((column) => table.timestamps.includes(column)
    ? sql`${sql(column)}::text as ${sql(column)}`
    : sql`${sql(column)}`,
  ).reduce((a, b) => sql`${a}, ${b}`);
}

/** Pin UTC and a deterministic DateStyle inside each transaction. Dry-run performs no DML or sequence writes. */
export async function importContentFunnel({ legacy, target, legacySchema = "public", targetSchema = "public", dryRun = true, now = new Date() }) {
  schemaName(legacySchema);
  schemaName(targetSchema);
  const cutoff = new Date(now.getTime() - RETENTION_MS).toISOString();
  // Static URL guards cannot see DNS aliases or PgBouncer routing, so confirm
  // the effective database identities on the live sessions before touching data.
  const [sourceIdentity] = await legacy`select current_database() as database`;
  const [targetIdentity] = await target`select current_database() as database`;
  if (sourceIdentity?.database === targetIdentity?.database && legacySchema === targetSchema) {
    throw new Error("Source and target resolve to the same database and schema");
  }
  // Postgres.js transaction/cursor APIs: https://github.com/porsager/postgres#transactions
  // READ ONLY is enforced by Postgres, not just by a branch in the importer.
  return legacy.begin("isolation level repeatable read read only", async (source) =>
    target.begin(dryRun ? "isolation level repeatable read read only" : "", async (destination) => {
      await source`set local time zone 'UTC'`;
      // Timestamps cross the wire as text. Without a pinned style a DMY/SQL
      // source silently corrupts ambiguous dates on an MDY destination (July 9
      // imports as September 7) and aborts day>12 rows with 22008, while
      // formatting drift marks every unchanged row for update on replay.
      await source`set local datestyle to 'ISO, YMD'`;
      await destination`set local time zone 'UTC'`;
      await destination`set local datestyle to 'ISO, YMD'`;
      if (!dryRun) {
        // Serialize importers AND native writes while counts/upserts are computed.
        // All three tables commit or roll back together; only the target is locked.
        const names = tables.map((t) => qualified(destination, targetSchema, t.name))
          .reduce((a, b) => destination`${a}, ${b}`);
        await destination`lock table ${names} in share row exclusive mode`;
      }
      const report = [];
      for (const table of tables) {
        const sourceTable = qualified(source, legacySchema, table.name);
        const targetTable = qualified(destination, targetSchema, table.name);
        const clock = source`l.${source(table.clock)}`;
        const cutoffUtc = source`(${cutoff}::timestamptz at time zone 'UTC')`;
        const window = table.prune ? source`${clock} >= ${cutoffUtc}` : source`true`;
        const [counts] = await source`
          select count(*)::int as total,
            count(*) filter (where ${clock} is null)::int as skipped_missing_timestamp,
            count(*) filter (where ${table.prune ? source`${clock} < ${cutoffUtc}` : source`false`})::int as skipped_old
          from ${sourceTable} l`;
        const summary = {
          table: table.name, dry_run: dryRun, cutoff,
          ...counts, eligible: counts.total - counts.skipped_missing_timestamp - counts.skipped_old,
          would_insert: 0, would_update: 0, unchanged: 0, inserted: 0, updated: 0,
        };
        const creator = table.name === "featured_contents"
          ? source`left join ${qualified(source, legacySchema, "users")} u on u.id = l.created_by`
          : source``;
        const cursor = source`
          select ${sourceColumns(source, table)} from ${sourceTable} l ${creator}
          where ${clock} is not null and ${window} order by l.id
        `.cursor(BATCH_SIZE);
        // The async iterator awaits work on the final partial batch too.
        for await (const rows of cursor) {
          const existing = await destination`
            select ${targetColumns(destination, table)} from ${targetTable}
            where legacy_id in ${destination(rows.map((row) => row.legacy_id))}`;
          const byId = new Map(existing.map((row) => [row.legacy_id, row]));
          const changed = [];
          for (const row of rows) {
            const previous = byId.get(row.legacy_id);
            if (!previous) summary.would_insert++;
            else if (table.columns.every((column) => row[column] === previous[column])) {
              summary.unchanged++;
              continue;
            } else summary.would_update++;
            changed.push(row);
          }
          if (dryRun || changed.length === 0) continue;
          const updates = table.columns.filter((column) => column !== "legacy_id")
            .map((column) => destination`${destination(column)} = excluded.${destination(column)}`)
            .reduce((a, b) => destination`${a}, ${b}`);
          // Native IDs/sequences are never copied or reset. Multiple NULL keys
          // remain valid for native rows. https://www.postgresql.org/docs/17/sql-insert.html#SQL-ON-CONFLICT
          const columns = table.columns.map((column) => destination`${destination(column)}`)
            .reduce((a, b) => destination`${a}, ${b}`);
          const values = changed.map((row) => {
            const fields = table.columns.map((column) => table.timestamps.includes(column)
              // Explicit text -> timestamp cast avoids the driver's Date serializer,
              // which would silently truncate historical microseconds to milliseconds.
              ? destination`${destination.typed(row[column], 25)}::timestamptz`
              : destination`${row[column]}`,
            ).reduce((a, b) => destination`${a}, ${b}`);
            return destination`(${fields})`;
          }).reduce((a, b) => destination`${a}, ${b}`);
          await destination`
            insert into ${targetTable} (${columns}) values ${values}
            on conflict (legacy_id) do update set ${updates}`;
        }
        if (!dryRun) {
          summary.inserted = summary.would_insert;
          summary.updated = summary.would_update;
        }
        report.push(summary);
      }
      return report;
    }),
  );
}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true, dryRun: true };
  if (args.length > 1 || (args.length && !["--dry-run", "--apply"].includes(args[0]))) {
    throw new Error("Use no arguments, --dry-run, --apply or --help; URLs are env-only");
  }
  return { help: false, dryRun: args[0] !== "--apply" };
}

export function connectionSettings(env, dryRun) {
  const parse = (key) => {
    let url;
    try { url = new URL(env[key]); } catch { throw new Error(`${key} must be a Postgres URL`); }
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2) {
      throw new Error(`${key} must specify a Postgres host, user and database`);
    }
    // postgres.js forwards unknown query parameters as session startup
    // parameters, so ?database= / ?user= / ?search_path= silently override the
    // endpoint this guard compares, ?options= smuggles arbitrary -c settings,
    // ?role= can switch the session role, and ?default_transaction_read_only=off
    // would lift the read-only source guarantee (?datestyle= is neutralized
    // in-txn but refused for determinism). Refuse them statically; the
    // live current_database() check in importContentFunnel catches DNS aliases
    // and routing the static comparison cannot see.
    for (const param of ["database", "db", "user", "search_path", "options", "role", "session_authorization", "datestyle", "default_transaction_read_only", "timezone"]) {
      if (url.searchParams.has(param)) throw new Error(`${key} must not set ?${param}=; use the URL endpoint and schema env`);
    }
    return url;
  };
  const legacyUrl = parse("LEGACY_DATABASE_URL");
  const targetUrl = parse("DATABASE_URL");
  const legacySchema = schemaName(env.LEGACY_DATABASE_SCHEMA ?? "public");
  const targetSchema = schemaName(env.DATABASE_SCHEMA ?? "public");
  if (legacyUrl.hostname === targetUrl.hostname && (legacyUrl.port || "5432") === (targetUrl.port || "5432")
    && legacyUrl.pathname === targetUrl.pathname && legacySchema === targetSchema) {
    throw new Error("Source and target must be different databases or schemas");
  }
  const options = (url, readOnly) => ({
    max: 1, port: Number(url.port || 5432), connect_timeout: 10,
    // Pin even an empty password; never inherit PGPASSWORD as a substitute.
    password: () => decodeURIComponent(url.password),
    connection: { timezone: "UTC", default_transaction_read_only: readOnly ? "on" : "off" },
    onnotice: () => {},
  });
  return {
    legacyUrl: legacyUrl.href, targetUrl: targetUrl.href, legacySchema, targetSchema,
    legacyOptions: options(legacyUrl, true), targetOptions: options(targetUrl, dryRun),
  };
}

async function main() {
  let legacy;
  let target;
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log("content-funnel: [--dry-run (default) | --apply]; LEGACY_DATABASE_URL + DATABASE_URL env-only");
      return;
    }
    const settings = connectionSettings(process.env, args.dryRun);
    legacy = postgres(settings.legacyUrl, settings.legacyOptions);
    target = postgres(settings.targetUrl, settings.targetOptions);
    const report = await importContentFunnel({ legacy, target, ...settings, dryRun: args.dryRun });
    for (const row of report) console.log(JSON.stringify(row));
  } catch (error) {
    // Driver errors can contain URLs, query parameters and row data. Print none.
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : "REFUSED";
    console.error(`content-funnel: failed (${code}); completion not confirmed. Check env, migrations and source schema; no URLs or row data logged.`);
    process.exitCode = 1;
  } finally {
    await Promise.all([legacy, target].filter(Boolean).map((sql) => sql.end({ timeout: 2 }).catch(() => {})));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
