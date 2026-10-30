import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const entry = new URL("./staging-rights-inventory.mjs", import.meta.url);
const entryPath = fileURLToPath(entry);
const sentinel = "SYNTHETIC_PRIVATE_SENTINEL";

// Changing normal entry to import a driver, inspect env, or select a target must fail.
test("inventory normal entry is an unconditional fixed-label refusal", () => {
  assert.ok(existsSync(entry), "inert inventory entry must exist");
  for (const args of [[], ["--selftest"], ["--target=staging"], ["--client=fake"], [sentinel]]) {
    const result = spawnSync(process.execPath, [entryPath, ...args], {
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
    process.argv = ['node', '${entryPath}', '--target=${sentinel}'];
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
// conditional. CTE names skip that scan only at a column-list definition, so
// a CTE sharing a builtin's name cannot hide a call.
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

// PostgreSQL unquoted identifiers start with a letter (including non-ASCII
// letters) or an underscore; later characters add digits and dollar signs.
// Every identifier pattern below is built from these classes so no spelling
// resolves in one scan and vanishes in another. All of them run with the
// unicode flag; ASCII-only \b stays only beside fixed ASCII keywords.
const ID_START = "\\p{L}_";
const ID_CONT = "\\p{L}\\p{N}_$";
const IDENT = `[${ID_START}][${ID_CONT}]*`;

function blankLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

// PostgreSQL permits arbitrary whitespace around the dot in qualified names,
// so every scan below runs on literal-blanked SQL with that whitespace
// collapsed: `p .col` and `pg_catalog .fn (` are the same references as
// their adjacent forms, and the unqualified/bare scans skip dot-adjacent
// tokens only once the dot is adjacent again.
function scanSql(sql) {
  return blankLiterals(sql).replace(/\s*\.\s*/g, ".");
}

// CTE names from the WITH clause. The WITH/comma anchor keeps a planted
// `name AS (` outside a CTE definition from registering a name.
function cteNames(sql) {
  const names = new Set();
  const defs = new RegExp(
    `(?:WITH\\s+RECURSIVE|WITH|,)\\s*(${IDENT})\\s*(?:\\([^)]*\\)\\s*)?AS\\s*\\(`,
    "giu",
  );
  for (const [, name] of sql.matchAll(defs)) names.add(name.toUpperCase());
  return names;
}

// CTE header column lists declare names; they must not register usable bare
// tokens. Blanking the lists (the CTE name and AS ( survive for the
// positional checks) keeps a planted `x (provolatile)` from laundering a
// catalog column that the main query resolves against its FROM tables.
function blankCteColumns(sql) {
  return sql.replace(
    new RegExp(`((?:WITH\\s+RECURSIVE|WITH|,)\\s*${IDENT}\\s*)\\(([^)]*)\\)(\\s*AS\\s*\\()`, "giu"),
    (_, head, list, tail) => `${head}(${" ".repeat(list.length)})${tail}`,
  );
}

// A bare CTE name resolves only at its definition (`name [(cols)] AS (`),
// as a FROM/JOIN target, or as a column qualifier (`name.`). Comma targets
// stay rejected: a SELECT-list comma is indistinguishable from a FROM comma,
// so allowing it would launder any planted name. Any other bare occurrence
// resolves against the FROM tables, so a planted CTE name cannot launder a
// catalog column or a builtin call there. Qualifier position is safe: a
// qualified reference binds to the CTE, never to a catalog table.
function isCteDefinitionName(sql, index, length) {
  return /^\s*(\([^)]*\)\s*)?AS\s*\(/i.test(sql.slice(index + length));
}

function isFromJoinTarget(sql, index) {
  return /(?:\bFROM|\bJOIN)\s+$/i.test(sql.slice(0, index));
}

function isQualifier(sql, index, length) {
  return /^\s*\./.test(sql.slice(index + length));
}

function isPositionalCteName(sql, ctes, match) {
  return (
    ctes.has(match[1].toUpperCase()) &&
    (isCteDefinitionName(sql, match.index, match[0].length) ||
      isFromJoinTarget(sql, match.index) ||
      isQualifier(sql, match.index, match[0].length))
  );
}

// Alias (upper) -> catalog table (lower) for every pg_catalog FROM/JOIN/comma
// target. A call-shaped `pg_catalog.name(` is never a table target; a target
// with no usable alias (keyword or end of clause) registers under its own
// table name, so table-qualified references still resolve against the
// allowlist instead of being skipped.
function catalogTargetPattern() {
  // The lookahead after the table name is load-bearing: without it the call
  // guard below backtracks into a truncated table (`current_database(` would
  // register `current_databas` as a target).
  return new RegExp(
    `(?:FROM|JOIN|,)\\s*pg_catalog\\.(${IDENT})(?![${ID_CONT}])(?!\\s*\\()(?:\\s+AS\\s+(${IDENT})|\\s+(${IDENT}))?`,
    "giud",
  );
}

function catalogAliases(sql) {
  const aliases = new Map();
  for (const [, table, asAlias, alias] of sql.matchAll(catalogTargetPattern())) {
    const name = asAlias ?? alias;
    if (name && !SQL_KEYWORDS.includes(name.toUpperCase()))
      aliases.set(name.toUpperCase(), table.toLowerCase());
    else aliases.set(table.toUpperCase(), table.toLowerCase());
  }
  return aliases;
}

// CTE-name alternation safe to interpolate: $ is the only identifier
// character with regex meaning. The backslash escape ahead of it is
// unreachable through cteNames (IDENT has no backslash; raw backslashes are
// rejected pre-blanking) but keeps the escaping complete so the alternation
// stays literal. The trailing lookahead keeps a CTE name from matching a
// longer identifier's prefix (`c` in `FROM cx`).
function cteTargetPattern(ctes) {
  const names = [...ctes]
    .map((name) => name.replace(/\\/g, "\\\\").replace(/\$/g, "\\$"))
    .join("|");
  return new RegExp(
    `(?:FROM|JOIN|,)\\s*(?:${names})(?![${ID_CONT}])(?:\\s+AS\\s+(${IDENT})|\\s+(${IDENT}))?`,
    "giud",
  );
}

function lateralAliasPattern() {
  return new RegExp(`\\)\\s*(?:AS\\s+)?(${IDENT})\\s+ON(?![${ID_CONT}])`, "giu");
}

// Non-catalog aliases usable as bare tokens: CTE FROM/JOIN/comma targets and
// LATERAL function-output aliases (`) alias ON`). CTE-qualified and
// function-output columns are not catalog columns, so they stay out of the
// per-catalog check while their aliases still resolve as bare tokens.
function extraAliases(sql, cteNames) {
  const aliases = new Set();
  if (cteNames.size > 0) {
    for (const [, asAlias, alias] of sql.matchAll(cteTargetPattern(cteNames))) {
      const name = asAlias ?? alias;
      if (name && !SQL_KEYWORDS.includes(name.toUpperCase())) aliases.add(name.toUpperCase());
    }
  }
  for (const [, alias] of sql.matchAll(lateralAliasPattern()))
    if (!SQL_KEYWORDS.includes(alias.toUpperCase())) aliases.add(alias.toUpperCase());
  return aliases;
}

// Token start indices where an alias is defined: catalog FROM/JOIN/comma
// targets, CTE targets, and parenthesized-output aliases (`) alias`, with or
// without ON). A bare catalog alias is a whole-row reference anywhere else,
// so the definition itself is the only bare occurrence that names no column;
// even a shadowed name (member_checks defines r for both pg_roles and
// relevant) is safe to exempt exactly there.
function aliasDefinitionIndices(sql, ctes) {
  const indices = new Set();
  const record = (match, group) => {
    const name = match[group];
    if (name !== undefined && !SQL_KEYWORDS.includes(name.toUpperCase()))
      indices.add(match.indices[group][0]);
  };
  for (const match of sql.matchAll(catalogTargetPattern()))
    record(match, match[2] !== undefined ? 2 : 3);
  if (ctes.size > 0)
    for (const match of sql.matchAll(cteTargetPattern(ctes)))
      record(match, match[1] !== undefined ? 1 : 2);
  const paren = new RegExp(`\\)\\s*(?:AS\\s+)?(${IDENT})`, "giud");
  for (const match of sql.matchAll(paren)) record(match, 1);
  return indices;
}

// A catalog alias outside qualifier position (`alias.`), schema-qualified
// table position (`pg_catalog.table`) and its definitions is a whole-row
// reference in value position (`p::text`, `(p)`), which selects every column
// without naming one for the per-column gate.
function isQualifierPositionAlias(sql, aliases, defs, match) {
  if (!aliases.has(match[1].toUpperCase())) return false;
  const after = sql[match.index + match[0].length];
  if (after === "." || sql[match.index - 1] === ".") return true;
  return defs.has(match.index);
}

function assertBuiltinCalls(read, builtins) {
  const sql = scanSql(read.sql);
  const ctes = cteNames(sql);
  const fixed = builtins.map((name) => name.toLowerCase());
  const qualified = new RegExp(`(${IDENT})\\.(${IDENT})\\s*\\(`, "gu");
  for (const [, schema, builtin] of sql.matchAll(qualified)) {
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
  const unqualified = new RegExp(`(?<![${ID_CONT}.\"'])(${IDENT})\\s*\\(`, "gu");
  for (const match of sql.matchAll(unqualified)) {
    const name = match[1];
    const upper = name.toUpperCase();
    if (UNQUALIFIED_KEYWORDS.includes(upper)) continue;
    // A CTE name matches `name (` only at a column-list definition; a call
    // sharing the name invokes the builtin, never the CTE.
    if (ctes.has(upper) && /^[^)]*\)\s*AS\s*\(/i.test(sql.slice(match.index + match[0].length)))
      continue;
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

function assertNoExtendedLiterals(read) {
  // Extended string forms must not reach the standard-quote blanker. A quote
  // inside a dollar-quoted literal ($$...$$, $tag$...$tag$) ends the blanked
  // span early and hides following column references, and a backslash inside
  // an E-string escapes the blanker's closing quote the same way. The fixed
  // surface uses neither form (its SQL is pure ASCII with standard quotes
  // only), so any dollar-quote opener or backslash fails here on the raw SQL
  // before blanking. A backslash-free E-string is lexed identically by the
  // blanker and selects only a constant, so it needs no form of its own.
  assert.doesNotMatch(
    read.sql,
    /\$([\p{L}_][\p{L}\p{N}_]*)?\$/u,
    `${read.id}: dollar-quoted literal outside the fixed surface`,
  );
  assert.doesNotMatch(read.sql, /\\/, `${read.id}: backslash outside the fixed surface`);
}

function assertBareTokens(read) {
  // Every unqualified token must be a fixed keyword, a declared output field,
  // or a table/CTE alias. CTE names resolve only at their definition, as a
  // FROM/JOIN target, or as a qualifier; CTE definition columns declare
  // nothing usable (their lists are blanked above). Qualified references
  // (after .), cast targets (after :) and string contents never reach this
  // check, so an unqualified column reference cannot evade the
  // alias-qualified per-catalog check above.
  const sql = blankCteColumns(scanSql(read.sql)).replace(/::"char"/g, "");
  const ctes = cteNames(sql);
  const allowed = new Set([...SQL_KEYWORDS]);
  for (const field of read.fields ?? []) allowed.add(field.toUpperCase());
  const aliases = catalogAliases(sql);
  for (const alias of aliases.keys()) allowed.add(alias);
  for (const alias of extraAliases(sql, ctes)) allowed.add(alias);
  const defs = aliasDefinitionIndices(sql, ctes);
  const token = new RegExp(`(?<![${ID_CONT}.:\"'])(${IDENT})`, "gu");
  for (const match of sql.matchAll(token)) {
    const name = match[1];
    if (!isQualifierPositionAlias(sql, aliases, defs, match) && aliases.has(name.toUpperCase()))
      assert.fail(`${read.id}: bare catalog alias outside qualifier position: ${name}`);
    if (allowed.has(name.toUpperCase())) continue;
    if (isPositionalCteName(sql, ctes, match)) continue;
    assert.fail(`${read.id}: bare token outside fixed surface: ${name}`);
  }
}

function assertCatalogColumns(read, catalogColumns) {
  const sql = scanSql(read.sql);
  // Star expansions select every column without naming one, including
  // through a CTE (`SELECT p.* ...` then `SELECT x.forbidden FROM x`), so
  // the per-column scan below would see nothing to check.
  assert.doesNotMatch(sql, /\.\*/, `${read.id}: star expansion outside the fixed surface`);
  // Three-part references never occur in the fixed surface; the two-part
  // scan below would consume `schema.table` and skip the column.
  assert.doesNotMatch(
    sql,
    new RegExp(`(?<![${ID_CONT}])${IDENT}\\.${IDENT}\\.${IDENT}`, "u"),
    `${read.id}: three-part reference outside the fixed surface`,
  );
  const aliases = catalogAliases(sql);
  const allowed = Object.fromEntries(
    Object.entries(catalogColumns).map(([table, columns]) => [
      table.toLowerCase(),
      columns.map((column) => column.toLowerCase()),
    ]),
  );
  const qualified = new RegExp(`(?<![${ID_CONT}])(${IDENT})\\.(${IDENT})`, "gu");
  for (const [, alias, column] of sql.matchAll(qualified)) {
    const table = aliases.get(alias.toUpperCase());
    if (table !== undefined)
      assert.ok(
        (allowed[table] ?? []).includes(column.toLowerCase()),
        `${read.id}: ${alias}.${column}`,
      );
  }
}

function assertCatalogTargets(read, catalogColumns) {
  const sql = scanSql(read.sql);
  const targets = new RegExp(
    `\\b(?:FROM|JOIN)\\s+pg_catalog\\.(${IDENT})(?![${ID_CONT}])(?!\\s*\\()|,\\s*pg_catalog\\.(${IDENT})(?![${ID_CONT}])(?!\\s*\\()`,
    "giu",
  );
  for (const [, fromJoin, comma] of sql.matchAll(targets)) {
    const catalog = (fromJoin ?? comma).toLowerCase();
    assert.ok(Object.hasOwn(catalogColumns, catalog), `catalog outside fixed list: ${catalog}`);
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
    assertCatalogTargets(read, CATALOG_COLUMNS);
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
  for (const rel of ["src/db/schema.ts", "src/db/admin-schema.ts", "src/db/overlay-schema.ts"]) {
    const text = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    for (const [, name] of text.matchAll(/pgTable\(\s*"([A-Za-z0-9_]+)"/g)) declared.push(name);
  }
  // These tables postdate the frozen proposal scope: the census must still
  // surface each as an extra-table finding. Do not expand POLICY_TABLES or
  // its fixed SQL to silently authorize them. Any other schema drift in either
  // direction still fails the exact-name pin.
  const postProposalTables = ["web_session_grace", "overlay_configs", "overlay_tokens"];
  assert.deepEqual(
    declared.filter((name) => !POLICY_TABLES.includes(name)),
    postProposalTables,
  );
  const { fixture, syntheticClient, syntheticTransport, runSyntheticInventory } = await modules();
  const image = fixture();
  for (const [index, relation_name] of postProposalTables.entries()) {
    const relation_oid = 200 + index;
    for (const read of ["relations", "columns", "relation_acls", "column_acls"]) {
      const original = image[read].rows.find((row) => row.relation_oid === 100);
      assert.ok(original);
      image[read].rows.push({
        ...original,
        relation_oid,
        ...(read === "relations" ? { relation_name } : {}),
      });
    }
  }
  const transport = syntheticTransport();
  assert.equal(
    await runSyntheticInventory({ client: syntheticClient(image), transport }),
    "inventory complete",
  );
  assert.deepEqual(transport.payloads[0].findings.extraPublicTables, postProposalTables);
  assert.equal(transport.payloads[0].rightsVerdict, "unknown-stop");
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
    assertNoExtendedLiterals(read);
    assertBareTokens(read);
  }
});

// Frozen candidate SQL per read id. Any drift in reads.mjs fails the pin
// test below even when the spelling gates above would still pass it, so no
// new implicit-column, identifier-charset or literal-lexing spelling class
// can recur silently. Reads are frozen by design; changing one means
// updating this pin in the same reviewed change.
const EXPECTED_SQL = {
  identity: `SELECT current_user::text AS current_user_name, session_user::text AS session_user_name,
  pg_catalog.current_database() AS database_name,
  pg_catalog.current_setting('server_version') AS server_version,
  pg_catalog.current_setting('server_version_num')::integer AS server_version_num,
  (pg_catalog.inet_server_addr() IS NOT NULL) AS server_address_present`,
  schemas: `SELECT n.oid AS schema_oid, n.nspname::text AS schema_name, n.nspowner AS owner_oid,
  CASE WHEN n.nspacl IS NULL THEN 'null-default' WHEN pg_catalog.cardinality(n.nspacl) = 0 THEN 'empty' ELSE 'explicit' END AS acl_state
  FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public', 'drizzle') ORDER BY n.oid`,
  relations: `SELECT c.oid AS relation_oid, n.nspname::text AS schema_name, c.relname::text AS relation_name,
  c.relkind::text AS relation_kind, c.relowner AS owner_oid, c.relrowsecurity AS row_security,
  c.relforcerowsecurity AS force_row_security, c.relispartition AS is_partition
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle') ORDER BY n.nspname, c.relname, c.oid`,
  columns: `SELECT a.attrelid AS relation_oid, a.attnum::integer AS column_number,
  a.attname::text AS column_name, a.atttypid AS type_oid, a.atttypmod AS type_modifier,
  a.attidentity::text AS identity_kind, a.attgenerated::text AS generated_kind,
  CASE WHEN a.attacl IS NULL THEN 'null-default' WHEN pg_catalog.cardinality(a.attacl) = 0 THEN 'empty' ELSE 'explicit' END AS acl_state
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attrelid, a.attnum`,
  partitions: `SELECT i.inhrelid AS relation_oid, i.inhparent AS parent_oid,
  i.inhseqno AS sequence_number, i.inhdetachpending AS detach_pending
  FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
  JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace
  WHERE n.nspname IN ('public', 'drizzle') OR pn.nspname IN ('public', 'drizzle') ORDER BY i.inhrelid, i.inhseqno`,
  sequence_dependencies: `SELECT c.oid AS sequence_oid, n.nspname::text AS sequence_schema,
  c.relname::text AS sequence_name, c.relowner AS owner_oid,
  d.refobjid AS referenced_oid, d.refobjsubid AS referenced_column, d.deptype::text AS dependency_kind
  FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class c ON c.oid = d.objid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle') AND c.relkind = 'S'
    AND d.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND d.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
    AND d.objsubid = 0 AND d.deptype IN ('a', 'i') ORDER BY c.oid, d.refobjid, d.refobjsubid`,
  relation_acls: `SELECT c.oid AS relation_oid, c.relowner AS owner_oid, CASE WHEN c.relacl IS NULL THEN 'null-default' WHEN pg_catalog.cardinality(c.relacl) = 0 THEN 'empty' ELSE 'explicit' END AS acl_state,
  x.grantor AS grantor_oid, x.grantee AS grantee_oid, x.privilege_type AS privilege, x.is_grantable AS grantable
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,
    pg_catalog.acldefault(CASE WHEN c.relkind = 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner))) x ON true
  WHERE n.nspname IN ('public', 'drizzle') AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  ORDER BY c.oid, x.grantor, x.grantee, x.privilege_type`,
  column_acls: `SELECT a.attrelid AS relation_oid, a.attnum::integer AS column_number,
  c.relowner AS owner_oid, CASE WHEN a.attacl IS NULL THEN 'null-default' WHEN pg_catalog.cardinality(a.attacl) = 0 THEN 'empty' ELSE 'explicit' END AS acl_state,
  x.grantor AS grantor_oid, x.grantee AS grantee_oid, x.privilege_type AS privilege, x.is_grantable AS grantable
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN LATERAL pg_catalog.aclexplode(a.attacl) x ON true
  WHERE n.nspname IN ('public', 'drizzle') AND a.attnum > 0 AND NOT a.attisdropped
  ORDER BY a.attrelid, a.attnum, x.grantor, x.grantee, x.privilege_type`,
  schema_acls: `SELECT n.oid AS schema_oid, n.nspowner AS owner_oid, CASE WHEN n.nspacl IS NULL THEN 'null-default' WHEN pg_catalog.cardinality(n.nspacl) = 0 THEN 'empty' ELSE 'explicit' END AS acl_state,
  x.grantor AS grantor_oid, x.grantee AS grantee_oid, x.privilege_type AS privilege, x.is_grantable AS grantable
  FROM pg_catalog.pg_namespace n
  LEFT JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) x ON true
  WHERE n.nspname IN ('public', 'drizzle') ORDER BY n.oid, x.grantor, x.grantee, x.privilege_type`,
  memberships: `WITH RECURSIVE objects(owner_oid, acl) AS (
  SELECT c.relowner, c.relacl FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'drizzle')
  UNION ALL SELECT c.relowner, a.attacl FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL SELECT n.nspowner, n.nspacl FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public', 'drizzle')
  UNION ALL SELECT p.proowner, p.proacl FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'drizzle')
  UNION ALL SELECT d.defaclrole, d.defaclacl FROM pg_catalog.pg_default_acl d
), acl_entries AS (
  SELECT x.grantor, x.grantee FROM objects o
  CROSS JOIN LATERAL pg_catalog.aclexplode(o.acl) x
), participants(oid) AS (
  SELECT o.owner_oid FROM objects o
  UNION SELECT x.grantor FROM acl_entries x
  UNION SELECT x.grantee FROM acl_entries x WHERE x.grantee <> 0
), roots(oid) AS (
  SELECT r.oid FROM pg_catalog.pg_roles r
  WHERE r.rolname IN ('two_web_app', 'pg_read_all_data', 'pg_write_all_data')
  UNION SELECT x.grantor FROM acl_entries x
), paths(oid, direction) AS (
  SELECT roots.oid, 'forward'::text FROM roots
  UNION SELECT roots.oid, 'reverse'::text FROM roots
  UNION
  SELECT CASE WHEN w.direction = 'forward' THEN m.roleid ELSE m.member END, w.direction
  FROM paths w JOIN pg_catalog.pg_auth_members m
    ON (w.direction = 'forward' AND m.member = w.oid)
    OR (w.direction = 'reverse' AND m.roleid = w.oid)
), edges AS (
  SELECT m.oid, m.roleid, m.member, m.grantor, m.admin_option, m.inherit_option, m.set_option
  FROM pg_catalog.pg_auth_members m
  WHERE EXISTS (SELECT w.oid FROM paths w
    WHERE (w.direction = 'forward' AND w.oid = m.member)
       OR (w.direction = 'reverse' AND w.oid = m.roleid))
), relevant(oid) AS (
  SELECT paths.oid FROM paths
  UNION SELECT edges.grantor FROM edges
  UNION SELECT participants.oid FROM participants
)
  SELECT e.oid AS membership_oid, e.roleid AS role_oid, e.member AS member_oid,
  e.grantor AS grantor_oid, e.admin_option, e.inherit_option, e.set_option
  FROM edges e ORDER BY e.roleid, e.member, e.grantor`,
  roles: `WITH RECURSIVE objects(owner_oid, acl) AS (
  SELECT c.relowner, c.relacl FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'drizzle')
  UNION ALL SELECT c.relowner, a.attacl FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL SELECT n.nspowner, n.nspacl FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public', 'drizzle')
  UNION ALL SELECT p.proowner, p.proacl FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'drizzle')
  UNION ALL SELECT d.defaclrole, d.defaclacl FROM pg_catalog.pg_default_acl d
), acl_entries AS (
  SELECT x.grantor, x.grantee FROM objects o
  CROSS JOIN LATERAL pg_catalog.aclexplode(o.acl) x
), participants(oid) AS (
  SELECT o.owner_oid FROM objects o
  UNION SELECT x.grantor FROM acl_entries x
  UNION SELECT x.grantee FROM acl_entries x WHERE x.grantee <> 0
), roots(oid) AS (
  SELECT r.oid FROM pg_catalog.pg_roles r
  WHERE r.rolname IN ('two_web_app', 'pg_read_all_data', 'pg_write_all_data')
  UNION SELECT x.grantor FROM acl_entries x
), paths(oid, direction) AS (
  SELECT roots.oid, 'forward'::text FROM roots
  UNION SELECT roots.oid, 'reverse'::text FROM roots
  UNION
  SELECT CASE WHEN w.direction = 'forward' THEN m.roleid ELSE m.member END, w.direction
  FROM paths w JOIN pg_catalog.pg_auth_members m
    ON (w.direction = 'forward' AND m.member = w.oid)
    OR (w.direction = 'reverse' AND m.roleid = w.oid)
), edges AS (
  SELECT m.oid, m.roleid, m.member, m.grantor, m.admin_option, m.inherit_option, m.set_option
  FROM pg_catalog.pg_auth_members m
  WHERE EXISTS (SELECT w.oid FROM paths w
    WHERE (w.direction = 'forward' AND w.oid = m.member)
       OR (w.direction = 'reverse' AND w.oid = m.roleid))
), relevant(oid) AS (
  SELECT paths.oid FROM paths
  UNION SELECT edges.grantor FROM edges
  UNION SELECT participants.oid FROM participants
)
  SELECT r.oid AS role_oid, r.rolname::text AS role_name, r.rolsuper AS superuser,
  r.rolinherit AS inherit, r.rolcreaterole AS create_role, r.rolcreatedb AS create_database,
  r.rolcanlogin AS can_login, r.rolreplication AS replication, r.rolbypassrls AS bypass_rls
  FROM pg_catalog.pg_roles r JOIN relevant v ON v.oid = r.oid ORDER BY r.oid`,
  member_checks: `WITH RECURSIVE objects(owner_oid, acl) AS (
  SELECT c.relowner, c.relacl FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'drizzle')
  UNION ALL SELECT c.relowner, a.attacl FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL SELECT n.nspowner, n.nspacl FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public', 'drizzle')
  UNION ALL SELECT p.proowner, p.proacl FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'drizzle')
  UNION ALL SELECT d.defaclrole, d.defaclacl FROM pg_catalog.pg_default_acl d
), acl_entries AS (
  SELECT x.grantor, x.grantee FROM objects o
  CROSS JOIN LATERAL pg_catalog.aclexplode(o.acl) x
), participants(oid) AS (
  SELECT o.owner_oid FROM objects o
  UNION SELECT x.grantor FROM acl_entries x
  UNION SELECT x.grantee FROM acl_entries x WHERE x.grantee <> 0
), roots(oid) AS (
  SELECT r.oid FROM pg_catalog.pg_roles r
  WHERE r.rolname IN ('two_web_app', 'pg_read_all_data', 'pg_write_all_data')
  UNION SELECT x.grantor FROM acl_entries x
), paths(oid, direction) AS (
  SELECT roots.oid, 'forward'::text FROM roots
  UNION SELECT roots.oid, 'reverse'::text FROM roots
  UNION
  SELECT CASE WHEN w.direction = 'forward' THEN m.roleid ELSE m.member END, w.direction
  FROM paths w JOIN pg_catalog.pg_auth_members m
    ON (w.direction = 'forward' AND m.member = w.oid)
    OR (w.direction = 'reverse' AND m.roleid = w.oid)
), edges AS (
  SELECT m.oid, m.roleid, m.member, m.grantor, m.admin_option, m.inherit_option, m.set_option
  FROM pg_catalog.pg_auth_members m
  WHERE EXISTS (SELECT w.oid FROM paths w
    WHERE (w.direction = 'forward' AND w.oid = m.member)
       OR (w.direction = 'reverse' AND w.oid = m.roleid))
), relevant(oid) AS (
  SELECT paths.oid FROM paths
  UNION SELECT edges.grantor FROM edges
  UNION SELECT participants.oid FROM participants
)
  SELECT r.oid AS member_oid, target.oid AS role_oid,
  pg_catalog.pg_has_role(r.oid, target.oid, 'MEMBER') AS is_member
  FROM relevant r CROSS JOIN pg_catalog.pg_roles target
  WHERE target.rolname IN ('two_web_app', 'pg_read_all_data', 'pg_write_all_data')
  ORDER BY r.oid, target.oid`,
  default_acls: `SELECT d.oid AS default_acl_oid, d.defaclrole AS owner_oid,
  d.defaclnamespace AS schema_oid, d.defaclobjtype::text AS object_kind,
  CASE WHEN d.defaclacl IS NULL THEN 'null-default' WHEN pg_catalog.cardinality(d.defaclacl) = 0 THEN 'empty' ELSE 'explicit' END AS acl_state, x.grantor AS grantor_oid,
  x.grantee AS grantee_oid, x.privilege_type AS privilege, x.is_grantable AS grantable
  FROM pg_catalog.pg_default_acl d LEFT JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) x ON true
  ORDER BY d.oid, x.grantor, x.grantee, x.privilege_type`,
  policies: `SELECT p.oid AS policy_oid, p.polrelid AS relation_oid, p.polname::text AS policy_name,
  p.polcmd::text AS command, p.polroles AS role_oids, p.polpermissive AS permissive,
  (p.polqual IS NOT NULL) AS expression_present, (p.polwithcheck IS NOT NULL) AS check_present
  FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE (n.nspname = 'public' AND c.relname IN ('users', 'profiles', 'discord_event_snapshots', 'job_unique_locks', 'queue_jobs', 'featured_contents', 'rsvps', 'agent_event_idempotency_keys', 'agent_event_audits', 'agent_event_hits', 'member_data_access_logs', 'event_search_logs', 'board_view_logs', 'events', 'event_sync_attempts', 'queue_failed_jobs', 'activity_log', 'agent_event_grants', 'join_attempts', 'web_throttle_hits', 'web_sessions', 'web_oauth_journeys'))
    OR (n.nspname = 'drizzle' AND c.relname = '__drizzle_migrations') ORDER BY p.oid`,
  functions: `SELECT p.oid AS function_oid, n.nspname::text AS schema_name, p.proname::text AS function_name,
  pg_catalog.oidvectortypes(p.proargtypes) AS identity_arguments, p.prokind::text AS function_kind,
  p.proowner AS owner_oid, p.prosecdef AS security_definer, CASE WHEN p.proacl IS NULL THEN 'null-default' WHEN pg_catalog.cardinality(p.proacl) = 0 THEN 'empty' ELSE 'explicit' END AS acl_state,
  x.grantor AS grantor_oid, x.grantee AS grantee_oid, x.privilege_type AS privilege, x.is_grantable AS grantable
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  LEFT JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) x ON true
  WHERE n.nspname IN ('public', 'drizzle') ORDER BY p.oid, x.grantor, x.grantee, x.privilege_type`,
  triggers: `SELECT t.oid AS trigger_oid, t.tgrelid AS relation_oid, t.tgfoid AS function_oid,
  t.tgname::text AS trigger_name, t.tgisinternal AS internal, t.tgenabled::text AS enabled
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'drizzle') ORDER BY t.tgrelid, t.oid`,
};

test("candidate SQL matches the frozen text exactly", async () => {
  const { READS } = await modules();
  assert.deepEqual(
    READS.map((r) => r.id),
    Object.keys(EXPECTED_SQL),
  );
  for (const read of READS) assert.equal(read.sql, EXPECTED_SQL[read.id]);
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
  // Whitespace around the dot is legal SQL, so space-before-dot spellings
  // must resolve exactly like their adjacent forms.
  assert.throws(
    () =>
      assertCatalogColumns(
        mutant("SELECT p .provolatile::text FROM pg_catalog.pg_proc p"),
        CATALOG_COLUMNS,
      ),
    /mutant: p\.provolatile/,
  );
  assert.throws(
    () =>
      assertBuiltinCalls(mutant("SELECT pg_catalog .has_table_privilege(1, 'SELECT')"), BUILTINS),
    /mutant: builtin outside fixed list: has_table_privilege/,
  );
  // Catalog targets with space-before-dot resolve too.
  assert.throws(
    () => assertCatalogTargets(mutant("SELECT 1 FROM pg_catalog .pg_shadow"), CATALOG_COLUMNS),
    /catalog outside fixed list: pg_shadow/,
  );
  assertCatalogTargets(mutant("SELECT 1 FROM pg_catalog.pg_class"), CATALOG_COLUMNS);
  // Three-part references bypass the two-part alias scan, so they fail.
  assert.throws(
    () =>
      assertCatalogColumns(
        mutant("SELECT pg_catalog.pg_proc.provolatile FROM pg_catalog.pg_proc"),
        CATALOG_COLUMNS,
      ),
    /mutant: three-part reference/,
  );
  // A planted CTE definition column cannot launder a bare catalog column:
  // the definition list declares no usable bare tokens.
  assert.throws(
    () =>
      assertBareTokens(
        mutant(
          "WITH RECURSIVE x (provolatile) AS (SELECT 1) SELECT provolatile::text FROM pg_catalog.pg_proc p",
        ),
      ),
    /mutant: bare token outside fixed surface: provolatile/,
  );
  // A planted CTE name cannot launder one either: names resolve only at
  // their definition, as a FROM/JOIN target, or as a column qualifier.
  assert.throws(
    () =>
      assertBareTokens(
        mutant(
          "WITH RECURSIVE provolatile AS (SELECT 1) SELECT provolatile::text FROM pg_catalog.pg_proc p",
        ),
      ),
    /mutant: bare token outside fixed surface: provolatile/,
  );
  // A CTE sharing a builtin's name hides neither the call nor the token.
  const shadowedBuiltin = mutant(
    "WITH RECURSIVE has_table_privilege AS (SELECT 1) SELECT has_table_privilege(c.oid, 'SELECT') FROM pg_catalog.pg_class c",
  );
  assert.throws(
    () => assertBuiltinCalls(shadowedBuiltin, BUILTINS),
    /mutant: unqualified call outside fixed list: has_table_privilege/,
  );
  assert.throws(
    () => assertBareTokens(shadowedBuiltin),
    /mutant: bare token outside fixed surface: has_table_privilege/,
  );
  // Fixed CTE positions still pass: definitions naming declared fields,
  // qualified references, and FROM targets.
  assertBareTokens({
    id: "mutant",
    fields: ["value"],
    sql: "WITH RECURSIVE c(value) AS (SELECT 1) SELECT value FROM c",
  });
  assertBareTokens({
    id: "mutant",
    sql: "WITH RECURSIVE c AS (SELECT 1) SELECT c.value FROM c",
  });
  // A bare catalog alias in value position is a whole-row reference: it
  // selects every column without naming one, so it fails instead of
  // resolving as a bare token.
  assert.throws(
    () =>
      assertBareTokens({
        id: "mutant",
        fields: ["function_kind"],
        sql: "SELECT p::text AS function_kind FROM pg_catalog.pg_proc p",
      }),
    /mutant: bare catalog alias outside qualifier position: p/,
  );
  // Star expansions select every column unnamed, including through a CTE
  // that re-exposes a forbidden column under its own qualifier.
  assert.throws(
    () => assertCatalogColumns(mutant("SELECT p.* FROM pg_catalog.pg_proc p"), CATALOG_COLUMNS),
    /mutant: star expansion outside the fixed surface/,
  );
  assert.throws(
    () =>
      assertCatalogColumns(
        mutant(
          "WITH RECURSIVE x AS (SELECT p.* FROM pg_catalog.pg_proc p) SELECT x.provolatile::text FROM x",
        ),
        CATALOG_COLUMNS,
      ),
    /mutant: star expansion outside the fixed surface/,
  );
  // Dollar-sign and non-ASCII identifier characters resolve like ASCII ones,
  // so forbidden columns under those aliases fail identically.
  assert.throws(
    () =>
      assertCatalogColumns(
        mutant("SELECT p$.provolatile::text FROM pg_catalog.pg_proc p$"),
        CATALOG_COLUMNS,
      ),
    /mutant: p\$\.provolatile/,
  );
  assert.throws(
    () =>
      assertCatalogColumns(
        mutant("SELECT pä.provolatile::text FROM pg_catalog.pg_proc pä"),
        CATALOG_COLUMNS,
      ),
    /mutant: pä\.provolatile/,
  );
  // Allowlisted columns under those aliases still pass: the charset is
  // parsed, not blanket-rejected.
  assertCatalogColumns(mutant("SELECT p$.prokind FROM pg_catalog.pg_proc p$"), CATALOG_COLUMNS);
  assertBareTokens(mutant("SELECT p$.prokind::text FROM pg_catalog.pg_proc p$"));
  // CTE names interpolate into the target pattern literally: a backslash in a
  // name must not form a regex escape (`C\D` matching `Cx`), and $ must not
  // anchor or optionalize the name.
  const escapedNames = cteTargetPattern(new Set(["A$B", "C\\D"]));
  // The pattern carries the global flag, so each probe resets lastIndex.
  const matchesTarget = (sql) => {
    escapedNames.lastIndex = 0;
    return escapedNames.test(sql);
  };
  assert.ok(matchesTarget("FROM a$b"));
  assert.ok(matchesTarget("FROM c\\d"));
  assert.equal(matchesTarget("FROM cx"), false);
  assert.equal(matchesTarget("FROM a"), false);
  // Dollar-quoted literals would desync the standard-quote blanker and hide
  // following column references, so both the bare and tagged forms fail.
  assert.throws(
    () =>
      assertNoExtendedLiterals(
        mutant(
          "SELECT $$'$$ || rolconnlimit::text || 'SELECT' AS role_name FROM pg_catalog.pg_roles r",
        ),
      ),
    /mutant: dollar-quoted literal outside the fixed surface/,
  );
  assert.throws(
    () =>
      assertNoExtendedLiterals(
        mutant("SELECT $body$x$body$ || rolconnlimit::text FROM pg_catalog.pg_roles r"),
      ),
    /mutant: dollar-quoted literal outside the fixed surface/,
  );
  // A backslash escapes the blanker's closing quote inside an E-string, so
  // any backslash fails on the raw SQL before blanking.
  assert.throws(
    () =>
      assertNoExtendedLiterals(
        mutant("SELECT e'\\'' || rolconnlimit::text || 'SELECT' AS c0 FROM pg_catalog.pg_class e"),
      ),
    /mutant: backslash outside the fixed surface/,
  );
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
