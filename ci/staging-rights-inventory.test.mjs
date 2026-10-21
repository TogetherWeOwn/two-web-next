import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const entry = new URL("./staging-rights-inventory.mjs", import.meta.url);
const sentinel = "SYNTHETIC_PRIVATE_SENTINEL";

// Changing normal entry to import a driver, inspect env, or select a target must fail.
test("inventory normal entry is an unconditional fixed-label refusal", () => {
  assert.ok(existsSync(entry), "inert inventory entry must exist");
  for (const args of [[], ["--selftest"], ["--target=staging"], ["--client=fake"], [sentinel]]) {
    const result = spawnSync(process.execPath, [entry.pathname, ...args], {
      cwd: root,
      env: { PATH: process.env.PATH, PLANETSCALE_STAGING_DATABASE_URL: sentinel },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "inventory stopped\n");
    assert.equal(result.stderr, "");
  }
});

test("import and entry cannot inspect env, import clients, or construct sockets", () => {
  assert.ok(existsSync(entry), "inert inventory entry must exist");
  const source = `
    import { registerHooks } from 'node:module';
    import net from 'node:net';
    import tls from 'node:tls';
    import http from 'node:http';
    import https from 'node:https';
    import dgram from 'node:dgram';
    import { pathToFileURL } from 'node:url';
    const fail = () => { throw new Error('${sentinel}'); };
    net.connect = net.createConnection = net.Socket.prototype.connect = fail;
    tls.connect = http.request = http.get = https.request = https.get = fail;
    dgram.createSocket = globalThis.fetch = globalThis.WebSocket = fail;
    globalThis.inventoryGuard = Object.freeze({get env() { fail(); }, get argv() { fail(); }});
    registerHooks({
      resolve(specifier, context, next) {
        if (!specifier.startsWith('file:')) fail();
        return next(specifier, context);
      },
      load(url, context, next) {
        const result = next(url, context);
        return {...result, source: 'const process = globalThis.inventoryGuard;\\n' + result.source};
      }
    });
    process.argv = ['node', '${entry.pathname}', '--target=${sentinel}'];
    const module = await import('${entry.href}');
    if (module.inventoryStatus() !== 'inventory stopped') fail();
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: root,
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, "import must not touch guarded capabilities");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  const code = readFileSync(entry, "utf8");
  assert.doesNotMatch(code, /process\.(?:env|argv)|import\s*(?:\(|["'{*])|require\s*\(/);
});

async function modules() {
  assert.ok(
    existsSync(new URL("./staging-rights-inventory/synthetic.mjs", import.meta.url)),
    "synthetic-only seam must exist",
  );
  const synthetic = await import("./staging-rights-inventory/synthetic.mjs");
  const reads = await import("./staging-rights-inventory/reads.mjs");
  const { fixture } = await import("./staging-rights-inventory/fixtures.mjs");
  return { ...synthetic, ...reads, fixture };
}

// SQL keywords that textually resemble unqualified `name(` calls but invoke
// nothing: grouping keywords, EXISTS/IN predicates and the SQL-standard
// conditional. CTE column-alias definitions are derived per read instead, so a
// new builtin cannot hide behind either form.
const UNQUALIFIED_KEYWORDS = [
  "AND",
  "AS",
  "CASE",
  "COALESCE",
  "EXISTS",
  "IN",
  "NOT",
  "ON",
  "OR",
  "WHERE",
];

// Bare keywords: every other unqualified token candidate reads may use. Kept
// separate from UNQUALIFIED_KEYWORDS (call-shaped skips) so each list documents
// its own gate. CURRENT_USER/SESSION_USER are the keyword call forms, never
// parenthesized; PG_CATALOG is the schema qualifier of every fixed call and
// catalog target.
const SQL_KEYWORDS = [
  ...UNQUALIFIED_KEYWORDS,
  "ALL",
  "BY",
  "CROSS",
  "CURRENT_USER",
  "ELSE",
  "END",
  "FROM",
  "IS",
  "JOIN",
  "LATERAL",
  "LEFT",
  "NULL",
  "ORDER",
  "PG_CATALOG",
  "RECURSIVE",
  "SELECT",
  "SESSION_USER",
  "THEN",
  "TRUE",
  "UNION",
  "WHEN",
  "WITH",
];

function blankLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

// CTE names and definition columns from the WITH clause. The column list is
// optional (edges/acl_entries carry none); the WITH/comma anchor keeps a
// planted `name AS (` outside a CTE definition from registering a name.
function cteDefinitions(sql) {
  const names = new Set();
  const columns = new Set();
  const defs = /(?:WITH\s+RECURSIVE|WITH|,)\s*(\w+)\s*(?:\(([^)]*)\)\s*)?AS\s*\(/gi;
  for (const [, name, list] of sql.matchAll(defs)) {
    names.add(name.toUpperCase());
    if (list !== undefined)
      for (const column of list.split(","))
        if (/^[A-Za-z_]\w*$/.test(column.trim())) columns.add(column.trim().toUpperCase());
  }
  return { names, columns };
}

// Alias (upper) -> catalog table (lower) for every pg_catalog FROM/JOIN/comma
// target. A call-shaped `pg_catalog.name(` is never a table target; a target
// with no usable alias (keyword or end of clause) registers under its own
// table name, so table-qualified references still resolve against the
// allowlist instead of being skipped.
function catalogAliases(sql) {
  const aliases = new Map();
  const target = /(?:FROM|JOIN|,)\s*pg_catalog\.(\w+)\b(?!\s*\()(?:\s+AS\s+(\w+)|\s+(\w+))?/gi;
  for (const [, table, asAlias, alias] of sql.matchAll(target)) {
    const name = asAlias ?? alias;
    if (name && !SQL_KEYWORDS.includes(name.toUpperCase()))
      aliases.set(name.toUpperCase(), table.toLowerCase());
    else aliases.set(table.toUpperCase(), table.toLowerCase());
  }
  return aliases;
}

// Non-catalog aliases usable as bare tokens: CTE FROM/JOIN/comma targets and
// LATERAL function-output aliases (`) alias ON`). CTE-qualified and
// function-output columns are not catalog columns, so they stay out of the
// per-catalog check while their aliases still resolve as bare tokens.
function extraAliases(sql, cteNames) {
  const aliases = new Set();
  if (cteNames.size > 0) {
    const cte = [...cteNames].join("|");
    const target = new RegExp(`(?:FROM|JOIN|,)\\s*(?:${cte})\\s*(?:AS\\s+(\\w+)|(\\w+))?`, "gi");
    for (const [, asAlias, alias] of sql.matchAll(target)) {
      const name = asAlias ?? alias;
      if (name && !SQL_KEYWORDS.includes(name.toUpperCase())) aliases.add(name.toUpperCase());
    }
  }
  for (const [, alias] of sql.matchAll(/\)\s*(?:AS\s+)?(\w+)\s+ON\b/gi))
    if (!SQL_KEYWORDS.includes(alias.toUpperCase())) aliases.add(alias.toUpperCase());
  return aliases;
}

function assertBuiltinCalls(read, builtins) {
  const sql = blankLiterals(read.sql);
  const { names: ctes } = cteDefinitions(sql);
  const fixed = builtins.map((name) => name.toLowerCase());
  for (const [, schema, builtin] of sql.matchAll(/([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g)) {
    assert.equal(
      schema.toLowerCase(),
      "pg_catalog",
      `${read.id}: qualified call outside pg_catalog: ${schema}.${builtin}`,
    );
    assert.ok(
      fixed.includes(builtin.toLowerCase()),
      `${read.id}: builtin outside fixed list: ${builtin.toLowerCase()}`,
    );
  }
  for (const [, name] of sql.matchAll(/(?<![\w."'])([A-Za-z_]\w*)\s*\(/g)) {
    const upper = name.toUpperCase();
    if (UNQUALIFIED_KEYWORDS.includes(upper) || ctes.has(upper)) continue;
    assert.fail(`${read.id}: unqualified call outside fixed list: ${name}`);
  }
}

function assertNoQuotedIdentifiers(read) {
  // The sole double-quoted form in candidate SQL is the ::"char" cast in the
  // relation_acls defaults; any other quote is a quoted identifier, which
  // PostgreSQL resolves case-sensitively outside the allowlist spellings.
  assert.doesNotMatch(
    read.sql.replace(/::"char"/g, ""),
    /"/,
    `${read.id}: quoted identifier outside the fixed ::"char" cast`,
  );
}

function assertBareTokens(read) {
  // Every unqualified token must be a fixed keyword, a declared output field,
  // a table/CTE alias, a CTE name or a CTE definition column. Qualified
  // references (after .), cast targets (after :) and string contents never
  // reach this check, so an unqualified column reference cannot evade the
  // alias-qualified per-catalog check above.
  const sql = blankLiterals(read.sql).replace(/::"char"/g, "");
  const { names: ctes, columns: cteColumns } = cteDefinitions(sql);
  const allowed = new Set([...SQL_KEYWORDS, ...ctes, ...cteColumns]);
  for (const field of read.fields ?? []) allowed.add(field.toUpperCase());
  for (const alias of catalogAliases(sql).keys()) allowed.add(alias);
  for (const alias of extraAliases(sql, ctes)) allowed.add(alias);
  for (const [, token] of sql.matchAll(/(?<![\w.:\"'])([A-Za-z_]\w*)/g))
    assert.ok(
      allowed.has(token.toUpperCase()),
      `${read.id}: bare token outside fixed surface: ${token}`,
    );
}

function assertCatalogColumns(read, catalogColumns) {
  const sql = blankLiterals(read.sql);
  const aliases = catalogAliases(sql);
  const allowed = Object.fromEntries(
    Object.entries(catalogColumns).map(([table, columns]) => [
      table.toLowerCase(),
      columns.map((column) => column.toLowerCase()),
    ]),
  );
  for (const [, alias, column] of sql.matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g)) {
    const table = aliases.get(alias.toUpperCase());
    if (table !== undefined)
      assert.ok(
        (allowed[table] ?? []).includes(column.toLowerCase()),
        `${read.id}: ${alias}.${column}`,
      );
  }
}

test("unbound or arbitrary transport denies before any client work", async () => {
  const { runSyntheticInventory, syntheticClient, fixture } = await modules();
  for (const transport of [
    undefined,
    {},
    {
      deliver() {
        throw new Error(sentinel);
      },
    },
  ]) {
    const client = syntheticClient(fixture());
    assert.equal(await runSyntheticInventory({ client, transport }), "inventory stopped");
    assert.deepEqual(client.events, []);
  }
});

test("arbitrary live client cannot enter the synthetic seam", async () => {
  const { runSyntheticInventory, syntheticTransport } = await modules();
  let constructed = 0;
  const client = new Proxy(
    {},
    {
      get() {
        constructed++;
        throw new Error(sentinel);
      },
    },
  );
  assert.equal(
    await runSyntheticInventory({ client, transport: syntheticTransport() }),
    "inventory stopped",
  );
  assert.equal(constructed, 0);
});

test("synthetic success uses identity first, one read-only snapshot, rollback and close", async () => {
  const {
    runSyntheticInventory,
    syntheticClient,
    syntheticTransport,
    fixture,
    READS,
    TRANSACTION,
  } = await modules();
  const client = syntheticClient(fixture());
  const transport = syntheticTransport();
  assert.equal(await runSyntheticInventory({ client, transport }), "inventory complete");
  assert.deepEqual(client.events, [
    TRANSACTION.begin,
    ...TRANSACTION.setup,
    ...READS.map((r) => r.id),
    "ROLLBACK",
    "CLOSE",
    "DELIVER",
  ]);
  assert.equal(transport.payloads.length, 1);
  assert.equal(transport.payloads[0].syntheticOnly, true);
  assert.ok(transport.payloads[0].unknowns.includes("live-permissions-and-visibility"));
  assert.equal(transport.payloads[0].membership.forward.includes(30), true);
  assert.equal(transport.payloads[0].membership.reverse.includes(60), true);
});

test("fixed PG18 reads expose only declared columns, catalogs and builtins", async () => {
  const { READS, CATALOG_COLUMNS, BUILTINS, POLICY_TABLES } = await modules();
  assert.equal(POLICY_TABLES.length, 22);
  assert.equal(new Set(POLICY_TABLES).size, 22);
  assert.equal(READS[0].id, "identity");
  const sql = READS.map((r) => r.sql).join("\n");
  assert.doesNotMatch(
    sql,
    /select\s+\*|pg_authid|pg_stat_activity|rolpassword|prosrc|probin|proargdefaults|tgargs|pg_get_expr|pg_get_functiondef|pg_get_triggerdef|nextval|setval|last_value|information_schema|\$\d|\bSET ROLE\b/i,
  );
  for (const read of READS) {
    assert.ok(Object.isFrozen(read));
    assert.ok(read.prechecks.length > 0);
    assert.ok(read.fields.length > 0);
    assert.match(read.sql, /^\s*(?:SELECT|WITH RECURSIVE)\b/i);
    assert.doesNotMatch(
      read.sql,
      /;|--|\/\*|\b(?:INSERT|UPDATE|DELETE|GRANT|REVOKE|CALL|DO|COPY)\b/i,
    );
    const targets =
      /\b(?:FROM|JOIN)\s+pg_catalog\.(\w+)\b(?!\s*\()|,\s*pg_catalog\.(\w+)\b(?!\s*\()/gi;
    for (const [, fromJoin, comma] of read.sql.matchAll(targets)) {
      const catalog = (fromJoin ?? comma).toLowerCase();
      assert.ok(Object.hasOwn(CATALOG_COLUMNS, catalog), `catalog outside fixed list: ${catalog}`);
    }
    assertBuiltinCalls(read, BUILTINS);
  }
  assert.ok(Object.isFrozen(READS));
  assert.match(sql, /pg_catalog\.pg_default_acl/);
  assert.match(sql, /pg_catalog\.pg_auth_members/);
  assert.match(sql, /inhparent/);
  assert.match(sql, /attidentity/);
  assert.match(sql, /attacl/);
  assert.match(sql, /acldefault/);
  assert.match(sql, /pg_has_role/);
  assert.doesNotMatch(sql, /inet_server_addr\(\)\s*(?:AS|,)/i);
});

test("policy scope pins exact proposal names against schema declarations", async () => {
  const { POLICY_TABLES } = await modules();
  assert.deepEqual(POLICY_TABLES, [
    "users",
    "profiles",
    "discord_event_snapshots",
    "job_unique_locks",
    "queue_jobs",
    "featured_contents",
    "rsvps",
    "agent_event_idempotency_keys",
    "agent_event_audits",
    "agent_event_hits",
    "member_data_access_logs",
    "event_search_logs",
    "board_view_logs",
    "events",
    "event_sync_attempts",
    "queue_failed_jobs",
    "activity_log",
    "agent_event_grants",
    "join_attempts",
    "web_throttle_hits",
    "web_sessions",
    "web_oauth_journeys",
  ]);
  const declared = [];
  for (const rel of ["src/db/schema.ts", "src/db/admin-schema.ts"]) {
    const text = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    for (const [, name] of text.matchAll(/pgTable\(\s*"([A-Za-z0-9_]+)"/g)) declared.push(name);
  }
  // web_session_grace postdates the frozen proposal scope: the census still
  // surfaces it as an extra-table finding, but the candidate policies read
  // covers only the exact proposal tables plus the separate ledger. Any other
  // drift in either direction fails loudly here.
  assert.deepEqual(
    declared.filter((name) => !POLICY_TABLES.includes(name)),
    ["web_session_grace"],
  );
  assert.deepEqual(
    POLICY_TABLES.filter((name) => !declared.includes(name)),
    [],
  );
});

test("every failed read, setup, rollback, close or delivery is a fixed-label STOP", async () => {
  const {
    runSyntheticInventory,
    syntheticClient,
    syntheticTransport,
    fixture,
    READS,
    TRANSACTION,
  } = await modules();
  for (const failure of [
    TRANSACTION.begin,
    ...TRANSACTION.setup,
    ...READS.map((r) => r.id),
    "ROLLBACK",
    "CLOSE",
    "DELIVER",
  ]) {
    const client = syntheticClient(fixture(), { failAt: failure, error: sentinel });
    const transport = syntheticTransport({ fail: failure === "DELIVER", error: sentinel });
    assert.equal(await runSyntheticInventory({ client, transport }), "inventory stopped");
    assert.ok(client.events.includes("CLOSE"));
    if (failure !== TRANSACTION.begin) assert.ok(client.events.includes("ROLLBACK"));
    if (failure !== "DELIVER") assert.equal(transport.payloads.length, 0);
  }
});

test("version, fields, missing roles and incomplete outputs are unknown, never safe", async () => {
  const {
    runSyntheticInventory,
    syntheticClient,
    syntheticTransport,
    fixture,
    READS,
    TRANSACTION,
  } = await modules();
  // Identity-gate failures must stop at identity: the frozen PG18 SQL must
  // not run any later catalog SELECT against another major version.
  const gateMutations = [
    (f) => {
      f.identity.rows[0].server_version_num = 170000;
    },
    (f) => {
      f.identity.rows[0].server_version_num = "180000";
    },
    (f) => {
      f.identity.rows[0].server_address_present = false;
    },
  ];
  for (const mutate of gateMutations) {
    const data = fixture();
    mutate(data);
    const client = syntheticClient(data);
    const transport = syntheticTransport();
    assert.equal(await runSyntheticInventory({ client, transport }), "inventory stopped");
    assert.equal(transport.payloads.length, 0);
    assert.deepEqual(client.events, [
      TRANSACTION.begin,
      ...TRANSACTION.setup,
      "identity",
      "ROLLBACK",
      "CLOSE",
    ]);
  }
  const mutations = [
    (f) => {
      f.roles.rows = [];
    },
    (f) => {
      f.roles.rows[0].role_name = "missing";
    },
    (f) => {
      f.memberships.rows[0].grantor_oid = 999999;
    },
    (f) => {
      f.memberships.rows[0].inherit_option = null;
    },
    (f) => {
      f.identity.rows[0].unexpected = sentinel;
    },
    (f) => {
      delete f.identity.rows[0].database_name;
    },
    (f) => {
      f.identity.rows = [];
    },
    (f) => {
      f.schemas.rows = [];
    },
    (f) => {
      f.relations.rows = [];
    },
    (f) => {
      f.columns.rows = [];
    },
    (f) => {
      f.extra = { rows: [], complete: true };
    },
    ...READS.map((r) => (f) => {
      f[r.id].complete = false;
    }),
    ...READS.map((r) => (f) => {
      delete f[r.id];
    }),
    ...READS.map((r) => (f) => {
      f[r.id].fields = [];
    }),
  ];
  for (const mutate of mutations) {
    const data = fixture();
    mutate(data);
    const client = syntheticClient(data);
    const transport = syntheticTransport();
    assert.equal(await runSyntheticInventory({ client, transport }), "inventory stopped");
    assert.equal(transport.payloads.length, 0);
    assert.ok(client.events.includes("ROLLBACK"));
    assert.ok(client.events.includes("CLOSE"));
  }
});

test("ACL NULL, empty, explicit and implicit-owner semantics remain distinct", async () => {
  const { runSyntheticInventory, syntheticClient, syntheticTransport, fixture } = await modules();
  const transport = syntheticTransport();
  assert.equal(
    await runSyntheticInventory({ client: syntheticClient(fixture()), transport }),
    "inventory complete",
  );
  const rows = transport.payloads[0].reads.relation_acls;
  assert.deepEqual(
    new Set(rows.map((r) => r.acl_state)),
    new Set(["null-default", "empty", "explicit"]),
  );
  assert.ok(rows.some((r) => r.grantee_oid === 0));
  assert.ok(rows.some((r) => r.grantable === true));
  assert.ok(rows.every((r) => r.owner_oid > 0));
  assert.equal(transport.payloads[0].implicitOwnerRights, "separate-from-acl");
});

test("policy findings omit raw expressions and retain unresolved safety claims", async () => {
  const { runSyntheticInventory, syntheticClient, syntheticTransport, fixture } = await modules();
  const data = fixture();
  data.policies.rows[0].expression_present = true;
  const transport = syntheticTransport();
  assert.equal(
    await runSyntheticInventory({ client: syntheticClient(data), transport }),
    "inventory complete",
  );
  assert.ok(transport.payloads[0].unknowns.includes("exact-policy-and-trigger-expressions"));
  assert.ok(transport.payloads[0].unknowns.includes("private-named-principals"));
  assert.ok(transport.payloads[0].unknowns.includes("importer-custodian-and-planned-runs"));
});

test("synthetic sentinels and errors never reach any public output channel", async () => {
  const { runSyntheticInventory, syntheticClient, syntheticTransport, fixture } = await modules();
  const outputs = [];
  const originals = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    out: process.stdout.write,
    err: process.stderr.write,
  };
  console.log =
    console.error =
    console.warn =
      (...args) => {
        outputs.push(args.join(" "));
      };
  process.stdout.write = process.stderr.write = (chunk) => {
    outputs.push(String(chunk));
    return true;
  };
  try {
    for (const failAt of [undefined, "identity", "ROLLBACK", "CLOSE"]) {
      const data = fixture();
      data.identity.rows[0].current_user_name = sentinel;
      const client = syntheticClient(data, { failAt, error: sentinel, notice: sentinel });
      const status = await runSyntheticInventory({ client, transport: syntheticTransport() });
      assert.ok(["inventory complete", "inventory stopped"].includes(status));
    }
  } finally {
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
    process.stdout.write = originals.out;
    process.stderr.write = originals.err;
  }
  assert.deepEqual(outputs, []);
});

test("membership SQL keeps forward and reverse traversals separate", async () => {
  const { READS } = await modules();
  const sql = READS.find((r) => r.id === "memberships").sql;
  assert.match(sql, /direction/);
  assert.doesNotMatch(sql, /m\.roleid = c\.oid OR m\.member = c\.oid/);
});

test("candidate SQL stays inside the exact fixed surface", async () => {
  const { READS, CATALOG_COLUMNS } = await modules();
  for (const read of READS) {
    assertCatalogColumns(read, CATALOG_COLUMNS);
    assertNoQuotedIdentifiers(read);
    assertBareTokens(read);
  }
});

test("allowlist checks reject non-fixed SQL spellings", async () => {
  const { CATALOG_COLUMNS, BUILTINS } = await modules();
  const mutant = (sql) => ({ id: "mutant", sql });
  // AS-aliased catalog references must still resolve against the allowlist.
  assertCatalogColumns(mutant("SELECT p.prokind FROM pg_catalog.pg_proc AS p"), CATALOG_COLUMNS);
  assert.throws(
    () =>
      assertCatalogColumns(
        mutant("SELECT p.provolatile FROM pg_catalog.pg_proc AS p"),
        CATALOG_COLUMNS,
      ),
    /mutant: p\.provolatile/,
  );
  // Comma-joined catalog targets resolve too: the second target's alias is
  // enumerated, so its forbidden columns fail instead of being skipped.
  assert.throws(
    () =>
      assertCatalogColumns(
        mutant("SELECT p.provolatile FROM pg_catalog.pg_class c, pg_catalog.pg_proc p"),
        CATALOG_COLUMNS,
      ),
    /mutant: p\.provolatile/,
  );
  // Alias-less targets resolve under their own table name, even when a clause
  // keyword directly follows the target.
  assertCatalogColumns(mutant("SELECT pg_proc.prokind FROM pg_catalog.pg_proc"), CATALOG_COLUMNS);
  assert.throws(
    () =>
      assertCatalogColumns(
        mutant("SELECT pg_proc.provolatile FROM pg_catalog.pg_proc WHERE pg_proc.prokind = 1"),
        CATALOG_COLUMNS,
      ),
    /mutant: pg_proc\.provolatile/,
  );
  // Unqualified builtins resolve via the pg_catalog search path, so they fail.
  assert.throws(
    () =>
      assertBuiltinCalls(
        mutant("SELECT has_table_privilege(c.oid, 'SELECT') FROM pg_catalog.pg_class c"),
        BUILTINS,
      ),
    /mutant: unqualified call outside fixed list: has_table_privilege/,
  );
  // Uppercase spellings fold to the same identifiers, so they fail identically.
  assert.throws(
    () =>
      assertBuiltinCalls(mutant("SELECT PG_CATALOG.HAS_TABLE_PRIVILEGE(1, 'SELECT')"), BUILTINS),
    /mutant: builtin outside fixed list: has_table_privilege/,
  );
  // Other-schema qualified calls are outside the fixed surface.
  assert.throws(
    () => assertBuiltinCalls(mutant("SELECT public.synthetic_guard()"), BUILTINS),
    /mutant: qualified call outside pg_catalog: public\.synthetic_guard/,
  );
  // Qualified allowlisted calls and keyword forms still pass.
  assertBuiltinCalls(
    mutant(
      "SELECT pg_catalog.pg_has_role(r.oid, 1, 'MEMBER'), current_user::text FROM pg_catalog.pg_roles r",
    ),
    BUILTINS,
  );
  // Quoted identifiers resolve outside the allowlist spellings, so they fail.
  assert.throws(
    () => assertNoQuotedIdentifiers(mutant('SELECT "p"."provolatile" FROM pg_catalog.pg_proc p')),
    /mutant: quoted identifier outside the fixed ::"char" cast/,
  );
  assert.throws(
    () => assertNoQuotedIdentifiers(mutant('SELECT pg_catalog."has_table_privilege"(1)')),
    /mutant: quoted identifier outside the fixed ::"char" cast/,
  );
  // The fixed ::"char" cast is the sole quoted exception.
  assertNoQuotedIdentifiers(mutant("SELECT 's'::\"char\""));
  // Unqualified columns evade the alias-qualified check, so bare tokens fail.
  assert.throws(
    () => assertBareTokens(mutant("SELECT provolatile FROM pg_catalog.pg_proc p")),
    /mutant: bare token outside fixed surface: provolatile/,
  );
  // Fixed spellings resolve: keywords, fields, aliases and CTE references pass.
  assertBareTokens({
    id: "mutant",
    fields: ["function_kind"],
    sql: "SELECT p.prokind::text AS function_kind FROM pg_catalog.pg_proc p",
  });
});

test("cycles terminate and incomplete ACL or MEMBER rows cannot pass", async () => {
  const { runSyntheticInventory, syntheticClient, syntheticTransport, fixture } = await modules();
  const mutations = [
    (f) => {
      f.relation_acls.rows = [];
    },
    // A single missing in-scope ACL row must stop at the per-relation
    // comparison: dropping only relation 100 keeps the 101/102 rows, so the
    // non-empty check above cannot stop this and only the completeness guard
    // can. Without this pin the guard is deletable with the suite green.
    (f) => {
      f.relation_acls.rows = f.relation_acls.rows.filter((r) => r.relation_oid !== 100);
    },
    (f) => {
      f.column_acls.rows.pop();
    },
    (f) => {
      f.schema_acls.rows.pop();
    },
    (f) => {
      f.member_checks.rows.pop();
    },
    (f) => {
      f.member_checks.rows[0].is_member = false;
    },
    (f) => {
      f.relation_acls.rows[2].privilege = "SELECT";
    },
  ];
  for (const mutate of mutations) {
    const data = fixture();
    mutate(data);
    assert.equal(
      await runSyntheticInventory({
        client: syntheticClient(data),
        transport: syntheticTransport(),
      }),
      "inventory stopped",
    );
  }
  const data = fixture();
  data.memberships.rows.push({
    membership_oid: 10,
    role_oid: 10,
    member_oid: 30,
    grantor_oid: 40,
    admin_option: false,
    inherit_option: true,
    set_option: false,
  });
  for (const check of data.member_checks.rows)
    if ([10, 20, 30, 50, 60].includes(check.member_oid)) check.is_member = true;
  const transport = syntheticTransport();
  assert.equal(
    await runSyntheticInventory({ client: syntheticClient(data), transport }),
    "inventory complete",
  );
  assert.deepEqual(transport.payloads[0].membership.forward, [10, 20, 30]);
  assert.deepEqual(transport.payloads[0].membership.reverse, [10, 20, 30, 50, 60]);
});

test("missing proposal objects remain findings, never a safe rights verdict", async () => {
  const { runSyntheticInventory, syntheticClient, syntheticTransport, fixture } = await modules();
  const transport = syntheticTransport();
  assert.equal(
    await runSyntheticInventory({ client: syntheticClient(fixture()), transport }),
    "inventory complete",
  );
  const payload = transport.payloads[0];
  assert.equal(payload.rightsVerdict, "unknown-stop");
  assert.ok(payload.findings.missingProposalTables.includes("profiles"));
  assert.equal(payload.findings.ledgerPresent, true);
});

test("source blob manifest generator exists independently of inventory entry", () => {
  assert.ok(
    existsSync(new URL("./staging-rights-inventory/manifest.mjs", import.meta.url)),
    "canonical Git-blob manifest generator must exist",
  );
});

test("manifest hashes raw blob bytes and refuses missing or symlinked protected paths", async () => {
  const { sourceManifest, PROTECTED_PATHS } = await import(
    "./staging-rights-inventory/manifest.mjs"
  );
  const { createHash } = await import("node:crypto");
  const bytes = Buffer.from("synthetic\r\nblob\0bytes\xff", "latin1");
  assert.ok([13, 10, 0, 255].every((byte) => bytes.includes(byte)));
  const entries = PROTECTED_PATHS.map((path, i) => ({
    path,
    mode: i === 0 ? "100755" : "100644",
    type: "blob",
    oid: "b".repeat(40),
  }));
  const input = { head: "a".repeat(40), tree: "c".repeat(40), entries, readBlob: () => bytes };
  const result = sourceManifest(input);
  assert.equal(result.files[0].sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.files[0].bytes, bytes.length);
  assert.equal(result.files[0].mode, "100755");
  assert.equal(result.liveAdmissionImplemented, false);
  assert.deepEqual(sourceManifest({ ...input, entries: [...entries].reverse() }), result);
  assert.throws(() => sourceManifest({ ...input, entries: entries.slice(1) }), /inventory stopped/);
  assert.throws(
    () =>
      sourceManifest({
        ...input,
        entries: entries.map((e, i) => (i === 0 ? { ...e, mode: "120000" } : e)),
      }),
    /inventory stopped/,
  );
  assert.throws(
    () => sourceManifest({ ...input, readBlob: () => "normalized text" }),
    /inventory stopped/,
  );
});

test("synthetic imports and execution have no filesystem, summary, annotation or socket sink", () => {
  const synthetic = new URL("./staging-rights-inventory/synthetic.mjs", import.meta.url).href;
  const fixtures = new URL("./staging-rights-inventory/fixtures.mjs", import.meta.url).href;
  const code = `
    import { registerHooks } from 'node:module';
    import fs from 'node:fs';
    import net from 'node:net';
    import tls from 'node:tls';
    import http from 'node:http';
    import https from 'node:https';
    import dgram from 'node:dgram';
    const fail = () => { throw new Error('${sentinel}'); };
    fs.writeFileSync = fs.appendFileSync = fs.writeFile = fs.appendFile = fs.createWriteStream = fail;
    fs.promises.writeFile = fs.promises.appendFile = fs.promises.open = fail;
    net.connect = net.createConnection = net.Socket.prototype.connect = fail;
    tls.connect = http.request = http.get = https.request = https.get = fail;
    dgram.createSocket = globalThis.fetch = globalThis.WebSocket = fail;
    console.log = console.warn = console.error = process.emitWarning = fail;
    registerHooks({resolve(specifier, context, next) {
      if (!specifier.startsWith('file:') && !specifier.startsWith('./')) fail();
      return next(specifier, context);
    }});
    const { fixture } = await import('${fixtures}');
    const { syntheticClient, syntheticTransport, runSyntheticInventory } = await import('${synthetic}');
    for (const failAt of [undefined, 'identity', 'ROLLBACK', 'CLOSE', 'DELIVER']) {
      const data = fixture();
      data.identity.rows[0].current_user_name = '${sentinel}';
      const status = await runSyntheticInventory({client: syntheticClient(data, {failAt, error: '${sentinel}', notice: '${sentinel}'}), transport: syntheticTransport()});
      if (!['inventory complete','inventory stopped'].includes(status)) fail();
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { PATH: process.env.PATH, GITHUB_STEP_SUMMARY: sentinel, GITHUB_OUTPUT: sentinel },
    encoding: "utf8",
    cwd: root,
  });
  assert.equal(result.status, 0, "synthetic execution must not attempt any guarded sink");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("prospective scaffold is uninstalled and cannot bind a secret or dispatch", () => {
  const path = new URL("./staging-rights-inventory/workflow.yml.disabled", import.meta.url);
  assert.ok(existsSync(path), "uninstalled scaffold must exist");
  const source = readFileSync(path, "utf8");
  assert.match(source, /if:.*false/);
  assert.doesNotMatch(
    source,
    /\$\{\{|workflow_dispatch|pull_request:|push:|schedule:|environment:|upload-artifact|GITHUB_STEP_SUMMARY|GITHUB_OUTPUT/,
  );
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci, /run: node --test ci\/staging-rights-inventory\.test\.mjs/);
});
