# Agent events ingress (W14)

`POST /api/agent-events`: bearer credential, five ops (`create`, `read`, `update`, `publish`, `cancel`),
one admitted caller, one staging guild. Wire contract follows two-web `AgentEventService`.

- Off by default: `AGENT_EVENTS_ENABLED=true` turns it on; otherwise `404 ingress_disabled`, no DB touched.
- Env: `AGENT_EVENTS_CALLER_AGENT_ID` (required, unset = every grant denied), `AGENT_EVENTS_GUILD_ID`,
  `AGENT_EVENTS_PRODUCTION_GUILD_ID`. Store selection is **the shared web database**:
  nonempty `DATABASE_URL`, otherwise Hyperdrive `DB`. The old independent `AGENT_DB` binding is retired;
  it is never a fallback after a connection failure. Grants/audits/replays must be in that same database.
- All five operations use `events`, including nullable unique `agent_grant_id` and `proof_marker`, and
  `agent_version` (default 1). Human rows have no machine owner. A grant still owns at most one proof event;
  known foreign keys are refused. `update` requires the last read's integer `version` and increments it once.
- Inputs/reads retain naive `YYYY-MM-DD HH:MM` wall strings and their IANA zone; storage uses UTC instants
  through the human form's DST resolver. Gaps are refused; fresh fold times use the first occurrence.
  Shared-row edits also enforce the Going capacity floor and promote available FIFO seats under the row lock.
- Atomicity is Postgres only: `pg_advisory_xact_lock` per grant (create/read) or per event (mutations), with
  `lock_timeout` → `503 operation_busy`. Idempotency rows are re-checked under the lock, so concurrent duplicate
  deliveries execute once and all get the original answer (`replayed: true`). Rate budgets are rows in
  `agent_event_hits` (per grant 10 mutating / 30 read per minute, service 60 / 300), also lock-serialised. No KV.
- The outer per-credential route shield (`AGENT_EVENTS_ROUTE_PER_MINUTE`, default 60/min) counts every hit
  per credential hash (anonymous per IP) before auth and the audit write; refused hits write nothing.
  Receipt window is the latest 50, chronological. Signer/digest/replay protocol assertions are unchanged.

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

`1012_shared-agent-events.sql` copies **every** temporary `agent_events` row into `events`, preserving
keys, ownership, markers, versions, status and timestamps, then drops the temporary table. Audit/replay
rows and their keys are untouched. Wall strings convert using each row's zone, not the session zone;
historical fold/gap values follow PostgreSQL's standard-time interpretation (the old table stored no
instant). Key/marker conflicts abort the transaction rather than silently skipping data. Grant deletion
sets ownership null and preserves the public row/evidence.

Deploy with ingress disabled and the old Worker drained; apply migrations transactionally, verify row
counts and converted times, then deploy this revision before re-enabling. Do not roll back to a Worker
that writes the dropped table. Roll back code only with ingress disabled; a schema rollback requires an
explicit preservation-first migration. Legacy agent-owned **import** remains out of scope and refused.
This rollout does not grant new ingress, bot credentials, production access or deployment approval.

## Bot signer (`src/bot/signer.ts`)

`X-TWO-Signature: sha256=` + hex HMAC-SHA256 over `POST\n/internal/actions\n{ts}\n{nonce}\n{sha256_hex(body)}`.
`encodeCanonicalJson` reproduces PHP `json_encode(..., UNESCAPED_SLASHES|UNESCAPED_UNICODE)` bytes (incl. U+2028/9 escaping).
`test/bot-signer.test.ts` carries the two-web openssl and reference-harness vectors unmodified.
