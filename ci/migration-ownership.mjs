// Migrator owner-equivalence guard for the web migration runner.
//
// ALTER/DROP on an existing relation needs the executing role to own it in
// PostgreSQL's sense: be the owner, hold an INHERIT membership in the owning
// role, or be a superuser. A reviewed object owned by any other role (the
// classic split: created by the runtime role before migrations owned the
// schema, so CREATE TABLE IF NOT EXISTS never moved it) makes the apply
// transaction fail mid-flight with a masked driver error. Refuse in plan
// instead, with the object and its owner named, before any DDL runs.
//
// Equivalence is pg_has_role(current_user, owner, 'USAGE'), not literal
// owner equality and not bare MEMBER: USAGE is exactly "the owner's
// privileges are usable without SET ROLE", which is what an ALTER checks.
// A group-owned object therefore passes for a migrator that inherits the
// group, while a non-inherited membership (which could only act after a
// SET ROLE the runner never issues) still refuses.
//
// Scope is the reviewed runtime-rights census (TABLE_RIGHTS/SEQUENCE_RIGHTS
// in ci/migration-runtime-rights.mjs): those are the public objects web
// migrations create and alter, and a migration that adds an object must add
// its reviewed entry there, so the census cannot silently go stale. Objects
// outside the census are not web-migration-managed and are not this guard's
// business. The one addition is the migration ledger: the drizzle schema
// holds only runner-owned ledger infrastructure, and a foreign-owned ledger
// would otherwise surface only as a masked failure reading or inserting
// history (owner rights are implicit, so the ledger ACL guard's relacl read
// cannot see a runtime-owned ledger at all).
import { SEQUENCE_RIGHTS, TABLE_RIGHTS } from "./migration-runtime-rights.mjs";

export const REVIEWED_OBJECTS = Object.freeze(
  [...Object.keys(TABLE_RIGHTS), ...Object.keys(SEQUENCE_RIGHTS)].sort(),
);

// Every public table/sequence (plus the drizzle ledger objects) with its
// owner and whether current_user can act as that owner without SET ROLE.
// Filtering to the reviewed census happens in validateOwnershipRows so the
// predicate stays unit-testable without a database. current_user reflects
// any SET ROLE in force, which is the identity an ALTER would run under.
const OWNER_QUERY = `
  SELECT n.nspname || '.' || c.relname AS object_name,
         pg_get_userbyid(c.relowner) AS owner,
         pg_has_role(current_user, pg_get_userbyid(c.relowner), 'USAGE') AS owner_equivalent
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
   WHERE (n.nspname = 'public' AND c.relkind IN ('r', 'p', 'S'))
      OR (n.nspname = 'drizzle' AND c.relkind IN ('r', 'S'))
   ORDER BY 1
`;

export function validateOwnershipRows(rows, { isSuperuser = false } = {}) {
  // A superuser ALTERs any relation, so ownership never blocks it. Keep the
  // bypass explicit instead of depending on pg_has_role's superuser rules.
  if (isSuperuser) return [];
  const reviewed = new Set(REVIEWED_OBJECTS);
  const errors = [];
  for (const row of rows) {
    // The drizzle schema holds only the runner-owned ledger table and its
    // serial sequence, so every object the query returns from it is in
    // scope regardless of the sequence's exact generated name.
    const inScope = reviewed.has(row.object_name) || row.object_name.startsWith("drizzle.");
    if (inScope && row.owner_equivalent !== true) {
      errors.push(
        `reviewed object not alterable by the migrator: ${row.object_name} (owner ${row.owner})`,
      );
    }
  }
  return errors;
}

// Intentional preflight refusal. The runner surfaces only this class to the
// operator; every other error from the guard queries is a driver failure
// and must stay masked behind safeMigrationError. The message names objects
// and owner roles only — infrastructure identifiers, never credentials.
export class OwnershipRefusal extends Error {}

export async function assertMigratorOwnership(client) {
  const [identity] =
    await client`select coalesce((select rolsuper from pg_roles where rolname = current_user), false) as is_superuser`;
  const rows = await client.unsafe(OWNER_QUERY);
  const errors = validateOwnershipRows(rows, { isSuperuser: identity.is_superuser === true });
  if (errors.length) {
    throw new OwnershipRefusal(
      `Migration ownership guard refused: ${errors.join("; ")}. Repair ownership with the authorized database operator before applying migrations; do not grant role memberships as a shortcut.`,
    );
  }
}
