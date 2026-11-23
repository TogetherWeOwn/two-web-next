# Hosted synthetic restore rehearsal

Run **hosted-restore-rehearsal** on the standard GitHub-hosted Ubuntu runner. The PR trigger proves the
synthetic path at the PR head. Manual dispatch requires protected `main` in this repository and workflow
source at the dispatched SHA. The receipt follows restore and an independent teardown audit.

The job owns one digest-pinned PostgreSQL 18 container on an isolated internal Docker bridge. It checks
network membership, zero published ports, tmpfs backing and disabled service logging. It launches the
service directly, leaving no registered Actions service for automatic diagnostic collection. Clients run
inside the network. A generated TCP password, a wrong-password probe and an injected service diagnostic
verify the controls. The workflow has a read-only checkout token, accepts only a synthetic case selection
and publishes fixed verdicts plus ordinary Actions metadata, with zero artifacts or caches.

The job reuses the snapshot fixture and [V1 receipt contract](backup-integrity.md#optional-snapshot-receipt-for-a-private-restore-comparison).
It pins the plan before capture, freezes the archive and both receipts and exercises tampering. It checks
the connected database name, login and effective role, OID, run marker and emptiness before restoring
atomically with exit-on-error. Private comparison must match and detect a same-count edit. A second empty
target exercises actual restore failure, rollback and cleanup.

Dispatch `case=cancellation` on `main` and cancel during the 120-second populated checkpoint. Confirm the
cancelled conclusion, teardown verdict, any follow-up audit and zero artifacts. The audit fails on residue.
Forced termination before reporting leaves an evidence gap. Provider VM destruction and physical disk or
swap erasure are outside the runner's teardown observations.

## Before any live rehearsal

Separately admit the direct production target, effective read-only role and full dump coverage and obtain
independent release approval. Verify actual main-only Environment restrictions, required reviewers,
self-review and bypass settings before credentials can enter. Protected-source review and execution
approval are distinct controls. Resolve GitHub terms and transfer approval for transient processing on a
runner without an EU location guarantee. [Environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) · [GitHub data protection agreement](https://github.com/customer-terms/github-data-protection-agreement)

Keep one durable bundle in the designated EU backup bucket. The custodian holds a separate Object Read
only parent scoped to that bucket and issues a short-lived child for `GetObject` on all three exact keys
on the EU S3 endpoint. Verify denial for other objects, buckets, listing and writes. Hold the seal key
and trusted pins independently. Staging keeps seven dailies and four weeklies. Manual production capture
skips rotation and existing manifest rotation excludes the V1 baseline. The custodian must verify
lifecycle and holds, record the approved expiration and deletion owner, and confirm all three keys are
gone using separate disposition authority. [Backup policy](db-migrations.md#backups) · [R2 token permissions](https://developers.cloudflare.com/r2/api/tokens/) · [Temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)

Standard hosted compute is free for public repositories. This synthetic run adds no billed storage,
transfer, retention or object requests. A live Standard bundle adds three Class B GETs per attempt
($0.36/million), zero Internet egress or retrieval charge, and for new custody three Class A PUTs
($4.50/million) plus $0.015/GB-month based on daily peak bytes. Account-level free tiers and rounding apply.
Deletes are free. Infrequent Access adds $0.01/GB retrieval, different rates and a 30-day storage minimum.
A live ceiling needs actual size, class, retention, retries, account headroom and capture-side database compute
and transfer rates. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) · [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
