# Moderator attendance fixture route budget

The Kit build emits `/admin/attendance` even with the runtime fixture off.
Hosted CI measured the route on PR #2770 at
`71409d05a13069db70625b27811d65d949eee88c`.
[Hosted route measurement](https://github.com/TogetherWeOwn/two-web-next/actions/runs/45523799645/job/138906652961)

| Asset | Raw bytes | Gzip bytes | Files |
| --- | ---: | ---: | ---: |
| JS | 123044 | 48416 | 21 |
| CSS | 11914 | 3586 | 2 |

The [admission](2026-11-24-attendance-route.json) follows the reconciliation
decision. Byte targets are measured size times 1.25, rounded up to 512 bytes
raw and 256 bytes gzip, capped at the aggregate ceilings. File targets add
one to the measured count. CSS byte overages follow the existing advisory
behavior. This adds one route row and preserves all existing ceilings and
standalone ratchet checks.

Undo by reverting the attendance row and its replay admission together
after reverting any later decisions that depend on the expanded inventory.
