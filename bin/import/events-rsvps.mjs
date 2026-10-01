#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import postgres from "postgres";

const eventColumns = [
  "event_key", "title", "game", "description", "starts_at", "ends_at", "timezone",
  "location", "capacity", "status", "rsvp_open", "discord_event_id",
  "discord_sync_failed_at", "discord_sync_failure_code", "created_by",
  "recurrence_frequency", "recurrence_count", "recurrence_ends_on",
  "parent_event_id", "recurrence_index", "created_at", "updated_at", "ics_sequence",
];
const rsvpColumns = ["event_id", "user_id", "legacy_id", "status", "synced_to_discord_at", "created_at", "updated_at"];
const timestampColumns = new Set([
  "starts_at", "ends_at", "discord_sync_failed_at", "synced_to_discord_at", "created_at", "updated_at",
]);

export function parseArgs(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--dry-run")) return { dryRun: true };
  if (args.length === 1 && args[0] === "--apply") return { dryRun: false };
  throw new Error("Expected no arguments, --dry-run, or --apply; URLs must come from env.");
}

// A numeric sort is not enough: legacy parents can have higher IDs than children.
export function parentFirst(events) {
  const byId = new Map(events.map((event) => [String(event.id), event]));
  if (byId.size !== events.length || new Set(events.map((event) => event.event_key)).size !== events.length) {
    throw new Error("Duplicate legacy event identity.");
  }
  const result = [];
  const visited = new Set();
  for (const event of events) {
    const chain = [];
    const visiting = new Set();
    let current = event;
    while (current && !visited.has(String(current.id))) {
      const id = String(current.id);
      if (visiting.has(id)) throw new Error("Legacy event parent cycle.");
      visiting.add(id);
      chain.push(current);
      if (current.parent_event_id === null) break;
      current = byId.get(String(current.parent_event_id));
      if (!current) throw new Error("Legacy event parent is missing.");
    }
    for (const ancestor of chain.reverse()) {
      visited.add(String(ancestor.id));
      result.push(ancestor);
    }
  }
  return result;
}

function validateEvent(event) {
  if (!event.event_key || !event.title || !["draft", "published", "cancelled", "past"].includes(event.status)) {
    throw new Error("Invalid legacy event content or status.");
  }
  if (typeof event.rsvp_open !== "boolean") throw new Error("Invalid legacy RSVP-open flag.");
  for (const column of ["starts_at", "ends_at", "created_at", "updated_at"]) {
    if (!event[column] || !Number.isFinite(Date.parse(event[column]))) throw new Error("Missing/invalid legacy event timestamp.");
  }
  if (event.ends_at <= event.starts_at) throw new Error("Invalid legacy event time range.");
  try { new Intl.DateTimeFormat("en", { timeZone: event.timezone }); }
  catch { throw new Error("Invalid legacy event timezone."); }
  if (event.recurrence_frequency !== null && event.recurrence_frequency !== "weekly") {
    throw new Error("Invalid legacy recurrence frequency.");
  }
}

function equalRows(existing, incoming, columns) {
  return columns.every((column) => {
    const a = existing[column], b = incoming[column];
    if (a === null || b === null) return a === b;
    // Timestamp projections are UTC text with all six PostgreSQL fractional digits.
    if (timestampColumns.has(column) || column === "recurrence_ends_on") return a === b;
    return String(a) === String(b);
  });
}

async function upsert(sql, table, columns, keys, row) {
  const assignments = columns.filter((column) => !keys.includes(column))
    .map((column) => sql`${sql(column)} = excluded.${sql(column)}`);
  const sets = assignments.reduce((a, b) => sql`${a}, ${b}`);
  const conflict = keys.map((key) => sql(key)).reduce((a, b) => sql`${a}, ${b}`);
  // Force text parameters: the driver's timestamp serializer also truncates string inputs via Date.
  const values = { ...row };
  for (const column of columns) {
    if (timestampColumns.has(column)) values[column] = sql`${row[column]}::text::timestamptz`;
    if (column === "recurrence_ends_on") values[column] = sql`${row[column]}::text::date::timestamp`;
  }
  const [saved] = await sql`
    insert into ${sql(table)} ${sql(values, columns)}
    on conflict (${conflict}) do update set ${sets}
    returning id
  `;
  return String(saved.id);
}

// postgres.js returns timestamp Dates at millisecond precision; project text instead.
// https://www.postgresql.org/docs/17/functions-formatting.html (US = six digits)
function comparableColumns(sql, columns) {
  return columns.map((column) => timestampColumns.has(column)
    ? sql`to_char(${sql(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${sql(column)}`
    : column === "recurrence_ends_on"
      ? sql`to_char(${sql(column)}, 'YYYY-MM-DD') as ${sql(column)}`
      : sql(column)).reduce((a, b) => sql`${a}, ${b}`);
}

class UnsupportedOwnershipError extends Error {
  constructor(count) {
    super("Unsupported legacy agent ownership; no destination writes.");
    this.count = count;
  }
}

class TargetSeparationError extends Error {
  constructor() {
    super("Could not establish isolated import tables; no destination writes.");
  }
}

// This is only an early refusal. DNS/proxy aliases and role/search_path defaults
// are checked on the live transactions below, not inferred from hostnames.
export function assertSeparateUrls(legacyUrl, targetUrl) {
  const endpoint = (raw) => {
    const url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new TargetSeparationError();
    return JSON.stringify([
      url.hostname.toLowerCase(), url.port || "5432", decodeURIComponent(url.pathname),
      decodeURIComponent(url.username), [...url.searchParams].sort(),
    ]);
  };
  try {
    if (endpoint(legacyUrl) === endpoint(targetUrl)) throw new TargetSeparationError();
  } catch { throw new TargetSeparationError(); }
}

async function resolvedTables(sql) {
  const rows = await sql`
    select names.name, c.oid::text as relation_id, c.relkind,
      exists (select 1 from pg_catalog.pg_inherits i
        where i.inhrelid = c.oid or i.inhparent = c.oid) as inherited
    from (values ('events'), ('rsvps'), ('users')) as names(name)
    left join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass(names.name)
  `;
  // Views, foreign tables and inheritance may route writes into another schema.
  // Only ordinary, non-inherited tables have the identity this importer proves.
  if (rows.length !== 3 || rows.some((row) => !["events", "rsvps", "users"].includes(row.name)
    || !/^[1-9][0-9]*$/.test(row.relation_id ?? "") || row.relkind !== "r" || row.inherited !== false)
    || new Set(rows.map((row) => row.name)).size !== 3) throw new TargetSeparationError();
  return rows;
}

async function resolvedAllocators(sql) {
  // JSON arrays remain decoded when the CLI client disables catalog type fetching.
  const rows = await sql`
    select names.name, a.attidentity as identity_kind,
      pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) as id_default,
      exists (select 1 from pg_catalog.pg_depend d
        where d.classid = 'pg_catalog.pg_attrdef'::regclass and d.objid = ad.oid
          and d.refclassid = 'pg_catalog.pg_proc'::regclass
          and d.refobjid <> 'pg_catalog.nextval(pg_catalog.regclass)'::regprocedure) as custom_id_function,
      pg_catalog.pg_get_serial_sequence(c.oid::regclass::text, 'id')::regclass::oid::text as owned_id_sequence,
      pg_catalog.array_to_json(array(select d.refobjid::text from pg_catalog.pg_depend d
        join pg_catalog.pg_class s on s.oid = d.refobjid and s.relkind = 'S'
        where d.classid = 'pg_catalog.pg_attrdef'::regclass and d.objid = ad.oid
          and d.refclassid = 'pg_catalog.pg_class'::regclass)) as id_sequence_ids,
      pg_catalog.array_to_json(array(select distinct s.oid::text from pg_catalog.pg_class s
        where s.relkind = 'S' and (
          exists (select 1 from pg_catalog.pg_depend d
            join pg_catalog.pg_attrdef defaults on defaults.oid = d.objid
            where d.classid = 'pg_catalog.pg_attrdef'::regclass
              and d.refclassid = 'pg_catalog.pg_class'::regclass
              and d.refobjid = s.oid and defaults.adrelid = c.oid)
          or exists (select 1 from pg_catalog.pg_depend d
            where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = s.oid
              and d.refclassid = 'pg_catalog.pg_class'::regclass
              and d.refobjid = c.oid and d.deptype in ('a', 'i'))
        ))) as sequence_ids,
      pg_catalog.array_to_json(array(select s.oid::text from pg_catalog.pg_class s
        where s.relkind = 'S' and s.relnamespace = c.relnamespace)) as schema_sequence_ids
    from (values ('events'), ('rsvps'), ('users')) as names(name)
    join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass(names.name)
    join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attname = 'id' and not a.attisdropped
    left join pg_catalog.pg_attrdef ad on ad.adrelid = c.oid and ad.adnum = a.attnum
  `;
  const oid = (value) => typeof value === "string" && /^[1-9][0-9]*$/.test(value);
  if (rows.length !== 3 || new Set(rows.map((row) => row.name)).size !== 3
    || rows.some((row) => !["events", "rsvps", "users"].includes(row.name)
      || !["", "a", "d"].includes(row.identity_kind)
      || (row.id_default !== null && typeof row.id_default !== "string")
      || typeof row.custom_id_function !== "boolean"
      || (row.owned_id_sequence !== null && !oid(row.owned_id_sequence))
      || [row.id_sequence_ids, row.sequence_ids, row.schema_sequence_ids]
        .some((ids) => !Array.isArray(ids) || ids.some((id) => !oid(id))))) throw new TargetSeparationError();
  return rows;
}

async function assertSeparateAllocators(source, destination) {
  const sourceAllocators = await resolvedAllocators(source);
  const targetAllocators = await resolvedAllocators(destination);
  // Protect writable source schemas and every source-owned/referenced allocator,
  // including users, but not unrelated sequences beside a shared users table.
  // Sequence writes survive transaction rollback.
  const sourceIds = new Set(sourceAllocators.flatMap((row) => [
    ...(row.name === "users" ? [] : row.schema_sequence_ids), ...row.sequence_ids,
    ...(row.owned_id_sequence === null ? [] : [row.owned_id_sequence]),
  ]));
  for (const row of targetAllocators.filter((row) => row.name !== "users")) {
    // Pinned builtins have no pg_depend entry; custom functions do, even when
    // pg_get_expr prints the same unqualified nextval text. Reject those identities.
    // Permit only a direct builtin regclass nextval or a catalog-owned identity.
    const direct = row.identity_kind === "" && row.custom_id_function === false && row.id_sequence_ids.length === 1
      && /^(?:pg_catalog\.)?nextval\('(?:[^']|'')+'::regclass\)$/.test(row.id_default ?? "");
    const identity = row.identity_kind !== "" && row.custom_id_function === false
      && row.id_default === null && row.owned_id_sequence !== null;
    if ((!direct && !identity) || [...row.sequence_ids, ...row.id_sequence_ids,
      ...(row.owned_id_sequence === null ? [] : [row.owned_id_sequence])].some((id) => sourceIds.has(id))) {
      throw new TargetSeparationError();
    }
  }
}

export async function assertSeparateTargets(source, destination) {
  try {
    if (source === destination) throw new TargetSeparationError();
    const sourceTables = await resolvedTables(source);
    const targetTables = await resolvedTables(destination);
    // Reuse content-funnel's database-local, transaction-scoped lock probe. It
    // works with read-only roles and transaction pools without privileged IDs.
    // OIDs alone are not identities across independent, same-named databases.
    const key = randomBytes(8).readBigInt64BE().toString();
    const [held] = await source`select pg_catalog.pg_try_advisory_xact_lock(${key}::bigint) as acquired`;
    if (held?.acquired !== true) throw new TargetSeparationError();
    const [probe] = await destination`select pg_catalog.pg_try_advisory_xact_lock(${key}::bigint) as acquired`;
    if (probe?.acquired === true) return;
    if (probe?.acquired !== false) throw new TargetSeparationError();
    // Compare resolved tables, not current_schema(): a different leading schema
    // can still fall back to the source. Shared read-only users are safe; neither
    // writable target table may overlap any source table in this lock domain.
    const sourceIds = new Set(sourceTables.map((row) => row.relation_id));
    if (targetTables.some((row) => row.name !== "users" && sourceIds.has(row.relation_id))) {
      throw new TargetSeparationError();
    }
    await assertSeparateAllocators(source, destination);
  } catch { throw new TargetSeparationError(); }
}

const counts = () => ({ read: 0, inserted: 0, updated: 0, unchanged: 0, orphaned: 0 });

export async function importEventsRsvps(legacy, target, { dryRun = true } = {}) {
  if (legacy === target) throw new TargetSeparationError();
  // Laravel bookkeeping timestamps have no zone; their documented meaning is UTC.
  return legacy.begin("isolation level repeatable read read only", async (source) => {
    return target.begin(`isolation level repeatable read ${dryRun ? "read only" : "read write"}`, async (sql) => {
      await source`set local timezone = 'UTC'`;
      await sql`set local timezone = 'UTC'`;
      await assertSeparateTargets(source, sql);
      const [revisionColumn] = await source`
        select exists (
          select 1 from pg_attribute
          where attrelid = 'events'::regclass and attname = 'ics_sequence' and not attisdropped
        ) as present
      `;
      const timestampSequence = source`GREATEST(0,
        FLOOR(EXTRACT(EPOCH FROM COALESCE(updated_at, created_at, TIMESTAMP '1970-01-01')))::bigint)`;
      const revision = revisionColumn.present
        ? source`GREATEST(ics_sequence, ${timestampSequence})::text`
        : source`${timestampSequence}::text`;
      const events = await source`
        select id::text, event_key, title, game, description, ${revision} as ics_sequence,
          to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as starts_at,
          to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ends_at,
          timezone, location, capacity, status, rsvp_open, discord_event_id,
          to_char(discord_sync_failed_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as discord_sync_failed_at,
          discord_sync_failure_code, created_by::text, recurrence_frequency,
          recurrence_count, to_char(recurrence_ends_on, 'YYYY-MM-DD') as recurrence_ends_on,
          parent_event_id::text, recurrence_index,
          to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
          to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
          agent_grant_id, proof_marker, agent_version
        from events order by id
      `;
      // Grants are deliberately not migrated. Even a deleted grant can leave proof/version attribution.
      const unsupported = events.filter((event) => event.agent_grant_id !== null
        || event.proof_marker !== null || event.agent_version !== 0);
      if (unsupported.length) throw new UnsupportedOwnershipError(unsupported.length);
      const rsvps = await source`
        select r.id::text, r.event_id::text, u.discord_id, r.status,
          to_char(r.synced_to_discord_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as synced_to_discord_at,
          to_char(r.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
          to_char(r.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
        from rsvps r left join users u on u.id = r.user_id order by r.id
      `;
      const creators = await source`select id::text, discord_id from users where id in (select created_by from events)`;
      const ordered = parentFirst(events);
      for (const event of ordered) validateEvent(event);
      // Only the table-owner cutover principal may restore legacy revisions.
      // The lock excludes other writers until COMMIT; DDL rolls back on failure.
      // Never disable constraints, audit triggers, or the session's replication role.
      let revisionTriggerMode;
      if (!dryRun) {
        await sql`lock table events in access exclusive mode`;
        const [trigger] = await sql`select tgenabled from pg_trigger
          where tgrelid = 'events'::regclass and tgname = 'events_ics_sequence' and not tgisinternal`;
        revisionTriggerMode = trigger?.tgenabled;
        if (revisionTriggerMode !== "O" && revisionTriggerMode !== "A") {
          throw new Error("Calendar revision trigger must be enabled for origin or always; no destination writes.");
        }
        await sql`alter table events disable trigger events_ics_sequence`;
      }
      const report = {
        dryRun, events: counts(), rsvps: counts(),
        unresolved: { creators: 0, rsvpEvents: 0, rsvpUsers: 0 },
      };
      const users = new Map((await sql`select id from users`).map((u) => [u.id, u.id]));
      const creatorDiscordIds = new Map(creators.map((u) => [u.id, u.discord_id]));
      const savedEvents = new Map();
      for (const event of ordered) {
        const creator = event.created_by === null ? null : users.get(creatorDiscordIds.get(event.created_by));
        if (event.created_by !== null && !creator) report.unresolved.creators++;
        const row = {
          ...event, created_by: creator ?? null,
          parent_event_id: event.parent_event_id === null ? null : savedEvents.get(event.parent_event_id),
        };
        const [existing] = await sql`select id, ${comparableColumns(sql, eventColumns)} from events where event_key = ${event.event_key}`;
        if (existing && BigInt(existing.ics_sequence) > BigInt(row.ics_sequence)) {
          row.ics_sequence = String(existing.ics_sequence);
        }
        const operation = !existing ? "inserted" : equalRows(existing, row, eventColumns) ? "unchanged" : "updated";
        // A changed imported row must also advance beyond the destination's revision.
        if (existing && operation === "updated" && BigInt(row.ics_sequence) <= BigInt(existing.ics_sequence)) {
          row.ics_sequence = String(BigInt(existing.ics_sequence) + 1n);
        }
        report.events.read++;
        report.events[operation]++;
        // Dry-run uses placeholders for new IDs without touching sequences.
        const id = !dryRun && operation !== "unchanged"
          ? await upsert(sql, "events", eventColumns, ["event_key"], row)
          : existing ? String(existing.id) : `new:${event.event_key}`;
        savedEvents.set(event.id, id);
      }
      for (const rsvp of rsvps) {
        report.rsvps.read++;
        if (!["going", "maybe", "not_going", "waitlisted"].includes(rsvp.status)) throw new Error("Invalid legacy RSVP status.");
        for (const column of ["created_at", "updated_at"]) {
          if (!rsvp[column] || !Number.isFinite(Date.parse(rsvp[column]))) throw new Error("Missing/invalid legacy RSVP timestamp.");
        }
        const eventId = savedEvents.get(rsvp.event_id), userId = users.get(rsvp.discord_id);
        if (!eventId) report.unresolved.rsvpEvents++;
        if (!userId) report.unresolved.rsvpUsers++;
        if (!eventId || !userId) { report.rsvps.orphaned++; continue; }
        const row = { ...rsvp, event_id: eventId, user_id: userId, legacy_id: rsvp.id };
        const [existing] = eventId.startsWith("new:") ? []
          : await sql`select id, ${comparableColumns(sql, rsvpColumns)} from rsvps where event_id = ${eventId} and user_id = ${userId}`;
        if (existing && existing.legacy_id !== null && String(existing.legacy_id) !== rsvp.id) {
          throw new Error("Conflicting legacy RSVP identity.");
        }
        const operation = !existing ? "inserted" : equalRows(existing, row, rsvpColumns) ? "unchanged" : "updated";
        report.rsvps[operation]++;
        if (!dryRun && operation !== "unchanged") await upsert(sql, "rsvps", rsvpColumns, ["event_id", "user_id"], row);
      }
      if (!dryRun) {
        if (revisionTriggerMode === "A") await sql`alter table events enable always trigger events_ics_sequence`;
        else await sql`alter table events enable trigger events_ics_sequence`;
      }
      return report;
    });
  });
}

export function reportExitCode(report) {
  return Object.values(report.unresolved).some((count) => count > 0) ? 2 : 0;
}

export function connectDatabase(raw) {
  const url = new URL(raw);
  const port = url.port ? Number(url.port) : 5432;
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username
    || url.pathname.length < 2 || port < 1) throw new Error("Expected a complete PostgreSQL URL from env.");
  return postgres(raw, {
    max: 1, prepare: false, fetch_types: false, connect_timeout: 10, onnotice: () => {},
    // Never fall back to inherited PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGPORT settings.
    // The driver's URL parser splits IPv6 on colons; an explicit array preserves it.
    host: [url.hostname.replace(/^\[|\]$/g, "")],
    username: decodeURIComponent(url.username), database: decodeURIComponent(url.pathname.slice(1)),
    password: () => decodeURIComponent(url.password), port: [port],
  });
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let legacy, target;
  try {
    const options = parseArgs(args);
    if (!env.LEGACY_DATABASE_URL || !env.DATABASE_URL) throw new Error("Import URLs are unset.");
    assertSeparateUrls(env.LEGACY_DATABASE_URL, env.DATABASE_URL);
    legacy = connectDatabase(env.LEGACY_DATABASE_URL);
    target = connectDatabase(env.DATABASE_URL);
    const report = await importEventsRsvps(legacy, target, options);
    console.log(JSON.stringify(report));
    return reportExitCode(report);
  } catch (error) {
    // Driver errors can carry URLs, SQL parameters, or member data. Never echo them.
    if (error instanceof TargetSeparationError) {
      console.error("events-rsvps: could not establish isolated import tables; no destination writes. Verify separate databases/schemas and identity-probe access.");
    } else if (error instanceof UnsupportedOwnershipError) {
      console.error(`events-rsvps: rejected ${error.count} agent-attributed events; grants/proofs are unsupported. No destination writes.`);
    } else {
      console.error("events-rsvps: import failed; verify flags, env URLs, schema, source validity and database access. Outcome unconfirmed; inspect destination before retry.");
    }
    return 1;
  } finally {
    await Promise.all([legacy, target].filter(Boolean).map((sql) => sql.end({ timeout: 2 }).catch(() => {})));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
