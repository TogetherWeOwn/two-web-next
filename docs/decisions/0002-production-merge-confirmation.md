# Historical decision 0002 · Production merge confirmation

On 2026-11-02 the project owner required fresh, exact-head Release Manager
confirmation for each merge to `main` and each production deploy. The merge
path was treated as a production release. The confirmation tied the independent
reviewer's decision to the bytes that would ship and superseded the October 31
owner-confirmation rule.

The current [merge and staging policy](../../CONTRIBUTING.md#merge-and-production-staging-evidence)
and [production release gate](../../CONTRIBUTING.md#production-release-gate)
govern current work. Ordinary PRs follow their merge gates and promotion-path
routing. Protected production execution requires separate exact-candidate
qualification and independent approval.
