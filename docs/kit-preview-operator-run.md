# Kit preview-mode operator run

Preview fetches are an operator-run gate, not CI evidence. CI runs the same
scripts in unit mode (hermetic: no database, no browser, no network, no
secrets); only an operator runs them against deployed Workers. The full
assertion set lives in [Kit journey, visual and performance parity gates](kit-parity-gates.md);
this procedure is the run book a second operator follows without asking the author.

## Who runs it

Any operator with access to the staging QA token through the already-approved
secret binding. No new grant, rotation, or export is part of this run: the
token travels as the `staging` Environment secret `QA_AUTH_TOKEN` (secret name
only here, never a value), masked in logs, sent only as the `X-TWO-QA-Auth`
header. See [Critical journeys](critical-journeys.md#staging-post-deploy-journeys)
for the custody rule and [Config](config.md) for the `QA_AUTH_TOKEN` row.
Anyone without that access runs the guest-only pass and ledgers the
authenticated journeys as skipped with reasons; that is a valid partial run,
not a pass.

## Prerequisites

- Clean checkout on the head under test; Node on the repo floor (22.23.0+ on
  the 22.x line, or 24+).
- No secrets in the repo, in shell history, or in any pasted output. Variable
  names only, never values.
- Both preview URLs known: the Kit Worker under test and the Hono reference.
  Each must be an `https:` origin with no credentials, port, path, query or
  fragment, hosted on `next.togetherweown.com` (staging) or `*.workers.dev`
  (preview), and the two must differ. Anything else exits 2 before any fetch.
- Optional: `KIT_PARITY_QA_TOKEN` carrying the staging QA token for the
  authenticated member-board arm. Without it those journeys ledger as skipped
  with the reason, never as a quiet pass.

## Exact commands

Guest-only preview (no logins, no token):

```sh
KIT_PREVIEW_URL=https://<kit-preview-host>/ \
HONO_PREVIEW_URL=https://next.togetherweown.com/ \
node ci/kit-preview-e2e.mjs
```

```sh
KIT_PREVIEW_URL=https://<kit-preview-host>/ \
HONO_PREVIEW_URL=https://next.togetherweown.com/ \
node ci/kit-parity-gates.mjs
```

Authenticated preview (one QA login per base, replayed as a cookie; the token
and cookie values never reach the ledger):

```sh
KIT_PREVIEW_URL=https://<kit-preview-host>/ \
HONO_PREVIEW_URL=https://next.togetherweown.com/ \
KIT_PARITY_QA_TOKEN="$QA_AUTH_TOKEN" \
node ci/kit-parity-gates.mjs
```

Read the token from the approved binding into the environment; never place the
value in `argv`, a URL, a file in the repo, or a comment. Omit either preview
URL and both scripts exit 2 with the set-both-or-neither diagnostic before any
fetch; set exactly one and the same thing happens. Unit mode (neither URL set)
is the CI path and proves nothing about the deployed pair.

Optional sanity check before a run (no network, no token):

```sh
node ci/kit-parity-gates.mjs --selftest
```

## Required evidence checklist

Copy this list into the card or PR comment and check every box:

- [ ] Both commands pasted with their redacted environment (host names only,
      token shown as `$QA_AUTH_TOKEN`, never its value).
- [ ] Exit code of each command (0 pass, 1 journeys failed, 2 misconfigured or
      all-skipped/empty ledger).
- [ ] `test-results/kit-parity-ledger.json` and
      `test-results/kit-parity-ledger.md` attached or linked: verdict plus
      passed/failed/skipped/total counts. An `empty` or `all-skipped` verdict
      is not a pass.
- [ ] Skipped journeys quoted with their reason strings (missing
      `KIT_PARITY_QA_TOKEN`, unavailable QA seam, Hono-owned route with its
      skip reason). A skip without a reason is a finding, not evidence.
- [ ] Secret scrub confirmed: no `X-TWO-QA-Auth` value, session cookie,
      Discord secret, or PII in the ledger, stdout, or attachments. A token
      found in an artifact is exposed: report it to the COO the same hour
      (see [Kit journey, visual and performance parity gates](kit-parity-gates.md#security)).
- [ ] Deployed revisions recorded (both Worker hosts plus the repo head the
      gate ran against).
- [ ] `docs-links` gate green on the head that carries this procedure.

## What preview mode does NOT cover in CI

State this on every preview-evidence comment so a green CI run is never read
as preview proof:

- CI never sets the preview URLs or `KIT_PARITY_QA_TOKEN`, so the `check` job
  runs `ci/kit-preview-e2e.mjs` and `ci/kit-parity-gates.mjs` in unit mode
  only. Unit mode validates the shipped manifest, proves every assertion
  helper passes on a good fixture AND fails on planted mutants, and ledgers
  login journeys from the manifest — it fetches nothing deployed.
- Per-entry iteration over every parity route (all four hot-zone paths,
  `?page=2`, admission variants) happens only in preview mode.
- Preview-mode member-board checks spend one QA login per base and run only
  with the token; in CI those journeys ledger as skipped. The only
  authenticated Kit-parity journey in CI is the `browser-smoke` member-board
  run with one shared QA login, which does not replace the preview matrix.
- Byte-section comparison covers the archive paths only; join, recovery,
  hot-zone, member-board and static-leaf entries prove structural contracts
  instead of equal bytes by design (widget state, retry hrefs, live
  aggregates and per-viewer rows differ).
- The signed-in non-member 403 arm cannot be minted by the QA seam (both QA
  identities are members) and stays pinned hermetically; preview never covers
  it.
- Visual baselines, performance budgets, and the built-Worker runtime fixture
  are separate gates with their own evidence; a preview pass does not stand in
  for them.

## Troubleshooting

- Exit 2 naming a URL rule: re-read the pairing rule above (both or neither,
  `https:` origin, allowlisted host, differing hosts). Fix the environment,
  not the gate.
- Exit 1 with a section mismatch: the two Workers served different archive
  sections. Record both revisions and the failing journey name; do not rerun
  until the divergence is understood.
- QA login answers non-204 or no session cookie: the journey ledgers as
  skipped naming the host and status. The QA seam allows 10 logins per minute
  shared across callers; on a throttle wait, honor the retry delay without
  retrying refused credentials, and never run a second concurrent preview
  against the same bases.
- Staging reads are live: an empty staging database changes row content but
  the structural contracts still apply. Empty is not a failure of the gate;
  a missing contract marker is.
