# Inert rights-inventory preparation

**Not a live collector. No activation or dispatch is authorized by this code.**

`node ci/staging-rights-inventory.mjs` always exits 1 and prints only
`inventory stopped`. Arguments cannot change that. Import is silent and has no
imports, environment lookup, credential selection, driver construction or network
work. No inventory trigger is installed. The existing catalog-preflight collector
is unchanged and is not a substitute for this preparation.

## Offline proof

Use Node 24:

```sh
node --test ci/staging-rights-inventory.test.mjs
```

The existing `check` CI job explicitly runs this command; a failure blocks its
`ci-ok` aggregate. The command uses only synthetic memory fixtures and child Node
processes. It does not open sockets, including loopback, or use a database.
Do not supply an Environment secret. No new dependency is needed.

`ci/staging-rights-inventory/synthetic.mjs` is a **test-only** protocol model.
The normal entry does not import it. Its injected client and destination must
have private in-memory brands created by that module; arbitrary clients,
callbacks, URLs and transports are refused without inspection. No brand can
bind a real driver or destination. The default transport is unbound and denies
before any client work. Its successful label means synthetic collection finished,
not that any rights precheck passed: every payload has `rightsVerdict: unknown-stop`.
Raw synthetic payloads are available only through the memory destination getter.

The model checks the ordered transaction transcript, identity first among SELECTs,
PG18 version, exact field shapes, explicit completion receipts, required role
presence, ACL distinctions, multihop/reverse membership, cycles, MEMBER checks,
missing-object findings, and rollback/close before delivery. Empty ACL arrays,
NULL default ACLs and implicit owner rights are distinct; an empty optional
catalog family is not a live absence proof. Missing required results, fields,
roles, visibility or inconsistent output stop rather than becoming an empty safe
image. No errors, notices, stacks, rows, names, hashes or counts are logged by the
model. There is no console/file/summary/annotation/artifact fallback.

## Frozen candidate read surface

[`reads.mjs`](../ci/staging-rights-inventory/reads.mjs) is the ordered, immutable
candidate SQL set. `CATALOG_COLUMNS` lists every allowed catalog column;
`BUILTINS` lists the exact permitted side-effect-free builtins. These strings
are never sent to a database by this preparation. The SQL is assembled only
from source constants, never caller input or catalog results. All real reads,
permissions and PG18 parsing still require independent review and authorized
execution. A synthetic result's `complete` flag is a fixture assertion, not proof
of a server's catalog visibility.

| Read IDs | Prechecks supported, not discharged | Limits |
| --- | --- | --- |
| `identity` | 1, 13, 15 | Current/session identity, database and version; server address **presence only**, never its value. No source-SHA or executor proof. |
| `schemas`, `relations`, `columns`, `partitions`, `sequence_dependencies` | 3, 4, 7, 9, 11–13 | Every relation kind in `public`/`drizzle`, owners, RLS flags, partition edges and serial/identity dependencies. No application/ledger rows or sequence values. Missing/extra proposal tables are findings, never repairs. |
| `relation_acls`, `column_acls`, `schema_acls` | 7, 9, 11, 12 | Full ACL entries with grantor/grantee OIDs, PUBLIC OID 0 and options; NULL/default/empty/explicit state retained. Implicit owner authority is separate, not an invented ACL. |
| `memberships`, `roles`, `member_checks` | 5, 6, 13, 15, 18 | Separate forward/reverse closures from the three public role roots and scoped ACL grantors; options and edge grantors retained. Role flags also cover scoped ACL participants/owners. Private named-principal selection remains unresolved. MEMBER is the only non-invoking privilege-check builtin currently included. |
| `default_acls` | 11, 16 | All rows, including global and other-schema defaults; no target-schema filter. No default-ACL mechanism/deployed-SHA proof. |
| `policies` | 13 | Exact frozen 22 proposal table names, plus the separate ledger. The declared schema now also has `web_session_grace`, which postdates the frozen scope and stays out of the candidate read; the census surfaces it as an extra-table finding. The suite pins both the exact names and that single known delta. Policy identity/command/roles/permissiveness and expression-presence booleans only. No raw expression. |
| `functions`, `triggers` | 14 | Public/drizzle function identity argument **types** (no argument names/defaults/source), owners/ACL/security-definer and trigger identity/function/internal/enabled metadata. No definition, expression or argument bytes, and no application function invocation. |

There is no broad catalog browser, wildcard SELECT, dynamic SQL, credentials
fallback, `pg_authid`, password column, session/query text, application/ledger
SELECT, sequence-state read, `nextval`, `setval`, DDL/DML, role switch or provider
call. Catalog expressions are reduced to presence booleans. SQL builtins are
schema-qualified and the proposed session search path is `pg_catalog`.

Exact policy/trigger definitions are intentionally unavailable: prechecks needing
those expressions remain unresolved. Future non-invoking function/table/column/
sequence/schema privilege checks would require a separately reviewed fixed
builtin/query-set addition; they must not be replaced by invoking functions or
probing application objects. Role flags cannot identify an importer connection
or establish whether an import is planned. Snapshot coherence is not quiescence.

## Private evidence-transport contract — deliberately unbound

No approved destination, transport, named-reader list or enforced expiry has been
verified. No live transport implementation is included. A task attachment, public
Actions artifact, repository file, log, cache, PR, summary or annotation is **not**
a private sink. Do not infer confidentiality from an obscure URL or an upload
flag. A real transport may not be introduced or provisioned by this slice.

Before separately authorized activation, independent reviewers need:

- An already-authorized private destination's immutable identifier and owning
  custodian, verified named readers and access-control evidence.
- Server-enforced expiry no longer than 30 days, including failure/retry copies;
  evidence of the retention policy, not an uploader's promise.
- The exact authorized transport/version and credential **reference**, never a
  copied, exported, broadened or newly minted credential.
- An acknowledged complete delivery receipt bound privately to the approved
  execution and destination. Failed/unknown acknowledgement is STOP; no retry
  into another destination and no public fallback or derived catalog hashes/counts.
- Private handling of all identities, role names, ACL topology, query results and
  validation details. Only `inventory complete` or `inventory stopped` may cross
  a public script-output boundary. Never render raw driver errors or notices.

This contract is a prerequisite, not an assertion that any mechanism exists.
Source manifests below hash Git blobs only, never catalog data.

## Prospective execution contract — not implemented

A later approved live adapter must independently demonstrate all of the following:

1. Existing `PLANETSCALE_STAGING_DATABASE_URL` Environment secret in place only;
   no fallback. Compare **both** staging host and username branch suffix against
   the pins in [`ci/db-migrate.mjs`](../ci/db-migrate.mjs), with explicit production
   host/branch rejection before construction. Do not import that module into the
   inert entry: its dependency graph is not inert. No caller-selected endpoint.
2. Verified TLS chain and hostname, one connection, connection timeout at most
   10 seconds, and an independently verified target identity receipt.
3. One REPEATABLE READ READ ONLY transaction. Identity/version SELECT is its
   first SELECT, with major 18 required before any other catalog SELECT.
   Fixed setup only; statement timeout ≤30 seconds, lock timeout ≤10 seconds,
   idle-in-transaction timeout ≤30 seconds, and total wall clock ≤10 minutes.
   Suppress notices without logging them; no SET ROLE or user-defined calls.
4. Exact frozen SQL and fields, complete results/visibility, bounded runtime,
   rollback and close on error. Any query/schema/visibility/timeout/field failure
   is unknown/STOP. Validate the actual driver's TLS, parser, timeout, cleanup and
   error/notice behavior; memory fixtures prove none of those properties.
5. Approved private transport before credential lookup/client construction;
   refusal without transport, and fixed public labels on every failure path.

`TRANSACTION` records candidate bounds/transcript for the synthetic model, **not**
a real driver configuration or working wall-clock watchdog. Importer, immutable
executor/grantor path, deployed source inventory/SHA, phase-specific effective
rights, runtime parity, all-writer quiescence, production and existing review-date
STOPs remain independent. Review date: **2026-11-19**. Expiry authorizes no cleanup.

## Source manifest and activation checklist

After committing, generate evidence from canonical Git object bytes:

```sh
node ci/staging-rights-inventory/manifest.mjs > source-manifest.json
```

Keep this generated manifest out of the public repository. It records HEAD and
root tree, a sorted full tree manifest (path/mode/type/blob), its SHA-256, and
SHA-256/byte length/executable mode for each protected blob. It uses `git cat-file
blob`, not checkout bytes, so filters and line endings cannot silently change the
approved source. Symlinks or missing protected files refuse. Protected paths cover
the entry, ordered reads, every local import, fixtures/selftests, disabled workflow,
CI wiring, source pin owner and its local imports, manifest tool, contract,
package manifest and lockfile. There is no installed inventory output path.

Activation remains STOP until a later, independently reviewed admission check:

- Binds approval to the reviewed **merged** main SHA, exact manifest and modes.
- Verifies execution/checkout bytes and resolved imports/dependencies against
  those canonical blobs **before** binding any Environment secret.
- Verifies immutable executor identity and execution-environment/runner drift;
  source hashes alone do not attest the executor or runtime.
- Requires a different approver from the executor who changed the manifest.
- Verifies sink/readers/expiry/transport, target identity, credential-reference
  binding and all outstanding prechecks; no executor approves their own drift.
- Receives separate authorization for exactly the requested execution. Merge,
  synthetic success or this disabled scaffold never authorize a dispatch.

[`workflow.yml.disabled`](../ci/staging-rights-inventory/workflow.yml.disabled)
lives outside `.github/workflows/`, has no event, secret or Environment binding,
and its only job is unconditionally false. Copying or renaming it is not an
admission mechanism. Do not activate it as a follow-up to merge.
