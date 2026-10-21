// Test-only, memory-only protocol seam. Never imported by normal inventory entry.
// Brands are private: no injected driver, function, URL, file or real transport.
import { POLICY_TABLES, READS, TRANSACTION } from "./reads.mjs";

const clients = new WeakMap();
const transports = new WeakMap();
const stop = () => {
  throw new Error("inventory stopped");
};
const clone = (value) => structuredClone(value);

export function syntheticClient(fixture, faults = {}) {
  const token = Object.freeze({
    get events() {
      return [...clients.get(token).events];
    },
  });
  clients.set(token, { fixture: clone(fixture), faults: clone(faults), events: [] });
  return token;
}

export function syntheticTransport(faults = {}) {
  const token = Object.freeze({
    get payloads() {
      return clone(transports.get(token).payloads);
    },
  });
  transports.set(token, { faults: clone(faults), payloads: [] });
  return token;
}

function command(client, id) {
  client.events.push(id);
  if (client.faults.failAt === id) throw new Error(client.faults.error ?? "synthetic failure");
  // Notices are deliberately discarded, including their message/stack contents.
}

function valid(value, type) {
  if (type.startsWith("nullable-")) return value === null || valid(value, type.slice(9));
  if (type === "boolean") return typeof value === "boolean";
  if (type === "text") return typeof value === "string" && value.length > 0;
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isSafeInteger(value);
  if (type === "oid") return Number.isSafeInteger(value) && value > 0 && value <= 4294967295;
  if (type === "public-oid") return value === 0 || valid(value, "oid");
  if (type === "oid-array")
    return Array.isArray(value) && value.every((v) => valid(v, "public-oid"));
  return false;
}

function rowsFor(client, read) {
  command(client, read.id);
  const result = client.fixture[read.id];
  if (
    !result ||
    result.complete !== true ||
    !Array.isArray(result.rows) ||
    JSON.stringify(result.fields) !== JSON.stringify(read.fields) ||
    Object.keys(result).sort().join() !== "complete,fields,rows"
  )
    stop();
  for (const row of result.rows) {
    if (
      !row ||
      Object.keys(row).sort().join() !== [...read.fields].sort().join() ||
      read.fields.some((field) => !valid(row[field], read.types[field]))
    )
      stop();
  }
  return result.rows;
}

function closure(edges, root, reverse) {
  const found = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      const from = reverse ? edge.role_oid : edge.member_oid;
      const to = reverse ? edge.member_oid : edge.role_oid;
      if (found.has(from) && !found.has(to)) {
        found.add(to);
        changed = true;
      }
    }
  }
  return [...found].sort((a, b) => a - b);
}

function validateImage(reads) {
  const roles = new Map(reads.roles.map((r) => [r.role_oid, r]));
  if (roles.size !== reads.roles.length) stop();
  for (const name of ["two_web_app", "pg_read_all_data", "pg_write_all_data"]) {
    if (reads.roles.filter((r) => r.role_name === name).length !== 1) stop();
  }
  for (const edge of reads.memberships) {
    if (![edge.role_oid, edge.member_oid, edge.grantor_oid].every((oid) => roles.has(oid))) stop();
  }
  if (reads.schemas.length !== 2 || new Set(reads.schemas.map((r) => r.schema_name)).size !== 2)
    stop();
  if (!reads.schemas.every((r) => ["public", "drizzle"].includes(r.schema_name))) stop();
  if (reads.relations.length === 0 || reads.columns.length === 0) stop();
  const relationIds = new Set(reads.relations.map((r) => r.relation_oid));
  if (relationIds.size !== reads.relations.length) stop();
  for (const row of reads.columns) if (!relationIds.has(row.relation_oid)) stop();
  for (const id of ["relation_acls", "column_acls", "schema_acls", "default_acls", "functions"]) {
    for (const row of reads[id]) {
      if (!["null-default", "empty", "explicit"].includes(row.acl_state)) stop();
      const tuple = [row.grantor_oid, row.grantee_oid, row.privilege, row.grantable];
      if (tuple.some((v) => v === null) && !tuple.every((v) => v === null)) stop();
      if (row.acl_state === "empty" && tuple.some((v) => v !== null)) stop();
    }
  }
  for (const name of ["relation_acls", "column_acls", "schema_acls"]) {
    if (reads[name].length === 0) stop();
  }
  if (
    reads.relations.some(
      (r) =>
        !reads.relation_acls.some(
          (a) => a.relation_oid === r.relation_oid && a.owner_oid === r.owner_oid,
        ),
    )
  )
    stop();
  if (
    reads.columns.some(
      (c) =>
        !reads.column_acls.some(
          (a) => a.relation_oid === c.relation_oid && a.column_number === c.column_number,
        ),
    )
  )
    stop();
  if (
    reads.schemas.some(
      (s) =>
        !reads.schema_acls.some(
          (a) => a.schema_oid === s.schema_oid && a.owner_oid === s.owner_oid,
        ),
    )
  )
    stop();
  const roots = reads.roles.filter((r) =>
    ["two_web_app", "pg_read_all_data", "pg_write_all_data"].includes(r.role_name),
  );
  for (const role of reads.roles) {
    for (const root of roots) {
      const checks = reads.member_checks.filter(
        (c) => c.member_oid === role.role_oid && c.role_oid === root.role_oid,
      );
      if (
        checks.length !== 1 ||
        checks[0].is_member !==
          closure(reads.memberships, role.role_oid, false).includes(root.role_oid)
      )
        stop();
    }
  }
  const app = reads.roles.find((r) => r.role_name === "two_web_app").role_oid;
  return {
    forward: closure(reads.memberships, app, false),
    reverse: closure(reads.memberships, app, true),
  };
}

const unknowns = Object.freeze([
  "live-target-host-and-branch-tls-version",
  "live-permissions-and-visibility",
  "live-snapshot-coherence",
  "private-named-principals",
  "exact-policy-and-trigger-expressions",
  "importer-custodian-and-planned-runs",
  "private-sink-readers-expiry-and-transport",
  "immutable-executor-and-grantor-path",
  "deployed-source-sha-and-runtime-parity",
  "phase-specific-effective-rights",
  "quiescence-and-all-ddl-acl-writers",
]);

export async function runSyntheticInventory({ client, transport } = {}) {
  // No user callback is invoked, even when objects have hostile getters/proxies.
  if (!clients.has(client) || !transports.has(transport)) return "inventory stopped";
  const memory = clients.get(client);
  const sink = transports.get(transport);
  let started = false;
  let payload;
  let failed = false;
  try {
    command(memory, TRANSACTION.begin);
    started = true;
    for (const setup of TRANSACTION.setup) command(memory, setup);
    const reads = {};
    for (const read of READS) {
      reads[read.id] = rowsFor(memory, read);
      if (read.id === "identity") {
        const identity = reads.identity;
        if (
          identity.length !== 1 ||
          Math.floor(identity[0].server_version_num / 10000) !== 18 ||
          !identity[0].server_address_present
        )
          stop();
      }
    }
    if (
      Object.keys(memory.fixture).sort().join() !==
      READS.map((r) => r.id)
        .sort()
        .join()
    )
      stop();
    const membership = validateImage(reads);
    const tables = reads.relations.filter(
      (r) => r.schema_name === "public" && ["r", "p"].includes(r.relation_kind),
    );
    const findings = {
      missingProposalTables: POLICY_TABLES.filter(
        (name) => !tables.some((r) => r.relation_name === name),
      ),
      extraPublicTables: tables
        .filter((r) => !POLICY_TABLES.includes(r.relation_name))
        .map((r) => r.relation_name),
      ledgerPresent: reads.relations.some(
        (r) => r.schema_name === "drizzle" && r.relation_name === "__drizzle_migrations",
      ),
    };
    payload = {
      syntheticOnly: true,
      rightsVerdict: "unknown-stop",
      findings,
      reads,
      membership,
      implicitOwnerRights: "separate-from-acl",
      unknowns,
    };
  } catch {
    // Fixed public label only; no driver/notice/error object crosses this seam.
    failed = true;
  } finally {
    if (started) {
      try {
        command(memory, "ROLLBACK");
      } catch {
        failed = true;
      }
    }
    try {
      command(memory, "CLOSE");
    } catch {
      failed = true;
    }
  }
  if (failed) return "inventory stopped";
  try {
    command(memory, "DELIVER");
    if (sink.faults.fail) stop();
    sink.payloads.push(clone(payload));
    return "inventory complete";
  } catch {
    // Never fall back to console, disk, summaries, annotations or artifacts.
    return "inventory stopped";
  }
}
