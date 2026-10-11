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

- Any **High** alert fails. There is no budget for High.
- **Medium** and **Low** alert-type counts fail above `maxMedium` / `maxLow` in
  `ci/zap-budget.json`. `null` means not yet enforced: counts are reported only.
  Budgets only go down. Raising one, or adding an `ignore` entry (each needs a
  `why`), is its own PR, and reviewers treat it as a finding unless justified.
- The repo is public, so the job summary lists alert names and counts only. The
  full report, with URLs and evidence, is never uploaded. Reproduce locally with
  the same image and command when you need detail.
- An `ignore` entry may carry an optional `uriPrefix`: only alert instances
  whose URI contains that substring are ignored, so Worker-served hits for the
  same plugin still count. Prefer a scoped ignore when the evidence is
  edge-owned (for example `/cdn-cgi/` for Cloudflare-injected assets).
