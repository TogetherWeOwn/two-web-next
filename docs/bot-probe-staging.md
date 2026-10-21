# Bot probe staging procedure

The internal-action tools (`bin/internal-action-smoke.mjs`,
`bin/internal-action-drill.mjs`) exercise the staging bot. Both default to an
effect-free plan; nothing runs until you say `--apply`.

## Preview

Run the tool with no mode flag. A preview needs no secrets, attempts no
fetch, and sends no queue carriers; it validates the target and the inputs,
then prints the planned checks and exits 0:

```sh
BOT_ENDPOINT_URL=<staging bot> BOT_PRODUCTION_URL=<production bot> \
  node --import ./bin/ts-hook.mjs bin/internal-action-smoke.mjs \
    --discord-id=<snowflake> --role-key=<key> --channel-key=<throwaway>
```

Add `--json` for one versioned plan document with stable check IDs.

## Apply

Re-run the same command with the bare `--apply` flag and the bot secrets
(`BOT_SHARED_SECRET`, `BOT_KEY_ID`). An apply posts a REAL announcement to a
throwaway channel and performs REAL staging effects, so `--channel-key` must
name a throwaway channel. Exit 0 means every check passed; exit 1 means a
check failed; exit 2 means misconfigured (wrong target, bad flags, missing
secret). The tools refuse the production bot host and the production web
apex, and never follow redirects.

## Repeat runs

Pass `--run-id=<id>` (1-64 chars: letters, digits, `_` and `-`) to name the
run. A repeated apply of the same plan under the same run identity reuses
exactly the same announcement/event idempotency carriers, the same generated
event key, and — with the same payload clock — byte-identical payloads, so a
resume replays the original operation instead of posting twice. Distinct
identities stay distinct. Role assignment keeps its natural idempotency (no
key). Runs without `--run-id` mint fresh carriers, as before.

## Live-proof boundary

These tools prove the staging path only. Live bot proof against real members
is held behind a separate authority and is out of scope here: no drill or
smoke run is permission to touch production, provision roles or channels, or
read production credentials.
