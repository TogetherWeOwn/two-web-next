# Public API event freshness

`GET /api/public/events` and `GET /api/public/events/:key` serve
published-only JSON behind a 60s isolate-local cache (at most 64 entries).
Every representation is session-free and byte-identical for all viewers, so a
cached entry is safe to serve to any caller. Conditional GET works on both
routes: send `If-None-Match` with the served ETag and an unchanged
representation answers 304 with the same ETag.

## Remaining freshness, not fresh windows

A cache hit carries only the remaining freshness of the original 60s window:
a hit 59s after the write answers `max-age=1`, never a fresh full window,
so downstream freshness can never extend past the original expiry. The 200
and 304 hit paths share this behavior. A fresh miss re-arms the full
`max-age=60` bound, and expiry retires the entry.

## Same-isolate retirement on mutation

A committed moderator or agent create/update/publish/cancel retires the
affected event collection/detail entries in the mutating isolate at once, so
the next fetch re-reads the new title, status and roster. Refusals (401/404/
409/422) and rolled-back writes retire nothing. A read already in flight
when a retire lands still answers its own bytes, but a generation fence
refuses the settle: pre-retirement bytes never refill a retired entry, and a
cancelled event keeps its published-only 404. Pause/reopen and RSVP
land/leave do not retire; their fields stay TTL-bounded like the going
counts. Community (`/api/public/community`) and join (`/api/public/join`)
entries are never retired by event mutations.

Same-isolate retirement is not a global edge purge: every other isolate
converges on TTL expiry, at most 60s after the mutation. There is no live
invalidation endpoint and no privileged data in these payloads.

## Reproduce locally

Run the public API freshness proof against a disposable test database:

```sh
DATABASE_URL=postgres://agent_test@agent-testdb:5432/postgres npx vitest run test/api-public-event-freshness-acceptance.test.ts
```

The suite pins remaining-TTL hits, retire-on-commit versus refusal/rollback,
the generation fence and the preserved bounds with a fake clock and explicit
deferred-reader gates — no sleeps. Related suites:
`test/api-public-events.test.ts`, `test/api-public-community-join.test.ts`,
`test/api-public-openapi.test.ts`.
