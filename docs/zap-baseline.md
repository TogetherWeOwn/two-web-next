# OWASP ZAP baseline (staging)

`.github/workflows/zap-staging.yml` runs the official ZAP image's
`zap-baseline.py` (passive rules, 3-minute spider) against the staging Worker,
`https://next.togetherweown.com`. It never targets production: the job refuses
any other host.

- **After every staging deploy:** `e2e-staging.yml` calls it as the
  `zap-baseline` job. If the gate fails, the e2e-staging run fails, and
  `ci/resolve-promotion-sha.mjs` and `ci/production-deploy-gate.mjs` will not
  promote that commit to production.
- **Nightly (03:41 UTC):** catches drift such as headers, CDN or third-party
  changes that no deploy caused. A failure goes through the host flake ledger,
  which re-runs it once and opens a private main-red card for the web engineer if
  it fails again.

## Gate (`ci/zap-gate.mjs`)

- Any **High** alert fails. There is no budget for High, and no `ignore`
  entry (scoped or unscoped) suppresses a High.
- One exception: a lone **PII Disclosure (10062)** High with nothing else
  failing is re-scanned once before failing (`ci/zap-retry-decision.mjs`).
  ZAP's PII rule is a Luhn heuristic prone to false positives on synthetic
  numbers, and the 3-minute spider covers a varying URL subset per run. A
  repeated 10062, any other High, or any budget breach still fails.
- The summary also reports how many sites the scan covered
  (`Scanned N site(s)`), so a thin-spider run is visible next time.
- Missing/malformed scan evidence, unknown risk codes and invalid budgets
  fail closed with a public-safe diagnostic instead of passing.
- **Medium** and **Low** alert-type counts fail above `maxMedium` / `maxLow` in
  `ci/zap-budget.json`. `null` means not yet enforced: counts are reported only.
  Budgets only go down. Raising one, or adding an `ignore` entry (each needs a
  `why`), is its own PR, and reviewers treat it as a finding unless justified.
- The repo is public: JSON and Markdown contain canonical plugin IDs, fixed
  reviewed public labels (or `ZAP alert <id>`), risks and counts only. Report
  `name`/`alert` text is never copied, even when it is a string: it may contain
  credentials, URLs or presentation syntax. Parameters, instance evidence and
  other report fields stay private. The full report is never uploaded.
- An `ignore` entry may carry an optional `uriPrefix`, interpreted as a parsed
  pathname prefix, not a substring of the full URI. A scoped exemption requires
  an absolute HTTP(S) string URI with the same parsed origin (scheme, host and
  effective port) as its containing site's absolute HTTP(S) `@name`. Missing or
  invalid site/URI evidence, credentials, relative URLs, parser-repaired whitespace
  or backslashes, and invalid percent escapes cannot establish an exemption.
  Query/fragment matches, foreign origins and lookalike paths remain counted.
- Before subtracting any scoped instances, the explicit `count` must be a
  non-negative safe integer (number or canonical integer string) equal to the
  supplied instance-list length. Missing, malformed or inconsistent counts fail
  closed with a diagnostic that contains only structural indexes, not raw input.
  Without instances the alert stays; with complete evidence, only proven edge
  hits are subtracted and every unproved or Worker-served hit remains counted.
  The committed exception remains plugin 10096 on `/cdn-cgi/`; Medium and Low
  budgets remain zero. High is still non-exemptible. This proof requirement does
  not change structurally valid empty-scan behavior, including `site: []`.

## Scalar and structured-verdict contract

Risk, declared count and plugin identity admit only numbers that are safe integers
or canonical decimal integer strings (`0` or a nonzero digit followed by digits).
No whitespace, signs, leading zeros, fractions, exponents, hexadecimal, null,
booleans, arrays, objects or unsafe integers are coerced. Risk is 0–3; count is
non-negative and required, including outside scoped subtraction. Plugin identity
is positive: use `pluginid`, or a canonical `alertRef` only when `pluginid` is
absent. An invalid explicit identity cannot fall back to a second field. Budget
numbers must be non-negative safe integer numbers or explicit report-only null;
ignore identities follow the same canonical plugin rule. Invalid budget entries
fail the whole gate, not just that exemption.

```sh
node ci/zap-gate.mjs report.json ci/zap-budget.json --format json
node ci/zap-retry-decision.mjs verdict.json
```

The gate defaults to Markdown; `--format markdown` is explicit. JSON stdout is
one v1 document with `schema_version: 1`, `gate_id: "zap-baseline"`, `verdict`,
`retryable`, `error_code`, `next_action`, `alerts`, `errors`, `counts` and
`site_count`. Each retained alert has a stable `alert_id: "zap-<plugin_id>"`,
canonical string `plugin_id`, numeric `risk`/`count`, and a bounded single-line
public `name`. IDs identify plugin types; duplicate rows remain separate alert
types for the existing gate count. Errors contain fixed codes and, where
applicable, numeric `site_index`/`alert_index`, never raw malformed values.
`errors_truncated` marks omitted diagnostics; `evidence_complete: false` marks
counts over only the validated rows of incomplete evidence, never a clean scan.
A summary-write failure produces FAIL/`invalid_evidence`, not PASS JSON with a
failure exit or a retry capability.

| error_code | verdict | retryable | next_action |
| --- | --- | --- | --- |
| `ok` | PASS | false | `none` |
| `pii_high` | FAIL | true | `rescan_once` |
| `high_alert` | FAIL | false | `fix_findings` |
| `budget_exceeded` | FAIL | false | `fix_findings` |
| `invalid_evidence` | FAIL | false | `repair_evidence` |
| `invalid_arguments` | FAIL | false | `check_usage` |

Invalid evidence (including invalid policy) takes precedence over budget breach,
which takes precedence over High classification. Gate exits are PASS=0,
evidence/policy FAIL=1, argument misuse=2. Unknown flags, duplicate format flags,
unknown/missing format values and wrong positional arity fail closed. JSON
argument errors still use the fixed code/action when JSON was requested.

The workflow writes the initial JSON verdict to a local temporary file and passes
that file, not Markdown, to the retry consumer. The same classifier determines
gate and retry eligibility. The retry consumer validates the schema, scalar
fields, IDs, empty validation errors and code/action/boolean consistency, then
recomputes against validated committed budgets; a file cannot claim relaxed
budgets. Aggregate `counts`, `site_count` and completeness metadata are optional
in the minimum v1 retry input, but must be well-typed and consistent when present.
Markdown and arbitrary JSON never become retry authority. Retry exits are
eligible=0, denied/unreadable/malformed=1, argument misuse=2. This is a local
consumer contract, not a signed provenance attestation. The workflow controls
the verdict file and still permits only one rescan, never a retry loop.

CLI input files are capped at 8 MiB; reports permit at most 1000 sites and 1000
alert rows total. Exceeding a bound is invalid evidence, never a partial PASS.
JSON preserves every retained alert within that bound (under 256 KiB), so output
truncation cannot hide a second High or a budget breach from the consumer.
Validation diagnostics are capped at 20 with a truncation marker; Markdown
presents at most 25 alert rows and 10 fixed diagnostics
(with explicit omission notices), staying below 8 KiB. No report-provided text
is used as a label or annotation. `GITHUB_STEP_SUMMARY` receives only that human
presentation, even in JSON mode; full reports are not published.

Run the synthetic offline regression coverage with:

```sh
npm test -- test/zap-scalar-verdict-acceptance.test.ts test/zap-gate.test.ts test/zap-scope-evidence-acceptance.test.ts test/zap-uri-admission.test.ts test/zap-retry-decision.test.ts
```

These fixtures never start ZAP, access staging, mutate production or need a
database. The independent suite also exercises the actual workflow Gate shell
with fixture scanner/sleep executables and an offline Node fence.
