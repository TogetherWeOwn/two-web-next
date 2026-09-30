#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import postgres from "postgres";

const eventColumns = [
  "event_key", "title", "game", "description", "starts_at", "ends_at", "timezone",
  "location", "capacity", "status", "rsvp_open", "discord_event_id",
  "discord_sync_failed_at", "discord_sync_failure_code", "created_by",
  "recurrence_frequency", "recurrence_count", "recurrence_ends_on",
  "parent_event_id", "recurrence_index", "created_at", "updated_at",
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

const counts = () => ({ read: 0, inserted: 0, updated: 0, unchanged: 0, orphaned: 0 });

export async function importEventsRsvps(legacy, target, { dryRun = true } = {}) {
  // Laravel bookkeeping timestamps have no zone; their documented meaning is UTC.
  return legacy.begin("isolation level repeatable read read only", async (source) => {
    await source`set local timezone = 'UTC'`;
    const events = await source`
      select id::text, event_key, title, game, description,
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
    return target.begin(`isolation level repeatable read ${dryRun ? "read only" : "read write"}`, async (sql) => {
      await sql`set local timezone = 'UTC'`;
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
        const operation = !existing ? "inserted" : equalRows(existing, row, eventColumns) ? "unchanged" : "updated";
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
    // Never fall back to inherited PGUSER/PGPASSWORD/PGDATABASE/PGPORT settings.
    username: decodeURIComponent(url.username), database: decodeURIComponent(url.pathname.slice(1)),
    password: () => decodeURIComponent(url.password), port,
  });
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let legacy, target;
  try {
    const options = parseArgs(args);
    if (!env.LEGACY_DATABASE_URL || !env.DATABASE_URL) throw new Error("Import URLs are unset.");
    legacy = connectDatabase(env.LEGACY_DATABASE_URL);
    target = connectDatabase(env.DATABASE_URL);
    const report = await importEventsRsvps(legacy, target, options);
    console.log(JSON.stringify(report));
    return reportExitCode(report);
  } catch (error) {
    // Driver errors can carry URLs, SQL parameters, or member data. Never echo them.
    if (error instanceof UnsupportedOwnershipError) {
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
