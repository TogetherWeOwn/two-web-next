# Website runbooks

Start with the [operations runbook](../runbook.md#safety-and-escalation) for
triage and escalation. Follow the linked procedure's prerequisites and
approval requirements before making changes.

| Task | Procedure |
| --- | --- |
| Stage or release an exact candidate, select a staging family or capture its rollback pointer | [Deploy and record the rollback pointer](../runbook.md#deploy-and-record-the-rollback-pointer) |
| Restore a Worker version or rehearse the rollback | [Worker rollback](../runbook.md#worker-rollback) |
| Verify post-cutover health | [48-hour production watch](../runbook.md#48h-post-flip-watch) · [Watch specification](../48h-watch-spec.md) |
| Interpret health or investigate logs and alerts | [Read `/up`](../runbook.md#read-up-without-mistaking-liveness-for-readiness) · [Observability](../runbook-observability.md) · [Alert fingerprints](../runbook-alerts.md) |
| Contain queue failures or handle a database outage | [Queue containment](../runbook.md#queue-containment-drain-and-failed-job-replay) · [Database outage behavior](../runbook.md#neon--hyperdrive-outage-behavior) |
| Verify backup and restore readiness | [Backups and restore drill](../runbook.md#backups-and-restore-drill) |
| Investigate moderator or member join issues | [Moderator guide](../moderator-admin-guide.md) · [Join troubleshooting](../troubleshooting-join.md) |
