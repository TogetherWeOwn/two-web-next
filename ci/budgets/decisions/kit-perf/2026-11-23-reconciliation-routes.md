# Reconciliation fixture route budgets

The Kit build emits both reconciliation pages. Their runtime ownership is
limited to the existing loopback fixture. The inventory uses the exact
manifest IDs, including `[key]` for the detail page. The strict checker found
both missing on main at `2efc496b4620f2de8c6ab27a29db16e96191e157`.
[Trusted main measurement](https://github.com/TogetherWeOwn/two-web-next/actions/runs/45098607329/job/137443979222)

The fixture routes from #2463 and #2516 were measured by the credential-free
Kit build in #2619 at `75d8d45edc1ca2a365a3fa5775636a8076402a56`.
[Hosted route measurement](https://github.com/TogetherWeOwn/two-web-next/actions/runs/45043141445/job/137273069794)

| Kit route | JS raw B | JS gzip B | JS files | CSS raw B | CSS gzip B | CSS files |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `/admin/reconciliation` | 122182 | 48497 | 23 | 11041 | 3240 | 1 |
| `/admin/reconciliation/[key]` | 123296 | 48875 | 23 | 11103 | 3309 | 2 |

The [admission rows](2026-11-23-reconciliation-routes.json) use the original
1.25× byte targets rounded up to 512 B raw and 256 B gzip, clipped to the
corresponding aggregate ceilings. File caps are the measured count plus one,
bounded by the aggregate cap. The CSS byte overages follow the existing
route-check warning behavior. The lower-only proposer retains its stricter
eligibility rules.

The admission only extends the inventory. Undo by reverting the live rows,
admission and replay change together, after reverting any subsequent decisions
that depend on the expanded inventory.
