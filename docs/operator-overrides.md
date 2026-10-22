# Operator override panel

`GET /admin/ops-overrides` shows the bot's `/ops/config` record: epoch,
overrides, boot baseline and reported enforcement. It is **view-only**.
There are no edit controls, submitted credentials, browser token storage,
or dashboard PUT/proxy-write path. Existing bot API PUT and kill-switch
security gates remain unchanged.

## Admission and custody

The caller must supply `Authorization: Bearer <control token>` on every
read. A Discord moderator session is neither required nor sufficient.
The configured `OPS_CONTROL_TOKEN` must be the existing, separately
authorized bot control token, 32–512 characters without surrounding
whitespace. No checked-in Worker config sets it. Missing or invalid
configuration leaves the route dark (404); a missing, malformed or wrong
bearer returns 401 without upstream access.

Credential binding and activation belong to the authorized secret
custodian. This change creates no token and grants no production access.
Do not paste the token into a URL, page, screenshot, log or shell history;
use an approved header-injection client with in-memory credentials. Never
use a QA token as an operator credential. An ordinary navigation/reload
without that header is refused; there is intentionally no token form.

The web Worker sends only its configured control bearer to the configured
HTTPS `BOT_ENDPOINT_URL` origin at `/ops/config`. It does not forward
browser cookies, headers, path or query. Redirects are not followed, there
is one request with no retry, and the existing bounded HTTP reader caps
fetch plus body completion at 5 seconds and 256 KiB. The bot continues to
enforce its own per-IP request bucket. A bad endpoint, non-200 response,
malformed record, timeout or oversized body returns an explicit 503
unavailable page; no cached record or raw error is shown.

## Freshness

The timestamp is when the web Worker finished reading the record, not
when the bot runtime applied it. The page does not auto-refresh: an open
tab can become arbitrarily stale. Reload with the bearer header for a new
snapshot.

The runtime polls every 15 seconds and retains a last-good record for at
most 300 seconds. During an outage a newer record may not apply; this
panel does not attest to application, effective guild settings or runtime
health. A reported `pending` enforcement value is displayed as reported,
never promoted to an active/success claim. An empty override map is shown
explicitly. While active, overrides precede guild settings; clearing them
falls back to guild settings and then boot defaults.

All panel responses are private/no-store. Query strings are refused.
POST, PUT, PATCH, DELETE and OPTIONS refuse locally before upstream
contact; the shared action-body cap can refuse an oversized attempt
first. The outer application same-origin/host guards still apply.

## Verification and rollback

The Test Author's `test/dashboard-operator-override-panel-acceptance.test.ts`
pins token admission, record/epoch HTML, staleness copy, failure display,
query refusal and no-PUT behavior. Run it with:

```sh
npx vitest run test/dashboard-operator-override-panel-acceptance.test.ts
```

Local visual checks use fixture records only. Staging verification must
use the normal reviewed deployment and an authorized control bearer;
never probe mutations or use production as a test target. Verify a
matching bearer renders the record and epoch, no bearer refuses, the
snapshot timestamp/copy is visible and there are no write controls.

Rollback: removing the optional web `OPS_CONTROL_TOKEN` binding makes the
panel dark without changing the bot record or its API. Code rollback uses
the normal reviewed deployment pipeline; never rotate/delete the bot
credential as a UI rollback.
