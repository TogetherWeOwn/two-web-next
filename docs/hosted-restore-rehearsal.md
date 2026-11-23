# Hosted synthetic restore rehearsal

**hosted-restore-rehearsal** runs on standard GitHub-hosted Ubuntu at the PR head or by manual dispatch
on protected `main` at the workflow SHA. The dispatch receipt follows an independent teardown audit.

One pinned PostgreSQL 18 container uses an isolated bridge, tmpfs, zero published ports and disabled logs.
Its clients test both password routes and diagnostic suppression. Output consists of fixed verdicts
and routine Actions metadata. The job registers no Actions service, artifacts or caches.

The [V1 receipt](backup-integrity.md#optional-snapshot-receipt-for-a-private-restore-comparison) proof pins
the plan before capture and rejects archive and receipt tampering. It authenticates an empty target,
restores with exit-on-error, detects a same-count edit and checks teardown after a refused write.

Cancel `case=cancellation` on `main` during the 120-second populated checkpoint. Check conclusion, teardown,
audit and artifacts. Forced kills before a verdict, provider VM destruction and media erasure remain unobserved.

## Before any live rehearsal

Separately admit the direct production target, read-only role and full dump coverage with independent
release approval. Check Environment branch scope, required reviewers, self-review and bypass settings.
Resolve terms and transfer approval for a runner without an EU location guarantee. [Environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) · [GitHub data protection agreement](https://github.com/customer-terms/github-data-protection-agreement)

Keep one durable bundle in the designated EU bucket. The custodian holds a dedicated bucket-scoped Object
Read only parent and issues a short-lived child for `GetObject` on three exact keys at the EU S3 endpoint.
Verify denial for other objects, buckets, listing and writes. Hold the seal key and trusted pins separately.
Staging keeps seven dailies and four weeklies. Manual production capture skips rotation, which excludes V1 baselines.
Verify lifecycle and holds, assign a deletion owner and deadline, and verify all three keys are gone. [Backup policy](db-migrations.md#backups) · [R2 token permissions](https://developers.cloudflare.com/r2/api/tokens/) · [Temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)

The public standard runner and its temporary storage add zero billed synthetic cost. A live Standard
bundle adds three GETs per attempt ($0.36/million) and zero R2 retrieval or egress charge. New custody adds
three PUTs ($4.50/million) and $0.015/GB-month based on daily peak bytes, subject to rounding and free tiers.
Deletes are free. Infrequent Access adds $0.01/GB retrieval, different rates and a 30-day minimum.
A live ceiling needs size, class, retention, retries, account headroom and capture-side compute and transfer
rates. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) · [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
