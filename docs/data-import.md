# Legacy data import and verification

`bin/import/verify.mjs` compares the configured legacy → Next projections; it
**does not import data**. It reads `LEGACY_DATABASE_URL` and `DATABASE_URL` from
the environment only. It never accepts connection strings as arguments, prints
connection strings, or includes compared member fields in either report.

This work ships the verification tool, not real-data cutover proof. All local
verification uses synthetic data in disposable schemas on `agent-testdb`,
database `two_web_next`; hosted CI uses its disposable Postgres service.
**Do not run tests against production, staging, or the real legacy database.**
Actual legacy/Neon verification is a separately authorized operator cutover step.

## Coverage and source of truth

The baseline map is `bin/import/verify-map.mjs`, transcribed from frozen
[`two-web@1b76d9b72adfe408b01c1bb1aee4363ebc516fce` migrations](https://github.com/TogetherWeOwn/two-web/tree/1b76d9b72adfe408b01c1bb1aee4363ebc516fce/database/migrations)
and `src/db/schema.ts` / `src/db/admin-schema.ts`. Every table named in the four
import cards is included:

| Import slice | Legacy → Next table | Comparison key | Compared fields / transforms |
| --- | --- | --- | --- |
| [TOG-10831](/TOG/issues/TOG-10831), users/profiles | `users` → `users` | `discord_id` → `id` | `COALESCE(NULLIF(display_name, ''), username)` → username (matches `users-profiles.mjs`), avatar, created/updated timestamps; member mapping remains a gap |
| users/profiles | `profiles` → `profiles` | legacy user lookup → Discord `user_id` | bio, games JSONB, timezone, created/updated timestamps; profile surrogate ID deliberately not compared |
| [TOG-10832](/TOG/issues/TOG-10832), events/RSVPs | `events` → `events` | `event_key` | title, game, description, UTC start/end instants, timezone, location, capacity, status, Discord mirror ID, creator Discord ID, rsvp_open, recurrence frequency/count/end/index, parent event_key, created/updated timestamps |
| events/RSVPs | `rsvps` → `rsvps` | event_key + user Discord ID | status, synced-to-Discord and created/updated timestamps; numeric event/user IDs resolved through joins |
| [TOG-10833](/TOG/issues/TOG-10833), content/funnel | `featured_contents` → `featured_contents` | legacy `id` → preserved `legacy_id` | title, body, URL, image URL/alt, published flag, position, UTC show window, creator Discord ID, created/updated timestamps (NULL `updated_at` falls back to `created_at`, as the importer writes it) |
| content/funnel | `join_attempts` → `join_attempts` | legacy `id` → preserved `legacy_id` | outcome, source, request_id, discord_id, created_at; fixed retention cutoff |
| content/funnel | `event_search_logs` → `event_search_logs` | legacy `id` → preserved `legacy_id` | normalized_query, result_count, occurred_at; fixed retention cutoff |
| [TOG-10834](/TOG/issues/TOG-10834), audit/grants | `member_data_access_logs` → `member_data_access_logs` | preserved `id` | viewer Discord ID, resolved viewer/subject user IDs, resource, action, subject_count, route, occurred_at; subject array order preserved |
| audit/grants | `activity_log` → `activity_log` | preserved `id` | log_name (NULL → default), description, subject_type/id, causer_id, properties JSONB, created/updated timestamps; unresolved attribution/dirty-map policy flagged |
| audit/grants | `agent_event_grants` → `agent_event_grants` | UUID `id` | agent/company/guild IDs, verifier hash, expires_at, created_at; expects disabled_at NOT NULL, not a copied enablement state |
| audit/grants | `agent_event_audits` → `agent_event_audits` | preserved `id` | grant_id, operation, event_key, idempotency_key, payload_digest, request_id, result, reason_code, created_at |
| audit/grants | `agent_event_idempotency_keys` → same | preserved `id` | grant_id, key, payload_digest, status, body JSONB, event_key, created_at; fixed retention cutoff |

Legacy naive timestamps are interpreted as UTC (`AT TIME ZONE 'UTC'`), matching
legacy's application timezone. Already timezone-aware event instants are not
reinterpreted. Dates convert to midnight naive timestamps for recurrence ends.
JSON converts to JSONB so object member order is irrelevant, but array order and
null versus absent values remain significant. Each compared field carries an
SQL-null discriminator: SQL NULL and the JSON literal `null` are not equal.
Values are serialized in Postgres, not JS: bigint IDs and microsecond timestamps
are not rounded by the driver. Numeric scale is normalized lexically in JSONB's
exact decimal output, including nested objects/arrays; `1.0` and `1` compare equal
without rounding long integers or fractional digits. Quoted numbers and escaped
strings are never normalized. Report key parts are strings, including numeric IDs.

Legacy numeric user references resolve through `users.discord_id`; event references
resolve through `events.event_key`. LEFT JOINs retain orphan records. Missing
legacy references produce an unresolved-ID sentinel in the compared projection
(or key), never disappear through an INNER JOIN. Duplicate or NULL comparison
keys are fatal errors, not successful lossy matching. Surrogate event/RSVP IDs
are not equality keys; if the importer must preserve RSVP ID for tie-breaking,
add it as a compared column to the finalized map.

Never copy remember tokens, credentials or `is_moderator`. The latter is
recomputed by the login flow; it is not an imported field. Grant verifier hashes
are compared internally, never emitted as report values or report keys.
Next-only throttle hits, job locks/queue ledgers, Laravel/Next sessions and other
operational tables are **not** part of these four import slices.

### Explicit unresolved mappings (fail closed)

The current schemas cannot establish full data parity by themselves. The baseline
reports `mappingGaps` and exits **1 even if all compared rows match**, including
for an empty database, until importers finalize these policies:

- `users.member`: there is no legacy member boolean. A non-null
  `discord_joined_at` is not equivalent: successful join/login paths can leave it
  NULL. Do not silently invent membership evidence.
- Event sync failure timestamp/code have no Next destination columns. Legacy
  proof-event grant ID/marker/version live in `events`, while Next's `agent_events`
  is separate and uses local wall-time strings. An importer must define the split,
  preserve the sync fields, and add the resulting verification projection.
- Activity morph identities and Spatie `{attributes,old}` properties versus Next's
  `{field:{before,after}}` shape need an explicit preservation/conversion policy.
  `causer_type`, `event`, `batch_uuid` are absent from Next. NULL log names use
  `default` in the provisional projection, not an approved loss-of-evidence policy.
- Grants omit `max_events`/`updated_at`; agent audits omit `discord_event_id`/
  `updated_at`; idempotency rows omit `updated_at`. Preservation/disposition must
  be recorded by the audit importer. Join-attempt `updated_at` is outside the
  four-column terminal-funnel projection and absent from Next.
- Legacy nullable created/updated timestamps are **not** silently replaced with
  now(). If an importer needs a fallback, make it deterministic in its finalized
  map and document it. Numeric retained IDs must fit Next's serial range.

A custom map must resolve these gaps with reviewed importer behavior and schema
coverage, not merely delete `mappingGaps` to obtain a green report. The verifier
certifies only its configured tables/columns, not omitted fields or domains.

### Retention selection

Use one explicit `--cutoff` UTC instant **shared with the importer**, normally the
import anchor minus 90 days. The baseline selects `timestamp IS NULL OR timestamp
>= cutoff` on both sides for idempotency keys; cutoff-exact and unknown-age rows
survive. A NULL timestamp is not evidence of expiry: missing unknown-age records
must be reported, not silently discarded. Importers must preserve them or define
a reviewed, deterministic disposition in the finalized map (including how Next's
NOT NULL columns are populated).

The content/funnel tables carry that disposition from `content-funnel.mjs`. Both
sides are keyed on the preserved source id (`legacy.id::text` against Next
`legacy_id`), and the Next side selects only `legacy_id IS NOT NULL`, so rows
created natively on Next after cutover are never extras. Join attempts and search
logs select `clock >= cutoff` on both sides; featured content is compared in full.
Legacy rows with a NULL clock (`created_at`) are skipped by the importer and
counted as `skipped_missing_timestamp`, never revived with a fabricated time, so
they are outside the verified set: reconcile that count from the importer report.
Reported counts are the **selected rows after filters**, not whole-table totals.
No historical query text is renormalized.

Featured content has no age-prune rule and is compared in full. Access logs are
also compared in full in this baseline because the audit import card requests
insert-only preservation. The scheduled worker normally prunes access logs at
90 days; the importer and operator must explicitly decide whether to use the same
selection filter on both sides before cutover. Activity logs, grants and agent
audits are not age-filtered. Freeze retention jobs as well as writers during
verification; otherwise the two independent snapshots can legitimately differ.

## Configuration and invocation

Environment: `LEGACY_DATABASE_URL`, `DATABASE_URL`. Explicit DSN user, host,
database, port (or 5432) and password are pinned; an empty password does not fall
back to inherited libpq credentials. Driver notices/errors are suppressed and
replaced by stable error codes so SQL values and secrets cannot leak.

The pinned `postgres.js` driver supports SCRAM-SHA-256 but **not channel-bound
SCRAM-SHA-256-PLUS**. A DSN requiring `channel_binding=require` (as some Neon
connection strings do) fails closed with exit 2 and
`unsupported_channel_binding_required` before connecting. Do not remove a
required binding to get a passing report; that policy requires a compatible
driver in a separately reviewed change. `channel_binding=prefer` and `disable`
are optional libpq client settings, not Postgres startup GUCs: the verifier
consumes them rather than forwarding them to the server. Invalid settings fail
with `invalid_channel_binding`. The verifier preserves all other URL options,
including `sslmode`; it does not fall back after a connection/security failure.
Use only a provisioned, policy-approved driver-compatible URL. For verified TLS,
`sslmode=verify-full` is supported; `sslmode=require` in this driver encrypts but
does not validate the server certificate. No real Neon connection was tested here.

```sh
# Both env URLs must already be provisioned for the authorized environment.
node bin/import/verify.mjs \
  --legacy-schema legacy_fixture --next-schema next_fixture \
  --cutoff 2026-07-02T00:00:00Z \
  --batch-size 1000 --detail-limit 100 \
  --json verification.json --markdown verification.md
```

With no `--map`, all twelve baseline tables are required; missing tables/columns
fail with exit 2. A trusted JSON map can specify joins, SQL transforms, keys and
selection filters:

```json
[
  {
    "name": "profiles",
    "legacy": {
      "from": "legacy_fixture.profiles l LEFT JOIN legacy_fixture.users u ON u.id=l.user_id"
    },
    "next": { "from": "next_fixture.profiles n" },
    "keys": [{ "name": "discord_id", "legacy": "u.discord_id", "next": "n.user_id" }],
    "columns": [
      { "name": "bio", "legacy": "l.bio", "next": "n.bio" },
      { "name": "games", "legacy": "l.games::jsonb", "next": "n.games" }
    ]
  }
]
```

```sh
node bin/import/verify.mjs --map reviewed-map.json \
  --json verification.json --markdown verification.md
```

Maps are **trusted SQL configuration**: version/review them with the importer,
never generate their SQL from member input. Use only stable opaque IDs as keys,
never names, bio, queries, email or grant secrets. Joins must be one-to-one. Both
connections run `REPEATABLE READ READ ONLY` transactions, UTC, with a 60-second
statement timeout. This tool has no UPDATE/DELETE/DDL path and cannot mutate
persistent data through a custom SQL projection. This does not sandbox arbitrary
SQL's external side effects; use least-privilege read-only DB roles.

Postgres cursors stream sorted projections in batches, compared by UTF-8 byte
order matching `COLLATE "C"`. SHA-256 is computed internally over canonical
Postgres JSONB-array text with SQL-null discriminators and normalized numeric
scale. Row counts and complete missing/extra/mismatch totals
are accumulated across the whole selection. Each diff type emits at most
`--detail-limit` keys per table; `detailsTruncated` signals omitted samples.
Memory is bounded by two batches plus the bounded key samples (the DB may sort
on disk). Neither compared values nor hashes are emitted. Output files are
created with mode 0600; treat identity-only reports as sensitive nevertheless.
JSON prints to stdout; markdown also prints unless `--markdown` writes it to a
file. Do not feed mixed stdout directly to a JSON parser; use `--json` or also
supply `--markdown`.

Exit codes: **0** complete match for the configured projection, **1** data diff
or incomplete mapping, **2** configuration/connection/query/output error. On
error, no successful report is printed. A prior report file can remain from a
previous invocation: always check the current exit status, not just file presence.

Two database snapshots are not atomic across servers. Freeze writes/prunes and
record the importer SHA, verifier SHA, map, fixed cutoff and both database backup
references with operator cutover evidence. This task does not grant that access.

## Tests

```sh
# Focused two-schema CLI/database fixture; guard runs before driver construction.
DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next \
  npm test -- test/import-verify.test.ts

# Full repo check without an inherited DB URL (live suites skip explicitly).
env -u DATABASE_URL npm run check
```

The focused fixture owns randomly named legacy/Next schemas, loads synthetic
legacy DDL and canonical Next migrations, uses raw driver pools separate from
Drizzle serializers, and removes only its own schemas/scratch files. It tests
exit 0, missing/extra/changed rows exit 1, simultaneous diffs at equal row counts,
batch boundaries, sample truncation, opaque bigint/composite/unicode keys,
microseconds, SQL NULL versus JSON null, nested numeric-scale canonicalization,
unknown-age retention rows, required/optional channel-binding DSNs, duplicate/NULL
keys, read-only enforcement, redacted errors, display-name precedence with NULL/empty
fallbacks (without resolving the membership gap), and baseline-map query compatibility.
CI runs this same test on
its service container; no real member records are present.
