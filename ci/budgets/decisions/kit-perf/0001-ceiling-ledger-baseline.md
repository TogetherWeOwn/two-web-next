# Ceiling ledger baseline

No ceiling changes. This file declares, in the machine-readable form read by
`ci/budget-ledger.mjs`, every Kit ceiling as it stood when the shipping
oracle (`ci/check-kit-perf.test.mjs`) and the aggregate pin
(`ci/budget-fragments.test.mjs`) stopped carrying literal tables. Each value
is the one recorded by the dated decision files in this directory and the
frozen `0000-legacy-history-*` archive; the `previous` figures are the
ceilings the two most recent raises replaced (see
`2026-10-27-server-gzip-335872-event-time.md` and
`2026-10-26-client-js-event-detail-257024.md`).

This file sorts before every dated decision, so a later decision that
declares the same key supersedes it. A ceiling change is now one fragment
edit plus one new dated decision with a `Ceiling:` line per changed value;
see `ci/budgets/README.md`.

Ceiling: worker._worker.js.maxRawBytes = 3584
Ceiling: worker._worker.js.maxGzipBytes = 1536
Ceiling: server.js.maxRawBytes = 1203200
Ceiling: server.js.maxGzipBytes = 335872 (previous 335360)
Ceiling: server.js.maxFiles = 126
Ceiling: client.js.maxRawBytes = 257024 (previous 256000)
Ceiling: client.js.maxGzipBytes = 103168
Ceiling: client.js.maxFiles = 55
Ceiling: client.css.maxRawBytes = 3072
Ceiling: client.css.maxGzipBytes = 1024
Ceiling: client.css.maxFiles = 4
Ceiling: startup.maxMs = 60000
