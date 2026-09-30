#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import postgres from "postgres";

// Explicit projections are the import boundary: no password, remember token,
// session, OAuth credential or moderator field is ever read from legacy.
export async function importUsersProfiles(legacy, next, { dryRun = true } = {}) {
  return legacy.begin("isolation level repeatable read read only", async (source) => {
    // Timestamp text must be unambiguous even with caller/server DateStyle overrides.
    await source`set local datestyle = 'ISO, YMD'`;
    const users = await source`
      select discord_id, username, avatar, (discord_joined_at is not null) as member,
        created_at::text as created_at, coalesce(updated_at, created_at)::text as updated_at
      from users order by id`;
    const profiles = await source`
      select u.discord_id, p.bio, p.games, p.timezone,
        p.created_at::text as created_at, coalesce(p.updated_at, p.created_at)::text as updated_at
      from profiles p left join users u on u.id = p.user_id order by p.id`;

    for (const row of [...users, ...profiles]) {
      if (typeof row.discord_id !== "string" || !/^\d{1,20}$/.test(row.discord_id) || !row.created_at || !row.updated_at) {
        throw new Error("Invalid legacy identity or timestamps");
      }
    }
    for (const row of profiles) {
      if (!Array.isArray(row.games) || row.games.some((game) => typeof game !== "string")) {
        throw new Error("Invalid legacy profile games");
      }
    }

    return next.begin(dryRun ? "read only" : "", async (target) => {
      await target`set local datestyle = 'ISO, YMD'`;
      const counts = {
        users: { read: users.length, changed: 0, unchanged: 0, written: 0 },
        profiles: { read: profiles.length, changed: 0, unchanged: 0, written: 0 },
      };
      for (const row of users) {
        let changed;
        if (dryRun) {
          const identical = await target`
            select 1 from users where id = ${row.discord_id}
              and (username, avatar, member, created_at, updated_at) is not distinct from
                (${row.username}::text, ${row.avatar}::text, ${row.member}::boolean,
                 ${row.created_at}::timestamp at time zone 'UTC', ${row.updated_at}::timestamp at time zone 'UTC')`;
          changed = identical.length === 0;
        } else {
          const written = await target`
            insert into users (id, username, avatar, member, created_at, updated_at)
            values (${row.discord_id}, ${row.username}, ${row.avatar}, ${row.member},
              ${row.created_at}::timestamp at time zone 'UTC', ${row.updated_at}::timestamp at time zone 'UTC')
            on conflict (id) do update set username = excluded.username, avatar = excluded.avatar,
              member = excluded.member, created_at = excluded.created_at, updated_at = excluded.updated_at
            where (users.username, users.avatar, users.member, users.created_at, users.updated_at)
              is distinct from (excluded.username, excluded.avatar, excluded.member, excluded.created_at, excluded.updated_at)
            returning id`;
          changed = written.length !== 0;
        }
        counts.users[changed ? "changed" : "unchanged"]++;
        if (changed && !dryRun) counts.users.written++;
      }
      for (const row of profiles) {
        const games = target.json(row.games);
        let changed;
        if (dryRun) {
          const identical = await target`
            select 1 from profiles where user_id = ${row.discord_id}
              and (bio, games, timezone, created_at, updated_at) is not distinct from
                (${row.bio}::text, ${games}::jsonb, ${row.timezone}::text,
                 ${row.created_at}::timestamp at time zone 'UTC', ${row.updated_at}::timestamp at time zone 'UTC')`;
          changed = identical.length === 0;
        } else {
          const written = await target`
            insert into profiles (user_id, bio, games, timezone, created_at, updated_at)
            values (${row.discord_id}, ${row.bio}, ${games}, ${row.timezone},
              ${row.created_at}::timestamp at time zone 'UTC', ${row.updated_at}::timestamp at time zone 'UTC')
            on conflict (user_id) do update set bio = excluded.bio, games = excluded.games,
              timezone = excluded.timezone, created_at = excluded.created_at, updated_at = excluded.updated_at
            where (profiles.bio, profiles.games, profiles.timezone, profiles.created_at, profiles.updated_at)
              is distinct from (excluded.bio, excluded.games, excluded.timezone, excluded.created_at, excluded.updated_at)
            returning user_id`;
          changed = written.length !== 0;
        }
        counts.profiles[changed ? "changed" : "unchanged"]++;
        if (changed && !dryRun) counts.profiles.written++;
      }
      return { dryRun, ...counts };
    });
  });
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length === 1 && args[0] === "--help") {
    console.log("Usage: node bin/import/users-profiles.mjs [--dry-run | --apply]\nLEGACY_DATABASE_URL and DATABASE_URL must be supplied via env only. Default: --dry-run.");
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && !["--dry-run", "--apply"].includes(args[0]))) {
    console.error("users-profiles: refusing: expected --dry-run or --apply; connection URLs are env-only.");
    return 2;
  }
  if (!env.LEGACY_DATABASE_URL || !env.DATABASE_URL) {
    console.error("users-profiles: refusing: LEGACY_DATABASE_URL and DATABASE_URL must be set.");
    return 2;
  }
  if (env.LEGACY_DATABASE_URL === env.DATABASE_URL) {
    console.error("users-profiles: refusing: source and destination must differ.");
    return 2;
  }
  let legacy;
  let next;
  try {
    // Laravel timestamps are UTC wall times, independent of the client/server zone.
    const client = (url) => {
      const parsed = new URL(url);
      if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname || !parsed.username || parsed.pathname.length < 2) {
        throw new Error("Invalid connection URL");
      }
      return postgres(url, {
        max: 1, connect_timeout: 10, debug: false,
        connection: { timezone: "UTC" }, onnotice: () => {},
        // An empty URL password means empty, never an inherited PGPASSWORD.
        password: () => decodeURIComponent(parsed.password),
      });
    };
    legacy = client(env.LEGACY_DATABASE_URL);
    next = client(env.DATABASE_URL);
    const result = await importUsersProfiles(legacy, next, { dryRun: args[0] !== "--apply" });
    console.log(JSON.stringify({ table: "users", dryRun: result.dryRun, ...result.users }));
    console.log(JSON.stringify({ table: "profiles", dryRun: result.dryRun, ...result.profiles }));
    return 0;
  } catch {
    // Driver messages/details can include credentials, connection URLs and member
    // contents. Print none of them, even on malformed URLs or constraint failures.
    console.error("users-profiles: import failed; check connections, migrations and source data privately before retrying.");
    return 1;
  } finally {
    await Promise.all([legacy, next].map((sql) => sql?.end({ timeout: 2 }).catch(() => {})));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
