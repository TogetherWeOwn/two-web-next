# Kit performance budgets

`ci/check-kit-perf.mjs` enforces the sum of `base.json` and every `<pr>.json` note in this directory against the built Kit output (Worker entry, server JS, client JS and CSS). `startup.maxMs` lives in `base.json` only.

This replaces the single shared `ci/kit-perf-budget.json`, which every Kit PR edited and so conflicted on. The checker fails closed (exit 2) if that file comes back.

## Raising or lowering a ceiling

Add `ci/kit-perf-budgets/<pr number>.json` in your own PR. Do not edit `base.json` or another PR's note.

```json
{
  "note": "Why the ceilings move, with the measured before/after bytes.",
  "server": { "js": { "maxRawBytes": 1024, "maxGzipBytes": 256, "maxFiles": 2 } },
  "client": { "js": { "maxGzipBytes": 256 }, "css": { "maxRawBytes": -512 } }
}
```

- Deltas are signed integers added to the base. A negative delta lowers a ceiling (use it when a PR shrinks the output).
- Keys: `worker.<entry>` (`maxRawBytes`, `maxGzipBytes`), `server.js` and `client.js`/`client.css` (`maxRawBytes`, `maxGzipBytes`, `maxFiles`). Only ceilings `base.json` already declares can move.
- `note` is required. State the measured growth and who owns it. A ceiling still needs an explicit reason; never raise one to make CI green.
- The file name is the PR number without leading zeros. Each PR owns one file, so two PRs never touch the same path.
- If the summed ceiling reaches zero or below, or any note is malformed, the check exits 2 rather than passing.

Run `node ci/check-kit-perf.mjs` after `npm run build --prefix web` to see the sum against the real output; it prints how many notes were added.

## Folding notes into the base

Folding is a deliberate maintenance PR: add each note's deltas into `base.json`, delete those notes, and keep the summed ceiling unchanged (`node ci/check-kit-perf.mjs` must print the same limits before and after). Any open PR with a note keeps working, because its note stays additive.

`HISTORY.md` is the decision log from before the split.
