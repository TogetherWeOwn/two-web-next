# Synthetic backup-to-restore proof

This standalone harness proves that a **real custom-format PostgreSQL archive
transported by `bin/neon-backup.sh`** can be downloaded and restored. It supplements
`ci/neon-backup-selftest.sh`, whose fixed dump payload tests transport/retention,
not recoverability. It does not add a production restore command, exercise nightly
workflows, fetch live archives, or prove a live backup's recoverability.

## Run locally on the authorized test service

Prerequisites: Python 3 (standard library only), Bash, `psql`, `pg_dump` and
`pg_restore` on PATH, with a client major version compatible with the test server
(PostgreSQL 17 currently). No npm install, application migrations, Wrangler
installation or Cloudflare credentials are needed.

```sh
python3 ci/backup-restore-proof/selftest.py
python3 ci/backup-restore-proof/run.py
```

The default and only non-CI target is `agent-testdb:5432`, user `agent_test`, empty
password. The existing `agent_test` database is a **maintenance connection only**
for CREATE, ownership checks and DROP; its tables are never read or changed. The
role must be able to create/drop its own test databases. All fixture queries,
dumps, restores and mutations use newly created, unique databases named
`two_web_backup_proof_<random UUID>_<role>`, created with `TEMPLATE template0`.
There is no existing database, archive, password, URL or transport option.

All inherited variables whose names start with `PG` or contain `DATABASE_URL`
are refused, even if empty, **before any database client invocation**. This
includes `PGHOSTADDR`, service/pass files, options, and staging URLs. Explicitly
remove such variables from the invocation environment; do not replace a failing
credential or use its value. For an agent environment with injected staging URL
bindings, for example:

```sh
env -u TWO_STAGING_DATABASE_URL -u TWO_BOT_STAGING_DATABASE_URL \
  python3 ci/backup-restore-proof/run.py
```

Child processes receive a minimal environment with fixed libpq settings, no
ambient Cloudflare auth or shell-startup hooks, an isolated HOME and disabled
password/service files. Client output is captured and withheld. `LD_LIBRARY_PATH`
is retained solely to support PostgreSQL clients unpacked into run-owned scratch
instead of installed on the host. Temporary files, fake objects and archives are
private to the invocation and removed; Paperclip runs use
`PAPERCLIP_RUN_SCRATCH_DIR` as their scratch parent.

## Optional isolated GitHub Actions service

No shared workflow/package changes are part of this slice. A future dedicated
job may run the same standalone commands in a job container with a service named
`postgres`, configured with **POSTGRES_USER=agent_test**, **POSTGRES_DB=agent_test**
and **POSTGRES_HOST_AUTH_METHOD=trust** (empty password). Use an isolated CI service
only, never a mapped host database or an existing staging/production server.

```sh
# Inside that GitHub Actions job container (CI=true, GITHUB_ACTIONS=true):
python3 ci/backup-restore-proof/run.py --host postgres
```

`postgres` is the only additional allowlisted host and requires both GitHub CI
flags. `localhost`, loopback addresses, arbitrary hosts, non-5432 ports, other
users and caller-selected database arguments are always refused. This cannot
reuse a job configured with user `postgres` and password `ci`; provision a
separate disposable service with the configuration above rather than weakening
the allowlist or substituting credentials.

## Proof and negative controls

1. Seed four fixture tables across two schemas, with 10 synthetic rows: foreign
   keys, identity, Unicode, JSONB, timestamps, decimals, NULLs, duplicate rows and
   an empty table. Assert the entire source inventory and expected table counts.
2. Invoke the **unchanged backup CLI**, using real `pg_dump -Fc`. Its Wrangler
   override is a filesystem-only fake R2 adapter. The adapter accepts only the
   synthetic bucket/prefix, put/get and the expected dump/receipt/manifest key
   shapes; `--remote` exercises the existing CLI contract but never accesses
   remote R2.
3. Download the manifest and then the referenced archive and digest receipt
   through that adapter; verify the downloaded archive against the transported
   receipt with the repository's `bin/backup/integrity-helper`, then restore the
   downloaded bytes with `pg_restore --exit-on-error --no-owner --no-privileges`
   into a second disposable database.
4. Compare all user table names (including empty and non-public-schema tables),
   per-table counts and SHA-256 of deterministically sorted JSONB row contents.
   Order-independent contents retain duplicate multiplicity. Hashes/rows are
   compared in memory, never printed.
5. Prove rejection with independent fresh restore targets: truncate the downloaded
   archive (real pg_restore must return nonzero); remove an empty table; add an
   unexpected empty table; remove a row; change a value **without changing its
   count**. Inventory, count and deterministic-content failures are separate.
6. In `finally`, drop only entries registered after successful creation and
   positive identification. Re-check exact OID, current role ownership and the
   per-run database comment marker before each DROP. Never drop by prefix sweep,
   use `DROP ... FORCE`, terminate another session, or clean up an unrecognized
   database. A failed creation is not registered. Cleanup uncertainty leaves the
   target untouched and fails the run; it is not a reason to broaden credentials
   or run a prefix-wide cleanup. SIGTERM/keyboard interruption attempt the same
   guarded cleanup; SIGKILL/host loss cannot guarantee cleanup.

The focused selftest checks pre-client refusals with executable sentinels,
allowlist, comparison failures, diagnostic withholding, ownership-marker/OID
replacement, failed creation and unowned restore/query guards, without a DB.
The real harness separately exercises PostgreSQL and the complete archive path.

Expected real-harness output is nine concise synthetic result lines ending in:

```text
PASS cleanup: created=7 removed=7
synthetic restore proof: PASS (no live archives or remote R2)
```

Exit 0 means the positive case **and all negative controls and cleanup** passed.
A failure exits nonzero with a stage/reason, not database URLs, archive contents,
fixture row contents or client logs. Preserve the synthetic result lines and the
tested git revision as QA evidence. This is artifact recoverability only, not
legacy-import equality, a broad outage matrix, deployment approval, or live
backup verification.
