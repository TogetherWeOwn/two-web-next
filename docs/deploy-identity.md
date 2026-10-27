# Deploy identity

What a running Worker Version can prove about the build it came from and the
deploy event that put it live. Two halves, never mixed:

| Half | Value | Where it lives | Set by |
|---|---|---|---|
| Build identity | full source SHA, build ID (`<repositoryId>-<runId>-<attempt>`), input-set digest | `src/build-stamp.ts`, compiled into the Worker payload | `ci/deploy-identity.mjs stamp`, **before** the compile |
| Deploy event | environment event ID `YYYY.MM.DD.N+sha7`, GitHub Deployment ID | Version-scoped, non-secret runtime bindings `DEPLOY_EVENT_ID`, `DEPLOYMENT_ENVIRONMENT`, `GITHUB_DEPLOYMENT_ID` | the deploy lane, with `--var`, on the Version upload |

The event ID and Deployment ID are never compiled and never checked into a
Wrangler config. The checked-in `src/build-stamp.ts` is a valid-shaped
placeholder (all-zero SHA) that no real deploy event can match.

## Endpoints

`GET /version` and `GET /readyz` answer the same body: exactly
`source_sha`, `build_id`, `deploy_event_id`, `github_deployment_id`,
`cloudflare_version_id`. Session-free, database-free, `no-store`, Hono-owned
(reserved from Kit). `/up` is unchanged.

They answer a bare `503 {"status":"identity_unavailable"}` and echo nothing
when any piece is absent, malformed or contradictory: an unknown
`DEPLOYMENT_ENVIRONMENT` (only `staging` and `production`), a non-canonical
event ID, an event-ID suffix that is not the first 7 characters of the compiled
SHA, a non-UUID Cloudflare Version ID, or a parseable Version tag naming a
different commit. An absent or unparseable Version tag does not block an
otherwise valid identity. The decision lives in `src/deploy-identity.ts`.

## Lanes

Staging (`deploy.yml`) and production (`deploy-production.yml`) run, in order:

1. `stamp` before the first compile. The input list is `ci/build-stamp-inputs.sh`.
2. `next` allocates the event ID: N is one plus the number of the environment's
   canonical Deployment records created on that UTC date. Enumeration is
   newest-first, 100 rows per page, ends after the page holding the first older
   row or at a short page, and refuses after six full pages. A saved record in
   the runner temp directory makes a retry of the same attempt reuse its ID.
3. `create` makes (or reuses) the canonical Deployment record before the
   Version upload, because its numeric ID is a runtime binding of that Version.
   The same event ID bound to a different full SHA refuses.
4. The deploy or upload passes the three bindings as `--var`. Worker Version
   tags are unchanged (bare SHA on staging, `<sha>-<run>-<attempt>` on
   production).
5. After the existing deployed-revision and public-route proofs, `verify`
   confirms the live Worker answers the recorded identity (and, on production,
   the promoted Cloudflare Version ID), then `status` posts `success`. A lane
   that fails before that posts a `failure` status instead.

Both lanes already serialize through a non-cancelling concurrency group
(`deploy-staging`, `production-worker-mutation`), so the counter cannot race
itself.

## Recovery is never gated

`rollback-production.yml` neither allocates nor records anything. Restoring a
Version does not depend on this slice. Recording failures fail the forward lane
visibly; they never block a rollback.

## Not covered here

This slice stamps and exposes identity. It does not publish a shared build
artifact between staging and production, retire the release-tag job, compute
DORA metrics or redesign rollback. Redeploying a commit that predates this
slice has no `ci/deploy-identity.mjs` in its checkout: restore an earlier
Version with the rollback workflow instead.
