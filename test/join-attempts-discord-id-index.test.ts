// Acceptance: an index on join_attempts.discord_id backs the admin viewer's
// exact-match search (listJoinAttempts q, src/admin/reads.ts). The index is
// delivered by a new drizzle migration registered in the journal, the head
// snapshot and migrations.lock, declared in the Drizzle schema, safe to apply
// twice, and it changes neither the write path (recordAttempt) nor the
// age-only prune. All DDL/data stays in the guarded disposable schema.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listJoinAttempts } from "../src/admin/reads";
import { JOIN_ATTEMPT_PAGE_SIZE } from "../src/admin/table-list";
import { joinAttempts } from "../src/db/schema";
import { JOIN_ATTEMPT_RETENTION_DAYS } from "../src/jobs/constants";
import { pgPruneStores } from "../src/jobs/postgres";
import { recordAttempt } from "../src/join/service";
import type { Sql } from "../src/sessions";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const INDEX_NAME = "join_attempts_discord_id_idx";
const NOW = "2026-10-01T12:00:00Z";
const SEED_DISCORD_ID = "100000000000004242";
const root = new URL("../", import.meta.url);
const readRoot = (path: string) => readFile(fileURLToPath(new URL(path, root).href), "utf8");

const createsIndex = new RegExp(
  `create\\s+(unique\\s+)?index\\s+(if\\s+not\\s+exists\\s+)?"?${INDEX_NAME}"?\\b`,
  "i",
);

/** The one migration file creating the pinned index, discovered by content. */
async function indexMigration(): Promise<{ file: string; sql: string }> {
  const dir = fileURLToPath(new URL("drizzle/", root).href);
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const found: { file: string; sql: string }[] = [];
  for (const file of files) {
    const sql = await readRoot(`drizzle/${file}`);
    if (createsIndex.test(sql)) found.push({ file, sql });
  }
  expect(
    found.map((entry) => entry.file),
    `exactly one migration creates ${INDEX_NAME}`,
  ).toHaveLength(1);
  return found[0]!;
}

function predicateOf(whereSql: string | undefined): "none" | "not-null" {
  if (whereSql === undefined) return "none";
  expect(whereSql).toMatch(/"?discord_id"?\s+is\s+not\s+null/i);
  return "not-null";
}

it("declares a non-unique discord_id index in the Drizzle schema, adding no columns", () => {
  const config = getTableConfig(joinAttempts);
  expect(config.columns.map((column) => column.name).sort()).toEqual(
    ["created_at", "discord_id", "id", "legacy_id", "outcome", "request_id", "source"].sort(),
  );
  const declared = config.indexes.find((index) => index.config.name === INDEX_NAME);
  expect(declared, INDEX_NAME).toBeDefined();
  expect(declared!.config.columns.map((column) => ("name" in column ? column.name : null))).toEqual(
    ["discord_id"],
  );
  expect(declared!.config.unique ?? false).toBe(false);
  // Plain btree, or partial only on discord_id IS NOT NULL: either serves an
  // equality probe; any other predicate could silently exclude searched rows.
  predicateOf(
    declared!.config.where ? new PgDialect().sqlToQuery(declared!.config.where).sql : undefined,
  );
});

describe("migration history pin", () => {
  it("ships exactly one idempotent CREATE INDEX migration for discord_id", async () => {
    const { file, sql } = await indexMigration();
    expect(file).toMatch(/^\d{4}_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/);
    const statement = sql
      .split("--> statement-breakpoint")
      .find((part) => createsIndex.test(part))!;
    expect(statement).not.toMatch(/create\s+unique\s+index/i);
    // The repo's re-runnable index form (1013): a plain CREATE INDEX fails on
    // a schema that already carries the index, and CONCURRENTLY cannot run
    // inside the migration runner's transaction.
    expect(statement).toMatch(/create\s+index\s+if\s+not\s+exists/i);
    expect(statement).not.toMatch(/concurrently/i);
    expect(statement).toMatch(
      /on\s+"?join_attempts"?\s*(?:using\s+btree\s*)?\(\s*"?discord_id"?\s*\)/i,
    );
    const where = /where\s+(.+?);?\s*$/i.exec(statement.trim())?.[1];
    predicateOf(where);
  });

  it("registers the migration in the journal, its snapshot and migrations.lock", async () => {
    const { file, sql } = await indexMigration();
    const tag = file.replace(/\.sql$/, "");
    const journal = JSON.parse(await readRoot("drizzle/meta/_journal.json")) as {
      entries: { tag: string }[];
    };
    expect(journal.entries.map((entry) => entry.tag)).toContain(tag);

    const snapshot = JSON.parse(
      await readRoot(`drizzle/meta/${tag.split("_")[0]}_snapshot.json`),
    ) as {
      tables: Record<
        string,
        {
          columns: Record<string, unknown>;
          indexes: Record<
            string,
            { columns: { expression: string }[]; isUnique: boolean; where?: string }
          >;
        }
      >;
    };
    const table = snapshot.tables["public.join_attempts"];
    expect(table, "snapshot join_attempts").toBeDefined();
    expect(Object.keys(table!.columns).sort()).toEqual(
      ["created_at", "discord_id", "id", "legacy_id", "outcome", "request_id", "source"].sort(),
    );
    const snapIndex = table!.indexes[INDEX_NAME];
    expect(snapIndex, `snapshot index ${INDEX_NAME}`).toBeDefined();
    expect(snapIndex!.columns.map((column) => column.expression)).toEqual(["discord_id"]);
    expect(snapIndex!.isUnique).toBe(false);
    predicateOf(snapIndex!.where);

    const lock = JSON.parse(await readRoot("migrations.lock")) as {
      migrations: { path: string; sha256: string }[];
    };
    const entry = lock.migrations.find((item) => item.path === `drizzle/${file}`);
    expect(entry, `migrations.lock entry for ${file}`).toBeDefined();
    expect(entry!.sha256).toBe(createHash("sha256").update(sql).digest("hex"));
  });
});

describe.skipIf(!process.env.DATABASE_URL)("discord_id index (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let client: MemberDataFixture["client"];
  let raw: ReturnType<typeof postgres>;

  beforeAll(async () => {
    // Applies the full journal to a fresh schema, including the new migration.
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    client = fixture.client;
    // The fixture client carries Drizzle's date serializers; the jobs prune
    // stores take native postgres.js Date parameters (test/helpers/jobs-db.ts),
    // so the prune runs on its own raw pool scoped to the fixture schema.
    const url = testDatabaseUrl(process.env.DATABASE_URL!);
    raw = postgres(url.href, {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
    // A retained-window population of distinct discord ids, plus the null
    // discord_id rows the denied/error terminal paths still leave behind.
    await client`
      insert into join_attempts (outcome, source, request_id, discord_id, created_at)
      select case g % 3 when 0 then 'joined' when 1 then 'failed' else 'already_member' end,
             'join', 'req-' || g, '10000000000000' || lpad(g::text, 4, '0'),
             ${NOW}::timestamptz - (g % 28) * interval '1 day' - g * interval '1 second'
      from generate_series(1, 8000) g`;
    await client`
      insert into join_attempts (outcome, source, request_id, discord_id, created_at)
      select 'denied', 'join', null, null,
             ${NOW}::timestamptz - (g % 28) * interval '1 day'
      from generate_series(1, 500) g`;
    await client`analyze join_attempts`;
  });
  afterAll(async () => {
    await raw?.end({ timeout: 1 });
    await fixture?.dispose();
  });

  it("creates the exact index definition on a fresh migrated schema", async () => {
    const indexes = await client<{ tablename: string; indexname: string; indexdef: string }[]>`
      select tablename, indexname, indexdef from pg_indexes where schemaname = ${fixture.schemaName}`;
    const found = indexes.find((index) => index.indexname === INDEX_NAME);
    expect(found, INDEX_NAME).toBeDefined();
    expect(found!.tablename).toBe("join_attempts");
    expect(found!.indexdef).not.toMatch(/^CREATE UNIQUE INDEX/);
    expect(found!.indexdef).toContain("USING btree (discord_id)");
    const where = / WHERE (.+)$/.exec(found!.indexdef)?.[1]?.replace(/^\(|\)$/g, "");
    predicateOf(where);
  });

  it("applies twice over a pre-existing same-named index without replacing it or losing rows", async () => {
    const { sql: migration } = await indexMigration();
    await client.begin(async (tx) => {
      // Recreate an equivalent definition under the pinned name first, as an
      // imported/legacy schema could already carry it.
      await tx.unsafe(`drop index "${INDEX_NAME}"`);
      await tx.unsafe(`create index "${INDEX_NAME}" on "join_attempts" (discord_id)`);
      const snapshot = () => tx`
        select c.relname, c.oid, i.indexdef from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_indexes i on i.schemaname = n.nspname and i.indexname = c.relname
        where n.nspname = ${fixture.schemaName} and c.relname = ${INDEX_NAME}`;
      const rowCount = () => tx`select count(*) as attempts from join_attempts`;
      const before = await snapshot();
      const counts = await rowCount();
      expect(before).toHaveLength(1);
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of migration.split("--> statement-breakpoint"))
          if (statement.trim()) await tx.unsafe(statement);
        expect(await snapshot()).toEqual(before);
        expect(await rowCount()).toEqual(counts);
      }
    });
  });

  async function plan(statement: string, params: (string | number)[] = []): Promise<string> {
    return client.begin(async (tx) => {
      // Prove a usable access path, not production cost superiority on a
      // fixture-sized table. SET LOCAL keeps the setting inside this tx.
      await tx`set local enable_seqscan = off`;
      const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${statement}`, params);
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
  }

  it("uses the index for the discord_id arm of the admin viewer's exact-match search", async () => {
    // listJoinAttempts with q set adds `(discord_id = q OR request_id = q)`
    // inside the retention window, newest first, one page plus its lookahead.
    // A BitmapOr needs an index on BOTH arms, so until request_id is indexed
    // too the verbatim OR query still plans as a created_at bitmap + filter
    // even with this index present. What this migration must prove is the
    // discord_id equality itself: in the search's window, order and limit
    // shape the planner serves it from the new index. The bare equality is
    // also the member-erasure lookup shape, which must keep working verbatim.
    const since = new Date(
      Date.parse(NOW) - JOIN_ATTEMPT_RETENTION_DAYS * 86_400_000,
    ).toISOString();
    const limit = JOIN_ATTEMPT_PAGE_SIZE + 1;
    expect(
      await plan(
        `select id, outcome, source, request_id, discord_id, created_at from join_attempts
         where created_at >= $1 and discord_id = $2
         order by created_at desc, id desc limit ${limit}`,
        [since, SEED_DISCORD_ID],
      ),
    ).toContain(INDEX_NAME);
    expect(
      await plan("select id from join_attempts where discord_id = $1", [SEED_DISCORD_ID]),
    ).toContain(INDEX_NAME);
  });

  it("keeps the write path unchanged: rows land verbatim, duplicates and nulls allowed", async () => {
    const sql = client as unknown as Sql;
    await recordAttempt(sql, {
      outcome: "added",
      source: "join",
      requestId: "req-write-discord-1",
      discordId: "100000000000009001",
    });
    // A member who retries the join leaves a second row with the same
    // discord_id: the index is a search aid, never a uniqueness constraint
    // on the write-once trail.
    await recordAttempt(sql, {
      outcome: "added",
      source: "join",
      requestId: "req-write-discord-2",
      discordId: "100000000000009001",
    });
    await recordAttempt(sql, {
      outcome: "denied",
      source: null,
      requestId: null,
      discordId: null,
    });
    await expect(
      recordAttempt(null, {
        outcome: "added",
        source: "join",
        requestId: "req-never-stored",
        discordId: "100000000000009099",
      }),
    ).resolves.toBeUndefined();
    const written = await client`
      select outcome, source, request_id, discord_id from join_attempts
      where discord_id = '100000000000009001' order by request_id`;
    expect(written).toEqual([
      {
        outcome: "added",
        source: "join",
        request_id: "req-write-discord-1",
        discord_id: "100000000000009001",
      },
      {
        outcome: "added",
        source: "join",
        request_id: "req-write-discord-2",
        discord_id: "100000000000009001",
      },
    ]);
    expect(
      await client`select count(*)::int as n from join_attempts where discord_id = '100000000000009099'`,
    ).toEqual([{ n: 0 }]);
  });

  it("keeps exact-match search semantics: discord id, request id, never substring", async () => {
    const byDiscord = await listJoinAttempts(fixture.db, {
      q: SEED_DISCORD_ID,
      now: new Date(NOW),
    });
    expect(byDiscord).toHaveLength(1);
    expect(byDiscord[0]).toMatchObject({ requestId: "req-4242", discordId: SEED_DISCORD_ID });
    const byRequest = await listJoinAttempts(fixture.db, {
      q: "req-4242",
      now: new Date(NOW),
    });
    expect(byRequest.map((row) => row.id)).toEqual(byDiscord.map((row) => row.id));
    expect(
      await listJoinAttempts(fixture.db, { q: "0000000000004242", now: new Date(NOW) }),
    ).toEqual([]);
    expect(
      await listJoinAttempts(fixture.db, { q: "100000000000009999", now: new Date(NOW) }),
    ).toEqual([]);
  });

  it("keeps the age-only prune unchanged: strictly-older rows go, edge and fresh stay", async () => {
    await client`
      insert into join_attempts (outcome, source, request_id, discord_id, created_at) values
        ('joined', 'join', 'req-prune-old', '100000000000008001', '2025-12-31T23:59:59Z'),
        ('joined', 'join', 'req-prune-edge', '100000000000008002', '2026-01-01T00:00:00Z'),
        ('joined', 'join', 'req-prune-fresh', '100000000000008003', '2026-01-02T00:00:00Z')`;
    const stores = pgPruneStores(raw);
    const cutoff = new Date("2026-01-01T00:00:00Z");
    expect(await stores.joinAttempts.pruneOlderThan(cutoff)).toBe(1);
    expect(await stores.joinAttempts.pruneOlderThan(cutoff)).toBe(0);
    const remaining = await client<{ discord_id: string }[]>`
      select discord_id from join_attempts where request_id like 'req-prune-%' order by created_at`;
    expect(remaining.map((row) => row.discord_id)).toEqual([
      "100000000000008002",
      "100000000000008003",
    ]);
    // The retained population is untouched by a prune with this cutoff.
    expect(
      await listJoinAttempts(fixture.db, { q: SEED_DISCORD_ID, now: new Date(NOW) }),
    ).toHaveLength(1);
  });
});
