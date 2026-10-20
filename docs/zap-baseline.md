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
- The repo is public, so the job summary lists alert names and counts only. The
  full report, with URLs and evidence, is never uploaded. Reproduce locally with
  the same image and command when you need detail.
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

Run the synthetic offline regression coverage with:

```sh
npm test -- test/zap-gate.test.ts test/zap-scope-evidence-acceptance.test.ts test/zap-uri-admission.test.ts test/zap-retry-decision.test.ts
```

No live scanner or network access is needed to verify the exemption boundary.
