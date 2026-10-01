# Staging demo calendar

`npm run seed:staging` builds synthetic fixtures for calendar, theme, accessibility,
and staging QA journeys. It defaults to **dry-run**: no database import, connection,
read, or write. `--apply` writes all fixtures in one transaction, rolling back on
failure. It does not run migrations, import members, grant roles, create sessions,
or call Discord. Apply migrations separately before seeding.

## Agent-testdb

Use only the isolated test service for local integration tests:

```sh
APP_URL=http://localhost:8787 \
DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next \
SEED_CONFIRM=staging npm run seed:staging

# Same env, explicitly opting into writes:
APP_URL=http://localhost:8787 \
DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next \
SEED_CONFIRM=staging npm run seed:staging -- --apply
```

`--dry-run` is optional; unknown flags, positional URLs, and mixed modes fail.
`DATABASE_URL` is read **only from env**. The script never loads `.env` or prints
credentials/connection strings. Do not paste a real connection URL into shell
history, a card, or a log; use the authorized environment/secret injection.

## Neon staging (separate operator execution)

This change does **not** execute against Neon. An authorized operator must verify
that the URL belongs to the **staging branch**, not the production branch or
production Hyperdrive binding. The repository does not record Neon endpoint
hostnames, so the script cannot infer branch identity from `neon.tech` or the
shared database name `neondb`.

Before a remote dry-run/apply, provide non-secret, independently verified target
metadata through env:

| Variable | Requirement |
| --- | --- |
| `APP_URL` | Exactly `https://next.togetherweown.com` (optional trailing slash) |
| `SEED_CONFIRM` | Exactly `staging`, for dry-run as well as apply |
| `DATABASE_URL` | Authorized staging connection, env only |
| `SEED_STAGING_DB_HOST` | Exact staging Neon endpoint hostname, including `-pooler` if used |
| `SEED_STAGING_DB_NAME` | Exact staging database name |
| `SEED_PRODUCTION_DB_HOSTS` | Comma-separated verified production endpoint hostnames; include direct **and** pooled endpoints |
| `SEED_PRODUCTION_DB_NAMES` | Optional comma-separated production-only names; do not deny `neondb` if both branches use it |

Then run `npm run seed:staging` and inspect the sanitized planned counts; execute
`npm run seed:staging -- --apply` only after target verification. This is target
configuration, not a bypass: the denylist wins over the allowlist. Never configure
a production endpoint as staging. A hostname allowlist is not an independent
proof of Neon branch identity; operator verification is required.

## Refusal and ownership guards

Both modes refuse missing confirmation, `APP_ENV=production`, production apex
`APP_URL` (including `www`, case variants and trailing-dot hosts), unknown app
hosts, invalid PostgreSQL URLs, denied database hosts, and denied database names.
`prod`/`production` host labels and database names are always denied. Remote
targets must be the exact allowlisted Neon endpoint/name with the staging app URL
and a non-empty production host denylist. Local apps may target only
`agent_test@agent-testdb:5432/two_web_next` with an empty password. Driver URL query
parameters other than `sslmode=require` or `sslmode=verify-full` are refused, so
`host`, `dbname`, `options`, or service parameters cannot redirect a checked URL.
No unknown remote endpoint is accepted by default.

Apply refuses collisions with non-seed event keys, fixture user IDs, or featured
natural keys, and refuses duplicate featured keys. It changes only its own
fixtures. Event IDs/keys and bot-owned Discord columns survive reseeding. Existing
non-seed events, users, RSVPs, audit logs, access logs, and grants are not cleared.
Dates and fixture-owned content/status/RSVP answers reset on each apply; do not
use the demo fixtures for member-owned events. Changing the series in the admin
can add extra occurrences; those aren't automatically deleted by this tool.

## Fixture contract

- Exactly **50** `seed-calendar-01`…`seed-calendar-50` event keys: 30 future
  published (four full and one RSVP-paused), six drafts, five cancelled, nine past
  published; six IANA timezones. Dates are anchored at 18:00 UTC on the apply day,
  with positive/negative day offsets. Subsequent days roll every fixture forward.
- A four-occurrence weekly series: parent `seed-calendar-05`, children 06–08;
  existing numeric IDs and parent links remain stable.
- Three fixture users with `seed-` usernames, null avatars, and no PII. The first
  two retain `src/qa.ts`'s reserved synthetic IDs (`900000000000001396` and
  `900000000000001397`) so QA login sees the same RSVP answers. The third is
  `seed-qa-waitlisted`. Existing `QA Member`/`QA Moderator` names on those exact
  reserved IDs are accepted as synthetic QA fixtures; other usernames fail closed.
  QA sign-in may restore its own `QA Member`/`QA Moderator` display names later.
- **12** fixture RSVPs: two going plus one waitlisted for each of four capacity-2
  events. Natural key `(event_id, user_id)`; existing FIFO creation times remain.
- **Three** published featured cards with `seed-featured-` titles. The schema has
  no featured-key unique index, so the script uses `(created_by, title)` as its
  natural key under a transaction advisory lock; no schema migration is needed.

A same-day rerun leaves counts, event IDs/keys, parent links, and fixture user IDs
unchanged; timestamps such as `updated_at` may change. It does not promise stable
counts for additional rows created manually or by a running recurrence job.

## Verification

```sh
npm run check
# Credential-free unit tests plus DB integration using the configured test service:
npx vitest run test/seed-staging.test.ts
```

The tests verify guards without connecting, the fixture mix and QA ID alignment,
dry-run redaction/no connection, transaction rollback, concurrent applies,
unchanged row counts/IDs on rerun, dates rolling forward, and preservation of
non-seed rows. They use agent-testdb (or CI's dedicated Postgres service) only.
The seeder is not a production migration or a production data-repair tool.
