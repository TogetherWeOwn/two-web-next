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

function assertBuiltinCalls(read, builtins) {
  for (const [, builtin] of read.sql.matchAll(/pg_catalog\.(\w+)\s*\(/g)) {
    assert.ok(builtins.includes(builtin), `${read.id}: builtin outside fixed list: ${builtin}`);
  }
  const ctes = new Set(
    [...read.sql.matchAll(/(\w+)\s*\([^)]*\)\s*AS\s*\(/gi)].map((m) => m[1].toUpperCase()),
  );
  for (const [, name] of read.sql.matchAll(/(?<![\w."'])([A-Za-z_]\w*)\s*\(/g)) {
    const upper = name.toUpperCase();
    if (UNQUALIFIED_KEYWORDS.includes(upper) || ctes.has(upper)) continue;
    assert.fail(`${read.id}: unqualified call outside fixed list: ${name}`);
  }
}

function assertCatalogColumns(read, catalogColumns) {
  const aliases = new Map(
    [...read.sql.matchAll(/(?:FROM|JOIN)\s+pg_catalog\.(\w+)(?:\s+AS)?\s+(\w+)/gi)].map((m) => [
      m[2],
      m[1],
    ]),
  );
  for (const [, alias, column] of read.sql.matchAll(/\b(\w+)\.(\w+)\b/g)) {
    if (aliases.has(alias))
      assert.ok(
        catalogColumns[aliases.get(alias)].includes(column),
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
    for (const [, catalog] of read.sql.matchAll(/\b(?:FROM|JOIN)\s+pg_catalog\.(\w+)/gi)) {
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

test("catalog column references stay inside the exact per-catalog allowlist", async () => {
  const { READS, CATALOG_COLUMNS } = await modules();
  for (const read of READS) assertCatalogColumns(read, CATALOG_COLUMNS);
});

test("allowlist checks reject AS aliases and unqualified builtins", async () => {
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
  // Unqualified builtins resolve via the pg_catalog search path, so they fail.
  assert.throws(
    () =>
      assertBuiltinCalls(
        mutant("SELECT has_table_privilege(c.oid, 'SELECT') FROM pg_catalog.pg_class c"),
        BUILTINS,
      ),
    /mutant: unqualified call outside fixed list: has_table_privilege/,
  );
  // Qualified allowlisted calls and keyword forms still pass.
  assertBuiltinCalls(
    mutant(
      "SELECT pg_catalog.pg_has_role(r.oid, 1, 'MEMBER'), current_user::text FROM pg_catalog.pg_roles r",
    ),
    BUILTINS,
  );
});

test("cycles terminate and incomplete ACL or MEMBER rows cannot pass", async () => {
  const { runSyntheticInventory, syntheticClient, syntheticTransport, fixture } = await modules();
  const mutations = [
    (f) => {
      f.relation_acls.rows = [];
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
