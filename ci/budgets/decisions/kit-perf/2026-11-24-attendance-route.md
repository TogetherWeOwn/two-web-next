# Moderator attendance fixture route budget

The Kit build emits `/admin/attendance` with the runtime fixture off. Hosted CI
measured it at `71409d05a13069db70625b27811d65d949eee88c`. [Hosted measurement](https://github.com/TogetherWeOwn/two-web-next/actions/runs/45523799645/job/138906652961)

| Asset | Raw bytes | Gzip bytes | Files |
| --- | ---: | ---: | ---: |
| JS | 123044 | 48416 | 21 |
| CSS | 11914 | 3586 | 2 |

The [admission](2026-11-24-attendance-route.json) rounds 1.25× measured bytes up
to 512 B raw and 256 B gzip, capped by the aggregate. File caps add one to the
measured counts. Existing caps and CSS advisories stay in force.

Undo by reverting dependent budget decisions first, then revert the preview
and its budget admission together. Keep the budget row while the build
still emits `/admin/attendance`, even when its runtime flag is off.
