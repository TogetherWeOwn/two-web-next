# Hosted synthetic restore rehearsal

**hosted-restore-rehearsal** runs on standard GitHub-hosted Ubuntu at the PR head or by manual dispatch
on protected `main` at the workflow SHA. The dispatch receipt follows an independent teardown audit.

One digest-pinned PostgreSQL 18 container owns an isolated internal bridge with zero published ports,
tmpfs and disabled service logging. Clients run inside that container. The job checks password rejection
on the capture and restore routes and injects a diagnostic to test suppression. Public output is fixed
verdicts plus routine Actions metadata. The job registers no Actions service, artifacts or caches.

The [V1 receipt](backup-integrity.md#optional-snapshot-receipt-for-a-private-restore-comparison) rehearsal
pins the plan before capture and freezes the archive and receipts. It tests tampering, checks target
identity and emptiness, restores in one transaction with exit-on-error, and detects a same-count edit.
The failure case checks teardown after PostgreSQL refuses a write and the target remains empty.

Dispatch `case=cancellation` on `main` and cancel at the 120-second populated checkpoint. Confirm the
cancelled conclusion, teardown verdict, audit result and zero artifacts. Forced termination before a
verdict, provider VM destruction and physical disk or swap erasure remain outside observable teardown.

## Before any live rehearsal

Separately admit the direct production target, read-only role and full dump coverage with independent
release approval. Check Environment branch scope, required reviewers, self-review and bypass settings.
Resolve terms and transfer approval for a runner without an EU location guarantee. [Environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) · [GitHub data protection agreement](https://github.com/customer-terms/github-data-protection-agreement)

Keep one durable bundle in the designated EU bucket. The custodian holds a dedicated bucket-scoped Object
Read only parent and issues a short-lived child for `GetObject` on three exact keys at the EU S3 endpoint.
Verify denial for other objects, buckets, listing and writes. Hold the seal key and trusted pins separately.
Staging keeps seven dailies and four weeklies. Manual production capture skips rotation and the V1 baseline
is outside manifest rotation. The custodian checks lifecycle and holds, records expiration and deletion
ownership, and verifies deletion of all three keys. [Backup policy](db-migrations.md#backups) · [R2 token permissions](https://developers.cloudflare.com/r2/api/tokens/) · [Temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)

The public standard runner and its temporary storage add zero billed synthetic cost. A live Standard
bundle adds three GETs per attempt ($0.36/million) and zero R2 retrieval or egress charge. New custody adds
three PUTs ($4.50/million) and $0.015/GB-month based on daily peak bytes, subject to rounding and free tiers.
Deletes are free. Infrequent Access adds $0.01/GB retrieval, different rates and a 30-day minimum.
A live ceiling needs size, class, retention, retries, account headroom and capture-side compute and transfer
rates. [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) · [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
