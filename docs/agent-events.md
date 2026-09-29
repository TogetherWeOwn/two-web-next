# Agent events ingress (W14)

`POST /api/agent-events`: bearer credential, five ops (`create`, `read`, `update`, `publish`, `cancel`),
one admitted caller, one guild. Wire contract is unchanged from two-web `docs/agent-events.md`.

- Off by default: `AGENT_EVENTS_ENABLED=true` turns it on; otherwise `404 ingress_disabled`, no DB touched.
- Env: `AGENT_EVENTS_CALLER_AGENT_ID` (required, unset = every grant denied), `AGENT_EVENTS_GUILD_ID`,
  `AGENT_EVENTS_PRODUCTION_GUILD_ID`. Store: Hyperdrive binding `AGENT_DB` (not yet in `wrangler.jsonc`: no Neon yet, S1).
- Atomicity is Postgres only: `pg_advisory_xact_lock` per grant (create/read) or per event (mutations), with
  `lock_timeout` -> `503 operation_busy`. Idempotency rows are re-checked under the lock, so concurrent duplicate
  deliveries execute once and all get the original answer (`replayed: true`). Rate budgets are rows in
  `agent_event_hits` (per grant 10 mutating / 30 read per minute, service 60 / 300), also lock-serialised. No KV.
- Not ported yet: the outer per-credential route shield (use a Cloudflare rate-limit rule), Discord write-back and
  the bot `event.read` observation (`read` answers `verification_unavailable`).

## Bot signer (`src/bot/signer.ts`)

`X-TWO-Signature: sha256=` + hex HMAC-SHA256 over `POST\n/internal/actions\n{ts}\n{nonce}\n{sha256_hex(body)}`.
`encodeCanonicalJson` reproduces PHP `json_encode(..., UNESCAPED_SLASHES|UNESCAPED_UNICODE)` bytes (incl. U+2028/9 escaping).
`test/bot-signer.test.ts` carries the two-web openssl and reference-harness vectors unmodified.
