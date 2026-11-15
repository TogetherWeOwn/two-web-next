# ADR 0002: API migration amendment to ADR 0001

- Status: technical direction approved; implementation and release gates remain
- Source examined at: `ff66f10d01e76299c60a51039e2da47dcca8a3c9`
- Scope: source preparation for the existing post-M0 migration, not a release
  authorization or evidence of current deployment configuration.

## Context and established direction

[ADR 0001](0001-sveltekit-page-renderer.md) records the owner's direction to
consolidate the retained Hono API surface into SvelteKit after M0. M0 includes
all page families served by Kit in production and the Kit Worker's 48-hour
production acceptance. Family cutover still requires its own design, evidence,
review and release gates. Source preparation may precede M0; production family
flips may not. This amendment does not change ADR 0001's retirement, rollback,
security or no-JavaScript requirements.

The [route map](../kit-route-map.md) is a planning snapshot, not proof of
behavioral parity, final classification, or completed migration. The merged
[`fetchApp` seam](../../test/http-seam.ts) supports testing dispatch; it does
not establish built-Worker parity. A post-Ember inventory, map and pure-Hono
golden refresh and revalidation remain mandatory before shared-dispatch
integration or any production family flip. Later production flips also require verification
from the release log that their cited page sources are live.

## Technical decisions

The Engineering Lead approved these choices at the source SHA above. None claims
an implemented runtime change.

1. **Consolidation and rendering.** Move the retained API families into Kit
   after M0, preserving their external contracts. Remove `hono/jsx` only after
   its remaining consumers have moved; render feeds and error pages with string
   templates or Svelte as appropriate, preserving escaping and representations.
   Keep Hono handlers, method-aware rollback and the retirement and rollback
   windows in ADR 0001 until its retirement ordering permits removal.
2. **Rejected native forms.** Prefer endpoint-rendered Svelte, preserving frozen
   methods and URLs and each branch's existing status and representation. A
   validation branch returning 422 retains that status, applicable entered
   values, errors and no-JS behavior. RSVP instead has branded refusals with
   their original status and `Retry-After`; do not invent field repopulation.
   A named action at `?/name` or redirect plus flash is not equivalent to 422.
   Before each cutover, prove the compiled endpoint-to-Svelte integration on the
   built Worker, complete document, head and styles, applicable CSP, security,
   cache and session headers, safe value rendering, and failure/no-JS behavior.
   Do not assume page layouts, loads or actions supply an endpoint's document.
   If proof fails, retain Hono ownership and resolve the design. A URL change
   needs explicit approval and an update to the [URL freeze](../url-freeze.md).
3. **Form-action redirect carve-out.** Permit Kit `redirect(303)` inside form
   actions for established successful POST/redirect/GET contracts only. This
   is not blanket permission to redirect endpoints or alter error responses,
   Location/query policy, security controls or method/URL ownership. Preserve
   existing RSVP success, already-withdrawn and 401 recovery/login redirects;
   these are existing contracts, not new exceptions. First prove the proposed
   dispatch for browser and non-browser requests.
4. **Source evidence.** Retain `GET /admin/queue/source-evidence/:id` and its
   disabled behavior, bounded bearer/incident authorization, check ordering,
   JSON failures, private/no-store responses, registered method refusals and
   surrounding middleware/body limits until independently approved retirement.
   This does not enable or broaden the endpoint, replace its guard with ordinary
   moderator access, or claim the planned Kit endpoint exists. See
   [`source-evidence.ts`](../../src/admin/source-evidence.ts) and its
   [route registration](../../src/admin/routes.tsx).
5. **Members.** Preserve pre-session 404 for `/members` and `/members/`,
   member-gated and audited `GET /members/:user`, direct PATCH and form-media
   POST with exact `_method=PATCH`. Preserve write gating, self-only authorization,
   body/error and unsupported-method branches; JSON POST is not the override.
   Before selecting a target, prove GET/HEAD/PATCH/POST coexistence, applicable
   Accept negotiation/Vary and signed-out/error behavior. The map alternatives
   are not final classification. See the [URL freeze](../url-freeze.md) and
   [`routes-writes.tsx`](../../src/profiles/routes-writes.tsx).
6. **Agent database.** Ingress selects `AGENT_DB?.connectionString ??
   databaseUrl(env)`; the ordinary resolver prefers `DATABASE_URL`, then
   `DB.connectionString`. Fallback occurs only when the dedicated connection
   string is nullish, not when empty or its connection fails. See the
   [ingress handler](../../src/agent-events/route.ts) and
   [ordinary resolver](../../src/db/connection.ts). The test-store seam is not a
   production binding, and source evidence uses the ordinary resolver. No
   `AGENT_DB` binding was found in tracked Wrangler configurations at the source
   SHA; deployed and out-of-file bindings remain unknown. Binding inventory and
   connection-path evidence are prerequisites for the affected ingress cutover.
7. **Request signal.** Cloudflare's [compatibility flags reference](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#enable-requestsignal-for-incoming-requests)
   says `enable_request_signal` is default for compatibility dates on or after
   **2026-11-17**; earlier dates require explicit opt-in and
   `disable_request_signal` opts out. Incoming `request.signal` fires on client
   disconnect; downstream operations need the signal passed explicitly. The
   tracked root and Kit Wrangler configurations use `2026-09-29` and
   `nodejs_compat` without this opt-in at the source SHA. Actual deployed flags
   and disconnect behavior remain unverified; do not infer live configuration.

## Evidence and release boundaries

The choices above do not establish that any API family is ready to ship. Each
slice must prove its contracts, security controls, no-JS and failure states on
its exact candidate head, including any coexistence and rendering integration.
Keep the existing independent Security then QA reviews where applicable,
exact-head GitHub Actions and release admission. Full suites and CI gates run
on Actions; local test execution remains limited by the repository's agent
rules. This amendment authorizes no dependency change, runtime edit, staging or
production probe, or deployment.
