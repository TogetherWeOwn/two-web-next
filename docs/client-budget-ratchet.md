# Measured client-budget ratchet

The trusted-main `client-budget-ratchet` workflow measures the built application
without writer credentials. Its separate repository-token writer parses the
measurement, proposes lower-only client byte ceilings, and creates or updates
one automation-owned draft. File caps, served-asset gates, required checks and
security boundaries do not change. It never auto-merges.

Raw and gzip ceilings ratchet independently: target is measured bytes × 1.25,
rounded up to a 512 B raw or 256 B gzip step. Lower only when the current ceiling
minus the target is **strictly greater** than one step. A successive ratchet can
therefore lower raw while leaving gzip unchanged. Boundary tests prove each
metric's diagnostic even when a different metric already prevents a joint fit;
the historical fixed-allocation proofs remain unchanged.

## Hold, drain, then promote

Repository-token writes do not trigger the normal PR workflows. Promotion must
use an independently authenticated maintainer identity, not this workflow's
repository token. No new credential or workflow/repository setting is required.

1. While the PR is still **draft**, append a persistent `Promotion hold` note to
   its body. Do not restore the generated body. The writer requires exact
   automation metadata, so this human edit prevents every later writer from
   taking ownership. The writer never replaces the body.
2. In Actions, wait for **all already-started `client-budget-ratchet` writer
   jobs** to finish, including queued or waiting jobs. The metadata check is a
   read, not an atomic PR-state lock: a writer already past its final read may
   still commit after the hold. Let that writer settle. Later jobs refuse the
   held body even if another main build produces a measurement.
3. Re-read and record the settled PR head SHA. Only then mark the PR ready using
   the independent identity. Keep the body hold in place throughout review.
4. Verify all normal CI, e2e, PR-lint/security checks and required reviews on
   **that exact head**. Missing checks or older-head results are not approval.
   Follow the ordinary review and production-release gates before merging.

Direct promotion while a writer is in flight is unsupported. The writer checks
open/draft state, ownership, title, body, base and head immediately before its
commit, and checks PR metadata and the authoritative branch ref afterward. The
post-write PR snapshot may still show the previous head; it is not used to verify
the created commit. A changed branch ref or invalid metadata refuses success.
These reads report late races but cannot make the PR metadata transactional with
GitHub's commit mutation. Only `expectedHeadOid` is atomic.
A post-write refusal does not undo a commit and never retries or force-pushes.
If a commit races an unsupported promotion, return the PR to draft, retain the
body hold, drain writers, and independently promote the settled head again so
normal workflows are triggered. Do not substitute the previous head's checks.

## Route evidence and layout resets

REA source: the installed SvelteKit
`src/core/generate_manifest/index.js` compacts used server nodes and rewrites
route indexes, while its loader filenames preserve the original client indexes.
`src/exports/vite/build/build_server.js` uses those original indexes for client
node entries. Importing the node modules just to read their exported `index`
also loads application dependencies such as `cloudflare:` modules, which plain
Node cannot resolve. The credential-free generator instead reads the pinned
loader-table syntax and refuses an unsupported or incomplete mapping.

Version 2 route evidence remaps layouts, errors and leaves to original client
indexes. It inventories every emitted node, including layouts made unused by a
`+page@.svelte` reset. To avoid an exclusion or an undercount, each unused emitted
node **and its entire static/dynamic/CSS closure** is conservatively charged to
every page route. Endpoint-only routes remain zero-cost under this metric.
This is an upper bound, not a claim that an unused layout is fetched.

The checker still requires contiguous complete client-node inventory, router
dispatch for every node, exact source/built route coverage, unique valid unused
indexes disjoint from route references, physical/manifest inventory agreement,
and no orphan graph assets. Aggregate totals still count the complete shipping
`_app` JS/CSS inventory. No byte ceiling or file cap is raised to support resets.
The real-build regression runs the installed SvelteKit/Vite plugin on local
root-page, root-layout, nested-layout and root-reset-page fixtures before
running the actual evidence generator and checker.
