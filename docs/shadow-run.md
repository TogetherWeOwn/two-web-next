# W16 shadow run

Owner: [TOG-9698](/TOG/issues/TOG-9698). Contract: [cutover-check.md](cutover-check.md),
[url-freeze.md](url-freeze.md). This is a **read-only comparison**, not a traffic
mirror and not a DNS flip.

`ci/shadow-compare.mjs` sends unauthenticated `GET`s (no redirects followed, no
body, identifying `user-agent`) for the frozen guest paths to the legacy VPS
canonical and to the Next candidate, and records one JSON line per path per cycle.

```sh
# 72 h window, one cycle every 5 min (default), sequential per path
node ci/shadow-compare.mjs --duration-h 72 --out shadow.jsonl
# Report: cycles, hours covered, mismatches per path and field, p50/p95 latency
node ci/shadow-compare.mjs --summarize shadow.jsonl
```

Options: `--legacy` (default `https://togetherweown.com`), `--next` (default
`https://next.togetherweown.com`), `--paths a,b`, `--interval-s` (min 30),
`--timeout-ms`. Targets must be bare HTTPS origins and differ from each other.

## What counts as a discrepancy

Compared exactly: status, content type, `Location` (origin normalised),
`<title>`, first `<h1>`, canonical link (origin normalised). Body size differs
past 25%. A transport error on either side is a mismatch. `Cache-Control` is
informational only. Pages that the legacy app does not serve at all (404 where
Next answers 200) show up as `status` mismatches on purpose: they are the list
the cutover owner must accept or add a redirect for.

The legacy `/up` must carry `X-TWO-Origin: two-web` before `cutover-check
--phase before` can pass; this tool does not replace that gate.
