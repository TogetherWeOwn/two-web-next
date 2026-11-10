# Admin save baseline history binding

The new `public/islands/admin-save-baseline.js` binds each moderator edit history
entry to its originally displayed saved-version digest. Back restoration must not
pair losing draft text with a fresh GET's token. It stores only the record path
and digest, preserves unrelated history state, and restores that digest before
submit. If history binding fails, the server's missing-token response retains
the draft rather than permitting an unverifiable overwrite.

Measured from the Actions-generated asset in
[recovery proof run 42779302366](https://github.com/TogetherWeOwn/two-web-next/actions/runs/42779302366)
for source head `b8215f432f89ffdd293ac57776d99ae4a56c7da1`:

| Asset | Raw | Gzip | Previous ceiling | New ceiling raw / gzip |
| --- | ---: | ---: | --- | --- |
| `public/islands/admin-save-baseline.js` | 612 B | 350 B | Not previously served | 1024 B / 512 B |

The allocation follows `ci/budgets/README.md`: measured bytes × 1.25,
rounded up to 512 B raw and 256 B gzip. Asset SHA-256 is
`bea394fe515cbd46a31b2a1dbe6d6448ba484ca82c3b044f8a76a6f4859822d6`.
The artifact was produced on the PR merge ref; the authored source matches the
named head. CI still checks deterministic minifier output on the final head.
No existing ceiling changes, including the departure controller's 2048 B raw /
1024 B gzip limits. This separate island owns history binding; the existing
controller continues to own departure and session-expiry recovery.
