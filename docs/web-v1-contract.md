# Homepage bot-read contract: `web_v1`

The bot owns these PostgreSQL views. The web is a read-only consumer: it does
not create the real schema, migrate bot tables, or query member-level data.
`two-bot-next` must publish the same column names and semantics when implementing
the producer. This document freezes the **homepage's consumed columns**, not the
complete schema of every `web_v1` view.

Source: frozen `TogetherWeOwn/two-web` at
[`2eaefb8dc7af6e7e9bf62fd561d09e8babf31ba4`](https://github.com/TogetherWeOwn/two-web/tree/2eaefb8dc7af6e7e9bf62fd561d09e8babf31ba4),
particularly `app/Support/Counts/{CountsReader,LiveCounts,Rank}.php` and
`resources/views/home.blade.php`. The frozen producer's
[`docs/WEBSITE_CONTRACT.md` §2](https://github.com/TogetherWeOwn/two-bot/blob/96777468472f23a02a1e97a43ffab3912fe5df2a/docs/WEBSITE_CONTRACT.md#2-the-views)
specifies ISO-8601 UTC **text** for timestamps. Do not retype a v1 view column
as `timestamptz`; column type changes require a new major schema version.

## `web_v1.live_counts`

A single guild-wide snapshot row, including when the source has no usable
snapshot. There is no guild predicate: the producer must scope the view to the
TWO guild. Never aggregate multiple guilds into this row.

| Column | SQL value contract | Consumer meaning |
| --- | --- | --- |
| `human_member_count` | nullable nonnegative integer / bigint | Human members, not bots; null means unknown, **not zero**. |
| `online_count` | nullable nonnegative integer / bigint | Online population accompanying the snapshot. Null means unknown. Display only when positive and the member count is usable. |
| `counts_updated_at` | nullable `text`, ISO-8601 UTC (e.g. `2026-09-30T12:00:00.000Z`) | Actual collector snapshot time, not the request time or a view refresh that did not collect new data. |

The reader issues:

```sql
SELECT human_member_count, online_count, counts_updated_at
FROM web_v1.live_counts LIMIT 1;
```

The cardinality guarantee comes from the producer; `LIMIT 1` is a consumer bound,
not an ordering rule. Values must fit JavaScript's safe integer range. The driver
may return bigint values as decimal strings; the consumer accepts these without
turning null into zero. Empty result sets degrade just like an unavailable row.

### Freshness and display

- A valid timestamp and non-null member count are required for display.
- Freshness uses **absolute** distance from the current UTC time, matching
  legacy Carbon semantics: age **less than 10 minutes** is fresh; exactly
  10 minutes or more is stale. Far-future timestamps are stale too.
- **Intentional acceptance-driven difference from frozen legacy:** legacy renders
  stale numerals with an `as of HH:MM` stamp. This next-app slice suppresses stale
  numerals entirely, as required by the homepage acceptance criterion. Missing,
  stale, null, and invalid snapshots all leave the pitch and join CTA intact.
- A genuine fresh `0` member count renders `0 members`. Zero/null online counts
  do not render an online fragment.
- Legacy describes a producer-side 24-hour age-out to null. The web does not
  implement that producer rule; it already hides snapshots at 10 minutes.

## `web_v1.rank_counts`

Ranks are a separate read, not invented columns on `live_counts`.

| Column | SQL value contract | Consumer meaning |
| --- | --- | --- |
| `rank_key` | non-null text, stable unique key | Rank identity (`prospect`, `member`, `soldier`, `veteran`, `legend`). |
| `rank_label` | non-null text | Public display label; rendered as escaped text, never HTML. |
| `member_count` | nullable nonnegative integer / bigint | Members whose **highest rank held** is this rank. Do not substitute cumulative `holders_count`; stacked roles would double-count. |
| `rank_order` | non-null integer, ascending ladder order | Used by SQL `ORDER BY`; not selected into the page model. |

```sql
SELECT rank_key, rank_label, member_count
FROM web_v1.rank_counts ORDER BY rank_order;
```

The normal ladder is Prospect → Member → Soldier → Veteran → Legend. Returned
rows render in SQL order; a partial nonempty result is not padded with invented
rungs. Positive counts render as numbers, zero renders **unclaimed**, and null
renders the label only. An empty/missing/unreadable rank view renders all five
fallback labels without numbers or an `unclaimed` claim. There is no rank
snapshot timestamp in the frozen consumer contract; a stale live snapshot does
not hide independently readable ranks.

## Connection, cache, and failure boundary

- Reuse `src/db/connection.ts`: explicit local/dev `DATABASE_URL` wins when set;
  otherwise use the Hyperdrive `DB.connectionString` binding. Choose once,
  **never retry with the other source after an error**.
- Both queries are read-only, with prepared statements and type discovery off
  for Hyperdrive. Each per-read client closes after use.
- Independent `counts.live` and `counts.ranks` caches use the legacy **60-second
  TTL**, scoped to the selected connection string within the Worker isolate.
  They are bounded single-entry caches of **settled values**, not shared edge
  storage. Concurrent cold callers read independently with their own deadlines;
  no request-owned pending promise is reused after an invocation ends. Changing
  database bindings forces a reread.
- Cached snapshots keep their already-evaluated freshness until TTL expiry,
  matching legacy. A warm cache can survive an outage until expiry; there is no
  post-expiry stale fallback.
- Failures return null counts or an empty rank list, never reject. Reads have a
  2-second timeout and bounded client shutdown. A failure emits one sanitized
  warning per view/cache fill, without a connection URL or driver message.
  Unavailable results are cached for 60 seconds to avoid per-visitor error spam
  (legacy caught thrown reads without explicitly caching their failures).
- HTTP HTML remains `private, no-store`; only public aggregate read models are
  cached, never sessions or an authenticated page response. The counts source
  does not change homepage session handling.

## Test fixture, not producer DDL

`test/helpers/web-v1-fixture.ts` creates shape-compatible `web_v1.live_counts`
and `web_v1.rank_counts` tables in a **rollback-only transaction** on one reserved
connection. It refuses non-test URLs before constructing a client. It creates
`web_v1` without `IF NOT EXISTS`, so it never replaces a pre-existing schema.
Disposal rolls back our uncommitted objects rather than dropping caller-owned
views. These fixture tables are not migrations and do not create the actual
bot-owned views in Neon.

Authorized local test URL:

```sh
DATABASE_URL=postgres://agent_test@agent-testdb:5432/two_web_next PGPASSWORD='' \
  npx vitest run test/counts.test.ts test/home-counts.test.ts
```

CI may use its disposable Postgres service (`postgres:ci@localhost:5432/postgres`
only under the GitHub Actions/CI flags). Unit fixtures need no database. Never
run these tests or probes against production or staging databases.
