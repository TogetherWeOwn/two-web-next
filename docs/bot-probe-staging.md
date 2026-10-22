# Bot probe staging procedure

The internal-action tools (`bin/internal-action-smoke.mjs`,
`bin/internal-action-drill.mjs`) exercise the staging bot. Both default to an
effect-free plan; nothing runs until you say `--apply`.

## Discover

From the repository root, with the [supported Node version and dependencies](../README.md#develop-and-test-safely):

```sh
node --import ./bin/ts-hook.mjs bin/internal-action-smoke.mjs --help
node --import ./bin/ts-hook.mjs bin/internal-action-drill.mjs --help
```

Bare `--help` in any argv position prints static usage to stdout, nothing to
stderr, and exits 0 before reading target/credential configuration, validating
inputs, constructing a plan or performing effects. It wins over missing,
invalid, duplicate and conflicting options, even beside `--json`. Help is text,
not a JSON envelope.

## Preview

Use bare `--dry-run` to explicitly request the existing effect-free plan, or
omit the mode flag for the same preview. A preview needs no secrets, attempts
no fetch, and sends no queue carriers; it validates the target and the inputs,
then prints the planned checks and exits 0:

```sh
BOT_ENDPOINT_URL=<staging-bot-url> BOT_PRODUCTION_URL=<production-bot-url> \
  node --import ./bin/ts-hook.mjs bin/internal-action-smoke.mjs \
    --discord-id=<snowflake> --role-key=<key> --channel-key=<throwaway> \
    --run-id=rehearsal-1 --dry-run --json

APP_URL=<staging-web-url> \
BOT_ENDPOINT_URL=<staging-bot-url> BOT_PRODUCTION_URL=<production-bot-url> \
  node --import ./bin/ts-hook.mjs bin/internal-action-drill.mjs \
    --discord-id=<drill-identity> --role-key=<key> --channel-key=<throwaway> \
    --run-id=rehearsal-1 --dry-run --json
```

These are templates: replace angle-bracket placeholders before using them.
Add `--json` for one version-1 plan document with stable check IDs; omit it
for text. Smoke also supports `--announcement-only --channel-key=<throwaway>`
without role, Discord or event inputs. Full smoke accepts `--event-key=<key>`.

Only `--name=value` options and bare flags are accepted. `--dry-run` and
`--apply` are mutually exclusive; duplicate mode flags, valued flags (such as
`--dry-run=true` or `--help=true`), unknown flags, duplicate value options,
positionals, bare value options and empty values are usage errors (exit 2)
before target resolution or effects. Refusals never echo raw argv. Both tools
preflight applicable payloads before any action; announcement-only validates
only its announcement.

## Apply

Only after the existing staging isolation/HMAC prerequisites and independent
review clear, re-run the preview command with `--apply` **instead of**
`--dry-run`, supplying `BOT_SHARED_SECRET` and `BOT_KEY_ID` through the
environment only. An apply posts a REAL announcement to a throwaway channel
and performs REAL staging effects, so `--channel-key` must name a throwaway
channel. Full smoke also creates an event; the drill performs role.assign and
announcement.post through the queued handlers, never event.upsert.

The tools require valid `BOT_ENDPOINT_URL` and `BOT_PRODUCTION_URL`; the drill
also requires `APP_URL`. They refuse the entire production bot hostname
(including alternate ports, case and DNS root dots); the drill also refuses
the production web apex. They never follow redirects. A distinct hostname
alone is not evidence of staging isolation or permission to apply.

## Output and recovery

Exit 0 means help/plan printed or every applied check passed. Exit 1 means an
applied check failed (or the probe failed unexpectedly). Exit 2 means
misconfigured inputs, target or credentials; no checks ran. A plan is not
executed proof. With `--json`, stdout is one versioned `plan`, `report` or
`error` document (except help); transport diagnostics use stderr. Error codes,
check IDs and the `next` action vocabulary are unchanged:

| Error code | Next action |
| --- | --- |
| `INVALID_ARGUMENTS` | Fix the flagged option and re-run without `--apply` to preview the plan. |
| `INVALID_RUN_ID` | Choose 1-64 letters, digits, underscore or hyphen (leading alnum) and re-run to preview. |
| `INVALID_TARGET` | Point `BOT_ENDPOINT_URL` (and `APP_URL` for the drill) at the staging targets and re-run to preview. |
| `MISSING_CONFIGURATION` | Export `BOT_SHARED_SECRET` and `BOT_KEY_ID`, then re-run with `--apply`. |
| `SMOKE_CHECKS_FAILED`, `DRILL_CHECKS_FAILED` | Fix the failing checks, then re-run the same `--run-id` with `--apply` to resume. |
| `INTERNAL_ERROR` | Re-run without `--apply` to preview; report the failure with the plan output. |

If a credential fails, stop and report the error; never substitute credentials.

## Repeat runs

Pass `--run-id=<id>` to name the run. A repeated apply of the same plan under
the same run identity reuses exactly the same announcement/event idempotency
carriers, the same generated event key, and byte-identical payloads — the
payload stamp derives from the identity, so a resume needs no extra flag to
replay the original operation instead of posting twice. Distinct identities
stay distinct. Role assignment keeps its natural idempotency (no key). Runs
without `--run-id` mint fresh carriers and stamp the wall clock, as before;
do not compare deliberately random unnamed plans for byte equality.

## Offline verification

```sh
npx vitest run test/internal-action-discovery-dry-run-acceptance.test.ts
```

This hermetic subprocess matrix uses synthetic configuration and transport
fixtures, observes zero help/preview effects, and exercises real apply code
only against fake responses with sockets denied. It needs no credentials,
network or database; it is not live staging or deployment evidence.

## Live-proof boundary

These tools prove the staging path only when separately authorized and
actually applied. Live bot proof against real members is held behind a
separate authority and is out of scope here: no drill or smoke run is
permission to touch production, provision roles or channels, or read
production credentials.
