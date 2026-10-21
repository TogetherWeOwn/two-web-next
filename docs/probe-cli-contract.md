# Probe CLI contract

Shared contract for the staging probe CLIs. Every CLI refuses
non-staging targets before any effect and never prints secrets.

## CLIs

- `bin/queue-authwall-probe.mjs` — queue auth-wall parity drill.
- `bin/alert-probe.mjs --receipt-file <tail-json>` — alert delivery drill.
- `bin/revision-check.mjs [--json] <origin> [<sha>]` — live revision marker.

## Arguments and help

- `QA_AUTH_TOKEN` comes from the environment only, never from argv.
- `--help` wins in any argv position: usage to stdout, exit 0, empty
  stderr, zero side effects (no token read, no fetch, no file write).
- Wrong argv prints static usage to stderr (never echoing argv) and
  exits 2; revision-check also refuses non-staging origins this way.

## Exit codes

- `exit 0` — verdict passed, marker recorded, or `--help` printed.
- `exit 1` — verdict failed or the probe errored; claims nothing.
- `exit 2` — wrong arguments or a refused target; static usage.

## JSON verdicts

One JSON object on stdout: `version` 1, `tool`, `mode` "report", `ok`,
`code` (UPPER_SNAKE, `*_OK` on pass), `next` (safe action), `checks`
(stable kebab `id`, `label`, `ok`). Existing result fields stay;
no tokens, cookies, bodies, or URLs in output.
