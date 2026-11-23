# Website handoff

Source reviewed on 2026-11-23 at `2efc496b4620f2de8c6ab27a29db16e96191e157`
on `main`. Use this snapshot to pick up the work and check for newer source
and release receipts before acting. The links below lead to the current
contracts and the dated evidence.

## Approved direction and milestone boundaries

[ROADMAP.md](../ROADMAP.md) records approved Ember Hours core scope across
the website and bot. Completion requires the accepted surfaces serving
together in production. Later expansion needs its own approval. The
[post-cutover milestone proposal](post-cutover-milestone.md) remains historical.

[ADR 0001](adr/0001-sveltekit-page-renderer.md) chooses SvelteKit with Svelte 5
as the single page renderer under `web/`. **Renderer M0** requires all page
families in the retirement register to serve their GET pages from Kit in
production, then completion of the Kit Worker's 48-hour production acceptance.
Ember Hours is a distinct product milestone, also called M0 in planning. The
repository establishes no equivalence or ordering between the two milestones.

Through renderer M0, Hono retains non-page contracts, including the HTML
response to a rejected native POST. Preserve methods, URLs, security behavior
and no-JavaScript journeys during the page move.
[ADR 0002](adr/0002-api-migration-amendment.md) permits source preparation before
renderer M0. Refresh and revalidate the post-Ember inventory, route map and
pure-Hono goldens before shared-dispatch integration or any production API
family flip. Production API flips follow renderer M0 and require family-specific
built-Worker proof, review, release approval and receipts for the cited live
page sources. Use the ADR 0001 retirement register for the rollback windows and
removal order.

## What the source and receipts establish

| Surface | Evidence |
| --- | --- |
| Production upload | The [production workflow](../.github/workflows/deploy-production.yml) verifies and uploads Hono's `dist-production/worker.js` using the root [Wrangler config](../wrangler.jsonc). The Kit build uses [its own production config](../web/wrangler.production.jsonc) for dry-run inventory only. All five Kit family flags in that config default to `false`. The [bundle evidence contract](worker-bundle-inventory.md) distinguishes build, upload and promotion. |
| Production release | The latest published release found on 2026-11-23 was [v2026.1115.0](https://github.com/TogetherWeOwn/two-web-next/releases/tag/v2026.1115.0), SHA `57f1abbc25d0b39a77d83b46eb8b803b0249bb66`. Its [November 15 promotion and public-route smoke](https://github.com/TogetherWeOwn/two-web-next/actions/runs/43671079084/job/132681549568) passed. On November 21 a later [production migration dry run](https://github.com/TogetherWeOwn/two-web-next/actions/runs/44914620292/job/136877479458) failed before apply. The current serving SHA and renderer state are unknown here. |
| Staging selectors | The [staging workflow](../.github/workflows/deploy.yml) uses the Kit Worker and selects page families explicitly. `hono` is the default. `archive` selects `/events/past` and `archive-static` adds `/about`, `/faq`, `/privacy` and `/rules`. `events`, `home` and `join` select `/events`, `/` and `/join` respectively. `events-join` and `events-home` combine the named pages, and `ember-pages` selects all three. Automatic runs use the staging environment setting and manual runs use the workflow input. See the [runbook](runbook.md#deploy-and-record-the-rollback-pointer) for admission and fallback. |
| Staging receipt | The [November 23 staging deploy](https://github.com/TogetherWeOwn/two-web-next/actions/runs/45098718821/job/137444322621) for `41136414f25b453fe3f8fee653f2bb53918a041f` passed revision verification, the Kit renderer checks for Events, Home and Join, and public-route smoke. Treat this as evidence for those routes at that revision. The current deployed revision, persistent selector and next family order are unknown here. |

The method-aware [route ownership manifest](../src/route-ownership.ts) and
[Kit parity inventory](kit-parity-gates.md#route-inventory) show source
coverage. Staging Privacy and House Rules use a separate
[document-only opt-in](../src/kit-staging-static.ts). Their HEAD and Markdown
requests stay with Hono. Source eligibility, a staging pass and a production
promotion each establish different facts.

## Next pickup

Assemble the evidence for a specific Kit page-family cutover. First reconcile
the current revision, renderer and remaining families against the latest
release and staging receipts and the ADR 0001 retirement register. Identify
the next eligible family and record its scope, candidate SHA and rollback
pointer. Keep the family order open until that evidence establishes it.

1. On the exact candidate, prove the built Kit Worker against the Hono
   contract using the [parity gates](kit-parity-gates.md), including journey,
   visual, accessibility and performance evidence for the routes in scope.
   Use the all-off replay and check retained routes and methods. Hono-only
   checks cover the Hono baseline. Follow the
   [performance policy](performance-budgets.md#staging-quality-and-journey-gates)
   for the current Lighthouse reporting and blocking origin checks.
2. For an authorized staging run, record the selected family, exact SHA,
   deployed version, renderer checks, smoke and staging e2e evidence.
   Confirm the selected pages and their Hono fallback behave as expected.
   Use the [deployment and rollback procedure](runbook.md#deploy-and-record-the-rollback-pointer)
   for the scope and evidence fields.
3. For the first production Kit cut, qualify a reviewed path that actually
   uploads the Kit artifact. Capture the exact artifact, promoted Worker
   version, renderer results, smoke and rollback evidence through the
   [release gate](../CONTRIBUTING.md#production-release-gate). Record each
   production family acceptance and the
   [48-hour watch](48h-watch-spec.md) before claiming renderer M0.

See the [decision index](decisions/README.md) for provenance, the
[runbook index](runbooks/README.md) for operational procedures and the
[merge policy](../CONTRIBUTING.md#merge-and-production-staging-evidence) for
exact-head review and promotion-path routing.
