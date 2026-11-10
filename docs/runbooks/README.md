# Runbooks

Actual deploy, rollback and recovery procedures, with prerequisites, approval
boundaries and safe failure paths. No credentials, internal addresses or
operational bypasses appear here; commands are documented, never executed by
opening this directory.

The full operations runbook is the single canonical file; this directory is its
index so the repository's procedure library is discoverable from one place.
Sections are linked, not duplicated, and existing links to the runbook file keep
working.

| Procedure | Canonical section |
| --- | --- |
| First-responder index, safety and escalation | [runbook.md](../runbook.md#safety-and-escalation) |
| Deploy and record the rollback pointer | [runbook.md](../runbook.md#deploy-and-record-the-rollback-pointer) |
| Worker rollback | [runbook.md](../runbook.md#worker-rollback) |
| Read `/up` (readiness vs liveness) | [runbook.md](../runbook.md#read-up-without-mistaking-liveness-for-readiness) |
| Queue containment, drain and failed-job replay | [runbook.md](../runbook.md#queue-containment-drain-and-failed-job-replay) |
| Neon / Hyperdrive outage behaviour | [runbook.md](../runbook.md#neon--hyperdrive-outage-behavior) |
| Backups and restore drill | [runbook.md](../runbook.md#backups-and-restore-drill) |
| 48h post-flip watch | [runbook.md](../runbook.md#48h-post-flip-watch) and [the watch spec](../48h-watch-spec.md) |
| Log triage (from notification to likely change) | [runbook-observability.md](../runbook-observability.md) |
| Log-line alert fingerprints | [runbook-alerts.md](../runbook-alerts.md) |
| Moderator admin and join troubleshooting | [moderator-admin-guide.md](../moderator-admin-guide.md) and [troubleshooting-join.md](../troubleshooting-join.md) |
| Queue redrive (one-row, staging-only) | [queue-redrive-runbook.md](../queue-redrive-runbook.md) |

## Boundaries

- Operations guidance applies to staging and, where a section names the
  production binding, to production. Production has been live since the
  cutover recorded in the [cutover gates](../cutover-gates.md).
- Diagnostics in the runbook's first-responder index are reads. Do not mutate,
  purge, roll back, migrate, rotate or restore from the index table.
- Commands labelled remote mutate the deployed service. They are procedures
  for an authorized operator, not instructions to execute now. Deployment,
  receiver/HMAC and isolation holds still apply; a green workflow or an
  always-200 endpoint does not release them.
- Never test, probe or verify database behaviour against staging or production
  databases. Full database verification uses a disposable database per the
  [README database setup](../../README.md#database-and-migrations).
- On an authentication, ownership or permission failure, stop. Do not try a
  credential from another environment, change identity, or bypass a failed
  check. Use the authorized broker/provisioning principal.
