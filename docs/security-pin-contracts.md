# Security-pin contracts

Executable pins for two threat-model gaps rows: forwarding-header admission
and inline-style CSP scope. Contracts only: nothing here changes admission,
header or CSP behavior. The rows in `docs/threat-model.md` stay the single
source of truth; this file documents the checks, not the policy.

## Run

```sh
node ci/check-security-pins.mjs --selftest   # gate logic, offline, no deps
node ci/check-security-pins.mjs --static-only  # source pins, offline, no deps
npm run check:security-pins                  # full gate: pins plus suites
npx vitest run test/host-admission-forwarding.test.ts test/inline-style-route-sweep.test.ts
```

The default gate and `--static-only` emit one JSON summary (`version`, `ok`,
per-check rows, and on failure a fixed `error_code` with a concrete
`next_action`). The human one-liner goes to stderr. `--selftest` emits a
human-readable line, and `npm run check:security-pins:selftest` also emits
`node --test` output. Exit 0 is pass, 1 is fail, 2 is usage.

## Stable check IDs

| ID | What fails |
| --- | --- |
| `host-source-pin` | `src/trust-hosts.ts` reads any request header besides Host, or loses its deliberate-ignore marker. |
| `leaf-lifecycle-static` | The recorded bundle bytes or hash differ from a fresh regeneration of the three leaf stylesheets. |
| `inline-allowlist` | `INLINE_CRITICAL_CSS_PATHS` is anything but exactly `/`, `/about`, `/faq`, `/rules`, `/privacy`. |
| `threat-evidence` | Either gaps row drops its pointer to the contract tests or this gate. |
| `host-forward-matrix` | Any `host-admission forwarding contract` suite assertion fails, is vacuous, or misses its describe. |
| `style-route-sweep` | Any `inline-style route sweep` suite assertion fails, is vacuous, or misses its describe. |
| `leaf-hash-lifecycle` | Any `leaf-bundle hash lifecycle` suite assertion fails, is vacuous, or misses its describe. |

## Error codes

| `error_code` | Meaning | `next_action` points at |
| --- | --- | --- |
| `pin_violation` | A static pin failed; the detail names the check. | The failing pin and this file. |
| `suite_run_failed` | Vitest did not complete cleanly. | Re-running the two suites. |
| `suite_report_missing` | No Vitest JSON report was produced. | Re-running the two suites. |
| `suite_report_invalid` | The Vitest JSON report does not parse. | Re-running the two suites. |
| `suite_contract_failed` | A suite assertion failed, or a describe no longer maps (a renamed describe fails on purpose). | The failing check ID. |
| `invalid_arguments` | Unknown flags. | The usage line. |
| `check_error` | The gate itself threw. | The gate failure message. |

Every code is non-retryable: rerunning cannot fix a pin, a suite or an
argument. Regenerate a drifted bundle with `npm run build:leaf-css` (runs
automatically on every `npm ci` via postinstall; the bundle is git-ignored
build output, never committed).

## Properties

Idempotent and read-only: the gate writes only its own scratch report, which
it deletes. The static half needs no dependencies, network or database. The
dynamic half runs the two contract suites, which use local fixtures only.
