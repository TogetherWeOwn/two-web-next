# Agent events ingress (W14)

`POST /api/agent-events`: bearer credential, five ops (`create`, `read`, `update`, `publish`, `cancel`),
one admitted caller, one staging guild. Wire contract follows two-web `AgentEventService`.

- Off by default: `AGENT_EVENTS_ENABLED=true` turns it on; otherwise `404 ingress_disabled`, no DB touched.
- Env: `AGENT_EVENTS_CALLER_AGENT_ID` (required, unset = every grant denied), `AGENT_EVENTS_GUILD_ID`,
  `AGENT_EVENTS_PRODUCTION_GUILD_ID`. Store selection is **the shared web database**:
  nonempty `DATABASE_URL`, otherwise Hyperdrive `DB`; an optional `AGENT_DB` binding, when present,
  overrides it. No selection is ever a fallback after a connection failure. Grants/audits/replays must be in that same database.
- All five operations use `events`, including nullable unique `agent_grant_id` and `proof_marker`, and
  `agent_version` (default 1). Human rows have no machine owner. A grant still owns at most one proof event;
  known foreign keys are refused. `update` requires the last read's integer `version` and increments it once.
  The version must fit PostgreSQL `integer` (-2147483648 to 2147483647); anything outside that
  range, or not an integer, is refused 422 before any event SQL runs.
  Moderator edits, shifted recurrence children and moderator lifecycle changes also increment the version
  on agent-owned rows, so an older agent update cannot overwrite a human correction. Lifecycle decisions
  share the event-row lock across both writers; a cancelled event cannot be republished by a racing moderator.
- Inputs/reads retain naive `YYYY-MM-DD HH:MM` wall strings and their IANA zone; storage uses UTC instants
  through the human form's DST resolver. Gaps are refused; fresh fold times use the second occurrence.
  On update, an unchanged wall string **and** zone preserve each stored endpoint exactly (including either
  fold occurrence and sub-minute precision); changed walls/zones resolve afresh. Duration is checked on
  those effective UTC instants, so a positive stored interval survives even when its minute-only read
  values look reversed across an autumn fold or equal within one minute. Create still requires strictly
  increasing wall times; updates still refuse a resolved end at or before the start.
  Shared-row edits also enforce the Going capacity floor and promote available FIFO seats under the row lock.
- Atomicity is Postgres only: `pg_advisory_xact_lock` per grant (create/read) or per event (mutations), with
  `lock_timeout` → `503 operation_busy`. Idempotency rows are re-checked under the lock, so concurrent duplicate
  deliveries execute once and all get the original answer (`replayed: true`). A pre-found replay revalidates
  grant liveness after the idempotency wait under a grant lock (no operation lock): a grant disabled, removed
  or expired during the wait is refused `403 grant_disabled`/`grant_expired` instead of replaying. Caller next
  action per outcome (stable reason codes plus `request_id`; answers carry no credential material):
  `grant_disabled`/`grant_expired` hold until the provisioning owner restores or reissues the grant — a
  restored grant answers the same key with the original replay, and a new grant starts every key string
  clean (keys are namespaced per grant, so no fresh key is needed for the same payload);
  `operation_busy` is retryable — retry the same key after a short backoff; `idempotency_conflict` needs a
  new key for the corrected payload. Rate budgets are rows in
  `agent_event_hits` (per grant 10 mutating / 30 read per minute, service 60 / 300), also lock-serialised. No KV.
- The outer per-credential route shield (`AGENT_EVENTS_ROUTE_PER_MINUTE`, default 60/min) counts every hit
  per credential hash (anonymous per IP) before auth and the audit write; refused hits write no hit row.
  Over-budget 429s audit on a ~1% sample (`SHIELD_REFUSAL_AUDIT_RATE`): each sampled row carries the
  refusal's own request_id, bucket class only (credential sha256 vs anonymous marker, never raw identity),
  `denied`/`rate_limited`. Every over-budget verdict increments an in-memory per-class counter. Only final
  429s take a token from the isolate's log bucket (burst 20, one token per 3 s): on success it warns
  `agent-events.shield.refused` (`bucket_class`, `outcome`), otherwise it folds into the bounded
  `agent-events.shield.refused.shed` signal (`dropped` count). Sampled audit timeouts return 503 instead
  and emit neither refusal code. To estimate flood volume, multiply sampled rows by ~100. Refused warns
  plus shed drops are a lower-bound signal over the isolate's lifetime, not an exact per-window total:
  pending drops flush only on a later tokenless refusal, never on idle or a token-bearing refusal, and
  disappear on isolate restart; a delayed shed can include drops from an earlier window. Grantless (missing/unknown
  grant) 401s write zero audit rows by contract (sampled warn only). Contention 503s make one bounded
  `operation_busy` audit attempt in its own short transaction with the admission's lock/statement deadlines
  and no bucket lock. A completed attempt persists one exact audit row; a timed-out attempt rolls back and
  persists no row, and keeps the same retryable 503 with the same request_id. Post-verdict
  stale-hit cleanup stays capped (1000 rows, five-minute cutoff, single-flight) with a 1 ms lock bound
  and a 250 ms statement budget; cancellation rolls back only the cleanup and defers the drain to a
  later pass, never changing the decided verdict.
  Receipt window is the latest 50, chronological. Signer/digest/replay protocol assertions are unchanged.
  Replay bodies are bound as text then cast to JSONB objects, independent of Drizzle's client serializers;
  earlier double-encoded JSONB strings remain readable without rewriting the saved receipt.

Event text follows the human event form exactly: `title`, `description` and `location` are trimmed before the required and length checks (so a whitespace-only `title` or `location` is missing), and control and invisible/bidi characters are refused with a 422 field error via the same shared predicate. Tab, LF and CR in `description`, and genuine emoji ZWJ sequences, stay accepted; `game` stays optional, is trimmed (blank becomes null), and control and invisible/bidi characters are refused with a 422 field error, as in the human form.

## Grant provisioning

Grant provisioning is deliberately manual and owned by the repository maintainers; this repository ships no mint, rotate, or disable tooling. Minting stores only the SHA-256 hex of a fresh random credential in `agent_event_grants` (`src/db/schema.ts`); rotation replaces `verifier_hash` on the existing grant row, so the grant keeps its event, idempotency receipts and one-event quota and the old credential stops working at once (a newly minted successor row is a different grant: it cannot act on the predecessor's event, does not replay its idempotency keys, and may create its own proof event); disabling sets `disabled_at`, which ingress rejects immediately (`src/agent-events/grants.ts`). Request a grant through the private channel in [SECURITY.md](../SECURITY.md). Credential material never appears in the repository, logs, or chat.

## Publication and write-back

Publishing exposes the shared row through `/events`, `/e/:key`, and the sitemap. Cancelled detail pages
retain the existing 410/noindex policy. Drafts are not announced. A successful publish/cancel or update of
an already-published row dispatches **after commit** through `src/admin/writeback.ts`, the same
`EVENT_SYNC_QUEUE` carrier as human events. Each accepted operation sends one message; replay, denial,
rollback, draft creation and draft edits send none. The queue UUID is minted once per message, not per retry.

**Deployment limitation:** that optional W8 carrier remains unbound in checked-in Wrangler and is not
wire-compatible with W13's deployed `SYNC_EVENT_QUEUE`. The latter's bot/event adapters remain stubs.
This slice does not provision a queue, replace the jobs runtime, or prove a live Discord mirror. Missing/
failed carrier logs the due sync; do not bind it to the incompatible consumer or claim delivery from enqueue.
Fixture tests pin dispatch independently of this deployment gate. No live bot/guild calls are used.

## Independent read observation

`local.synced_to_discord` is exactly `discord_event_id !== null`, not proof of current Discord state.
`discord` is independent, through `src/bot/event-read.ts` and the existing signer:

- No local mirror ID → `verification_unavailable`, `never_mirrored`, without a bot request.
- Missing `BOT_ENDPOINT_URL`, `BOT_KEY_ID` or `BOT_SHARED_SECRET`, transport/timeout/malformed reply →
  `verification_unavailable`, `bot_unreachable`.
- Typed bot failure → `verification_unavailable` with its safe reason code (never its message/body).
- Observed event ID differs from local mirror ID → `verification_unavailable`, `mirror_mismatch`.
- Matching ID → `{event_id,name,starts_at,location,status,observed_at}`, sourced solely from the bot reply.

Only the mapped owned `event_key` is sent, as `{action:"event.read",event_key}` with a fresh UUID
`Idempotency-Key` header. One signed HTTPS attempt; redirects are refused, timeout is 2.5 seconds,
no retries or credential substitution. A repeated ingress read key replays its saved observation;
use a fresh key for a fresh observation. ID equality is the legacy predicate, not a field/freshness check.
Source: [legacy service](https://github.com/TogetherWeOwn/two-web/blob/1a9a2355597257c5aca9de5e97287bf7c5e158ab/app/Services/AgentEventService.php).

## Migration / rollout

`1019_shared-agent-events.sql` landed as the highest web migration (after `1018_audit-immutability.sql`; it was renumbered from the reserved 1015 gap so its journal `when` sorted last at the time — later migrations have since landed, and the Drizzle journal is the source of truth for current ordering)
and copies **every** temporary
`agent_events` row into `events`, preserving keys, ownership, markers, versions, status and timestamps,
then drops the temporary table. Audit/replay
rows and their keys are untouched. Wall strings convert using each row's zone, not the session zone;
historical fold/gap values follow PostgreSQL's standard-time interpretation (the old table stored no
instant). Key/marker conflicts abort the transaction rather than silently skipping data. Grant deletion
sets ownership null and preserves the public row/evidence.

The existing calendar trigger initializes migrated rows from their preserved timestamps and advances
`ics_sequence` on later shared-row edits and lifecycle changes; agent replay/read/denial does not advance it.

A test/preview database that already applied this PR's unreleased `1013_shared-agent-events` or
`1014_shared-agent-events` needs separate preservation-first reconciliation (or disposable fixture recreation). The renumbered migration
is not idempotent; do not rerun it over already-added ownership columns or rewrite its ledger blindly.

Deploy with ingress disabled and the old Worker drained; apply migrations transactionally, verify row
counts and converted times, then deploy this revision before re-enabling. Do not roll back to a Worker
that writes the dropped table. Roll back code only with ingress disabled; a schema rollback requires an
explicit preservation-first migration. Legacy agent-owned **import** remains out of scope and refused.
This rollout does not grant new ingress, bot credentials, production access or deployment approval.

## Bot signer (`src/bot/signer.ts`)

`X-TWO-Signature: sha256=` + hex HMAC-SHA256 over `POST\n/internal/actions\n{ts}\n{nonce}\n{sha256_hex(body)}`.
`encodeCanonicalJson` reproduces PHP `json_encode(..., UNESCAPED_SLASHES|UNESCAPED_UNICODE)` bytes (incl. U+2028/9 escaping).
`test/bot-signer.test.ts` carries the two-web openssl and reference-harness vectors unmodified.
