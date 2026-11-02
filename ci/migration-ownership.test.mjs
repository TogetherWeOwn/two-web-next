import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { REVIEWED_OBJECTS, validateOwnershipRows } from "./migration-ownership.mjs";
import { SEQUENCE_RIGHTS, TABLE_RIGHTS } from "./migration-runtime-rights.mjs";

test("reviewed census is exactly the runtime-rights tables and sequences", () => {
  assert.deepEqual(
    [...REVIEWED_OBJECTS],
    [...Object.keys(TABLE_RIGHTS), ...Object.keys(SEQUENCE_RIGHTS)].sort(),
  );
  // The four tables and two sequences whose production ownership drift
  // motivated the guard are reviewed objects.
  for (const name of [
    "public.web_sessions",
    "public.web_oauth_journeys",
    "public.web_throttle_hits",
    "public.join_attempts",
    "public.join_attempts_id_seq",
    "public.web_throttle_hits_id_seq",
  ]) {
    assert.ok(REVIEWED_OBJECTS.includes(name), `${name} must be in the reviewed census`);
  }
});

test("owner-equivalent reviewed objects pass, including group-owned ones", () => {
  // owner_equivalent is pg_has_role(..., 'USAGE') evaluated in SQL: true for
  // self-owned objects and for objects owned by a role the migrator
  // inherits, so a group-owned table passes without literal owner equality.
  assert.deepEqual(
    validateOwnershipRows([
      { object_name: "public.web_sessions", owner: "migrator", owner_equivalent: true },
      { object_name: "public.join_attempts", owner: "owner_group", owner_equivalent: true },
    ]),
    [],
  );
  assert.deepEqual(validateOwnershipRows([]), []);
});

test("reviewed objects the migrator cannot act as owner refuse, named with their owner", () => {
  const errors = validateOwnershipRows([
    { object_name: "public.web_sessions", owner: "migrator", owner_equivalent: true },
    { object_name: "public.web_oauth_journeys", owner: "two_web_app", owner_equivalent: false },
    { object_name: "public.join_attempts_id_seq", owner: "two_web_app", owner_equivalent: false },
  ]);
  assert.deepEqual(errors, [
    "reviewed object not alterable by the migrator: public.web_oauth_journeys (owner two_web_app)",
    "reviewed object not alterable by the migrator: public.join_attempts_id_seq (owner two_web_app)",
  ]);
});

test("objects outside the reviewed census are not this guard's business", () => {
  assert.deepEqual(
    validateOwnershipRows([
      { object_name: "public.someone_elses_table", owner: "other_role", owner_equivalent: false },
    ]),
    [],
  );
});

test("a missing or null equivalence verdict fails closed", () => {
  for (const owner_equivalent of [null, undefined]) {
    assert.equal(
      validateOwnershipRows([
        { object_name: "public.web_sessions", owner: "two_web_app", owner_equivalent },
      ]).length,
      1,
    );
  }
});

test("a superuser migrator is never blocked by ownership", () => {
  assert.deepEqual(
    validateOwnershipRows(
      [{ object_name: "public.web_sessions", owner: "two_web_app", owner_equivalent: false }],
      { isSuperuser: true },
    ),
    [],
  );
});

test("the migrate runner wires the ownership guard into plan with refusal surfacing", () => {
  const runner = readFileSync(new URL("./db-migrate.mjs", import.meta.url), "utf8");
  assert.match(runner, /assertMigratorOwnership\(connection\)/);
  assert.match(runner, /error instanceof OwnershipRefusal\) refuse\(error\.message\)/);
});

test("the guard judges USAGE equivalence, never bare membership", () => {
  const guard = readFileSync(new URL("./migration-ownership.mjs", import.meta.url), "utf8");
  assert.match(guard, /pg_has_role\(current_user, pg_get_userbyid\(c\.relowner\), 'USAGE'\)/);
  assert.doesNotMatch(guard, /'MEMBER'/);
});
