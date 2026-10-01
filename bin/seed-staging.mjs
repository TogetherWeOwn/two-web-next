#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export const SEED_OWNER = "seed-staging-calendar-v1";
// Keep the two snowflakes aligned with src/qa.ts; usernames are fixture-only.
export const SEED_USERS = [
  { id: "900000000000001396", username: "seed-qa-member" },
  { id: "900000000000001397", username: "seed-qa-moderator" },
  { id: "seed-qa-waitlisted", username: "seed-qa-waitlisted" },
];
const ZONES = ["UTC", "Europe/London", "America/New_York", "America/Los_Angeles", "Asia/Tokyo", "Australia/Sydney"];
const GAMES = ["Minecraft", "Valheim", "Deep Rock Galactic", "Stardew Valley", "Tabletop", "Community chat"];
const DAY = 86_400_000;
const hostname = (value) => value.toLowerCase().replace(/\.$/, "");
const list = (value = "") => value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

export function parseMode(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--dry-run")) return "dry-run";
  if (args.length === 1 && args[0] === "--apply") return "apply";
  throw new Error("Usage: node bin/seed-staging.mjs [--dry-run | --apply]. Connection settings come from env only.");
}

export function validateEnvironment(env) {
  if (env.SEED_CONFIRM !== "staging") throw new Error("Refusing seed: SEED_CONFIRM must be staging.");
  if (env.APP_ENV?.toLowerCase() === "production") throw new Error("Refusing seed: APP_ENV is production.");
  let app, db;
  try { app = new URL(env.APP_URL); } catch { throw new Error("Refusing seed: APP_URL must be an explicit staging or local URL."); }
  const appHost = hostname(app.hostname);
  if (["togetherweown.com", "www.togetherweown.com"].includes(appHost)) throw new Error("Refusing seed: production APP_URL.");
  const stagingApp = app.origin === "https://next.togetherweown.com" && app.pathname === "/" && !app.search && !app.hash && !app.username && !app.password;
  const localApp = ["localhost", "127.0.0.1", "[::1]"].includes(appHost) && ["http:", "https:"].includes(app.protocol) && !app.username && !app.password;
  if (!stagingApp && !localApp) throw new Error("Refusing seed: APP_URL is not the staging or local application.");
  try { db = new URL(env.DATABASE_URL); } catch { throw new Error("Refusing seed: DATABASE_URL is required and must be a PostgreSQL URL."); }
  if (!["postgres:", "postgresql:"].includes(db.protocol) || !/^[a-z0-9.-]+$/i.test(db.hostname) || !db.username || db.hash) throw new Error("Refusing seed: invalid PostgreSQL URL.");
  try { decodeURIComponent(db.password); decodeURIComponent(db.username); } catch { throw new Error("Refusing seed: invalid PostgreSQL credentials encoding."); }
  // A driver query parameter must not redirect a checked URL to another host/database.
  for (const [key, value] of db.searchParams) {
    if (key !== "sslmode" || !["require", "verify-full"].includes(value)) throw new Error("Refusing seed: unsupported DATABASE_URL query parameter.");
  }
  let name;
  try { name = decodeURIComponent(db.pathname.slice(1)); } catch { throw new Error("Refusing seed: invalid database name."); }
  if (!name || name.includes("/")) throw new Error("Refusing seed: invalid database name.");
  const host = hostname(db.hostname);
  const deniedHosts = list(env.SEED_PRODUCTION_DB_HOSTS).map(hostname);
  const deniedNames = ["prod", "production", ...list(env.SEED_PRODUCTION_DB_NAMES)];
  if (deniedHosts.includes(host) || /(^|[.-])(prod|production)([.-]|$)/.test(host)) throw new Error("Refusing seed: production database host.");
  if (deniedNames.includes(name.toLowerCase())) throw new Error("Refusing seed: production database name.");
  const testDb = host === "agent-testdb" && name === "two_web_next" && db.username === "agent_test" && !db.password && (!db.port || db.port === "5432");
  if (!testDb) {
    // No Neon endpoint is committed in this repo. Remote execution needs an
    // operator-verified staging allowlist AND the independently verified prod denylist.
    if (!stagingApp || !env.SEED_STAGING_DB_HOST || !env.SEED_STAGING_DB_NAME || deniedHosts.length === 0) throw new Error("Refusing seed: remote target requires a verified staging host/name and production host denylist.");
    if (host !== hostname(env.SEED_STAGING_DB_HOST) || name !== env.SEED_STAGING_DB_NAME || !host.endsWith(".neon.tech")) throw new Error("Refusing seed: database is not the allowlisted staging Neon endpoint.");
  }
  return { databaseUrl: env.DATABASE_URL, host, name };
}

export function buildSeed(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid seed date.");
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 18);
  const events = Array.from({ length: 50 }, (_, i) => {
    const n = i + 1;
    const past = n > 41;
    const status = n <= 30 || past ? "published" : n <= 36 ? "draft" : "cancelled";
    const series = n >= 5 && n <= 8;
    const offset = past ? -(n - 41) : series ? 4 + (n - 5) * 7 : n;
    const start = new Date(base + offset * DAY);
    return {
      event_key: `seed-calendar-${String(n).padStart(2, "0")}`,
      title: `Seed ${String(n).padStart(2, "0")}: ${series ? "Weekly community night" : GAMES[i % GAMES.length]}`,
      game: GAMES[i % GAMES.length],
      description: `${SEED_OWNER}: synthetic calendar fixture; no imported member data.`,
      starts_at: start,
      ends_at: new Date(start.getTime() + 2 * 3_600_000),
      timezone: ZONES[i % ZONES.length],
      location: "Seed staging lounge",
      capacity: n <= 4 ? 2 : 12,
      status,
      created_by: SEED_OWNER,
      rsvp_open: n !== 30 && status === "published" && !past,
      recurrence_frequency: n === 5 ? "weekly" : null,
      recurrence_count: n === 5 ? 4 : null,
      recurrence_index: series ? n - 4 : null,
      parent_key: n >= 6 && n <= 8 ? "seed-calendar-05" : null,
    };
  });
  const rsvps = events.slice(0, 4).flatMap((e) => SEED_USERS.map((u, i) => ({ event_key: e.event_key, user_id: u.id, status: i < 2 ? "going" : "waitlisted" })));
  const featured = events.slice(0, 3).map((e, i) => ({
    title: `seed-featured-${i + 1}`,
    body: `Synthetic staging calendar: ${e.title}`,
    url: `https://next.togetherweown.com/e/${e.event_key}`,
    is_published: true,
    position: i,
    starts_at: new Date(base - DAY),
    ends_at: new Date(base + 60 * DAY),
    created_by: SEED_OWNER,
  }));
  return { users: SEED_USERS, events, rsvps, featured };
}

export function summarize(seed) {
  return {
    users: seed.users.length,
    events: seed.events.length,
    futurePublished: 30,
    drafts: seed.events.filter((e) => e.status === "draft").length,
    cancelled: seed.events.filter((e) => e.status === "cancelled").length,
    pastPublished: 9,
    timezones: new Set(seed.events.map((e) => e.timezone)).size,
    fullEvents: 4,
    rsvps: seed.rsvps.length,
    waitlisted: seed.rsvps.filter((r) => r.status === "waitlisted").length,
    featured: seed.featured.length,
    seriesOccurrences: seed.events.filter((e) => e.recurrence_index !== null).length,
  };
}

export async function applySeed(sql, seed) {
  return sql.begin(async (tx) => {
    // Serialise seed runs, including the featured natural key (no unique index).
    await tx`SELECT pg_advisory_xact_lock(11163, 1)`;
    const keys = seed.events.map((e) => e.event_key);
    const collisions = await tx`SELECT id FROM events WHERE event_key IN ${tx(keys)} AND created_by IS DISTINCT FROM ${SEED_OWNER}`;
    if (collisions.length) throw new Error("Refusing seed: event key belongs to a non-seed row.");
    const users = await tx`SELECT id, username FROM users WHERE id IN ${tx(seed.users.map((u) => u.id))}`;
    const safeQaNames = new Map([[SEED_USERS[0].id, "QA Member"], [SEED_USERS[1].id, "QA Moderator"]]);
    if (users.some((u) => u.username !== seed.users.find((fixture) => fixture.id === u.id).username && u.username !== safeQaNames.get(u.id))) throw new Error("Refusing seed: fixture user ID belongs to a non-seed user.");
    const existingFeatured = await tx`SELECT id, title, created_by FROM featured_contents WHERE title IN ${tx(seed.featured.map((f) => f.title))}`;
    if (existingFeatured.some((f) => f.created_by !== SEED_OWNER) || new Set(existingFeatured.map((f) => f.title)).size !== existingFeatured.length) throw new Error("Refusing seed: featured natural key collision.");
    for (const user of seed.users) {
      await tx`INSERT INTO users ${tx({ ...user, avatar: null, member: true })}
        ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, avatar = NULL, member = true, updated_at = now()`;
    }
    const ids = new Map();
    for (const { parent_key, ...event } of seed.events) {
      const row = { ...event, starts_at: event.starts_at.toISOString(), ends_at: event.ends_at.toISOString(), parent_event_id: parent_key ? ids.get(parent_key) : null, recurrence_ends_on: null };
      const [saved] = await tx`INSERT INTO events ${tx(row)} ON CONFLICT (event_key) DO UPDATE SET
        title = EXCLUDED.title, game = EXCLUDED.game, description = EXCLUDED.description,
        starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, timezone = EXCLUDED.timezone,
        location = EXCLUDED.location, capacity = EXCLUDED.capacity, status = EXCLUDED.status,
        rsvp_open = EXCLUDED.rsvp_open, recurrence_frequency = EXCLUDED.recurrence_frequency,
        recurrence_count = EXCLUDED.recurrence_count, recurrence_ends_on = EXCLUDED.recurrence_ends_on,
        recurrence_index = EXCLUDED.recurrence_index, parent_event_id = EXCLUDED.parent_event_id,
        updated_at = now() RETURNING id`;
      ids.set(event.event_key, saved.id);
    }
    for (const { event_key, ...answer } of seed.rsvps) {
      await tx`INSERT INTO rsvps ${tx({ ...answer, event_id: ids.get(event_key) })}
        ON CONFLICT (event_id, user_id) DO UPDATE SET status = EXCLUDED.status, synced_to_discord_at = NULL, updated_at = now()`;
    }
    for (const featured of seed.featured) {
      const row = { ...featured, starts_at: featured.starts_at.toISOString(), ends_at: featured.ends_at.toISOString() };
      const [existing] = existingFeatured.filter((f) => f.title === featured.title);
      if (existing) await tx`UPDATE featured_contents SET ${tx({ ...row, updated_at: new Date().toISOString() })} WHERE id = ${existing.id}`;
      else await tx`INSERT INTO featured_contents ${tx(row)}`;
    }
    return summarize(seed);
  });
}

export function createSeedClient(postgres, raw) {
  const url = new URL(raw);
  return postgres(raw, {
    max: 1, connect_timeout: 10, debug: false, onnotice: () => {},
    host: hostname(url.hostname), database: decodeURIComponent(url.pathname.slice(1)),
    username: decodeURIComponent(url.username), port: Number(url.port || 5432),
    // Empty passwords and omitted ports must not fall back to PG* credentials.
    password: () => decodeURIComponent(url.password),
    ssl: url.searchParams.get("sslmode") || (url.hostname === "agent-testdb" ? false : "require"),
    target_session_attrs: "read-write",
    connection: { timezone: "UTC", search_path: "public", application_name: SEED_OWNER },
  });
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const mode = parseMode(args);
  const target = validateEnvironment(env);
  const seed = buildSeed();
  if (mode === "dry-run") {
    console.log(JSON.stringify({ mode, target: { host: target.host, name: target.name }, planned: summarize(seed) }, null, 2));
    return; // No postgres import or connection, including read-only probes.
  }
  const { default: postgres } = await import("postgres");
  const sql = createSeedClient(postgres, target.databaseUrl);
  try {
    const result = await applySeed(sql, seed);
    console.log(JSON.stringify({ mode, applied: result }, null, 2));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing seed:")) throw error;
    throw new Error("Seed transaction failed; changes rolled back. Check connectivity and migrations without logging DATABASE_URL.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
