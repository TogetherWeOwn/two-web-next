# Neon backup byte-integrity contract

`bin/neon-backup.sh` now verifies **stored archive bytes**, separately from its
manifest publication proof. A SHA-256 receipt is not a PostgreSQL restore test,
row comparison, authenticity signature, or proof of recoverability. It does not
protect against an actor replacing both archive and receipt consistently.

## Receipt and publication

An archive at `KEY.dump` has a sidecar at `KEY.dump.digest.json`:

```json
{"archiveKey":"neon/staging-staging-20261001T000000Z.dump","sha256":"<64 lowercase hex characters>","sizeBytes":12345,"version":1}
```

`bin/backup/integrity-helper` streams binary bytes through SHA-256 and records
nonzero byte length and exact object-key identity. Verification requires the
version-1 schema, identity, size and digest to match. Malformed/oversized receipts
and empty archives fail. Python 3 and the existing Wrangler CLI are sufficient;
no extra packages or credentials are needed.

For `backup`, the script:

1. Creates the receipt from the local, nonempty dump.
2. PUTs the archive, GETs **all archive bytes**, and verifies those bytes against
   the original local receipt. A successful HTTP/CLI GET alone is not success.
3. PUTs the receipt and GETs it back, requiring an exact match to the local
   receipt. It never derives the expected digest from downloaded bytes.
4. Publishes both object keys in the existing line-oriented `MANIFEST.txt`, then
   checks that both are present in the re-downloaded manifest. Only then does it
   print `backup: KEY` and exit zero.

Receipt keys are additional manifest lines, not additional daily/weekly backups.
Current archive names, branch prefixes, EU jurisdiction, upload flags and
newest-7-daily/newest-4-weekly defaults are unchanged. Failed verification does
not publish the new pair; an uploaded object may remain outside the manifest.
No automatic orphan cleanup or store backfill is introduced. Existing manifest
fetch/create and concurrent-writer semantics are unchanged; this is not a
transactional manifest redesign.

## Check outcomes and legacy compatibility

```sh
./bin/neon-backup.sh check staging
./bin/neon-backup.sh check staging --require-verified
```

Both commands download full archives; budget local disk space and read traffic
accordingly. Every Wrangler call continues to use the configured jurisdiction.

| Output | Meaning | Default exit | `--require-verified` exit |
| --- | --- | --- | --- |
| `verified: KEY` | Nonempty bytes match receipt identity, size and SHA-256 | 0 if all checks pass | 0 if all checks pass |
| `corrupt: KEY` | Receipt invalid or stored bytes differ | nonzero | nonzero |
| `missing: KEY` | Archive GET failed (missing or transport/access failure) | nonzero | nonzero |
| `unverified: KEY (receipt unavailable)` | Receipt GET failed; **not byte-verified** | 0 only for legacy keys with no receipt line in the manifest | nonzero |

A receipt already listed in the manifest cannot silently downgrade to legacy
success: its GET failure makes **both** modes fail. An orphan receipt line without
its archive line also fails. Receipt GET failures are described as unavailable,
not definitively absent, because Wrangler's exit status alone does not distinguish
absence from a transport/access failure. In compatibility mode the final summary
explicitly counts legacy-unverified archives instead of claiming all are verified.
Use `--require-verified` when every listed archive must have byte-integrity proof.
No command in this change manufactures receipts for old stores.

## Promotion and retention

`promote-weekly` requires the source daily's receipt and verifies the downloaded
source **before** generating the weekly receipt. Missing/unavailable or invalid
source receipts fail; legacy archives are not blessed by hashing whatever bytes
happen to be retrieved. The weekly receipt names the weekly key, and the archive
and receipt pass the same read-back gate as a new backup before both keys are
added to the manifest.

`rotate` still selects archives using the existing daily/weekly ordering and
limits. For each expired archive it deletes the archive and its manifest-listed
receipt; retained archives keep their receipt lines. Legacy entries without
receipt lines retain their previous lifecycle. `--dry-run` still prints one
delete line per archive and mutates neither object. Unlisted objects are out of
scope, as before.

R2 does not provide an atomic archive/receipt/manifest transaction here. A paired
delete failure exits nonzero and leaves the old manifest unchanged; one object
may already have been deleted. Do not treat that partial rotation as success.
This preserves the existing failure model instead of silently discarding the
failed pair's manifest evidence or redesigning retention.

## Local-only verification

```sh
bash ci/backup-integrity-selftest
bash ci/neon-backup-selftest.sh
bash -n bin/neon-backup.sh ci/backup-integrity-selftest
```

The dedicated integrity suite uses a binary synthetic file larger than one hash
chunk, fake `pg_dump`, a fixed clock, and fake R2 on local disk. It tests successful
PUTs whose GETs return truncated or same-length altered bytes, malformed/missing
receipts, strict legacy behavior, source/destination promotion verification,
receipt transport failures, exact pairing and retention failures. The original
backup selftest remains unchanged. No CI workflow or whole-runbook changes, real
remote operations, database tests, deployments or restore claims are part of
this slice.

API references:
- [Python SHA-256 streaming update](https://docs.python.org/3/library/hashlib.html#hashlib.hash.update)
- [Wrangler R2 object get/put/delete flags](https://developers.cloudflare.com/workers/wrangler/commands/r2/)
