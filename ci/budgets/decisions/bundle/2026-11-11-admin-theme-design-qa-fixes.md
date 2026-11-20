# Kit admin register sheet: design QA fix round

Design QA requested three blocking alignment fixes in `assets/admin-theme.css`
on the exact head `f50b5942e` (PR #2121): clear the browser chrome on
button-styled `<button class="btn">` (border/font reset), keep the
checkbox/radio under its label (width-only override), and render every
timestamp in the kit data font (`.kit-admin time`). All three are mandated
by the design review, not discretionary growth; the sheet grew from the
measured 4059 B to 4120 B raw (1225 B gzip, `zlib.gzipSync` as the checker
measures).

| Asset | Raw | Gzip | Previous ceiling | New ceiling raw / gzip |
| --- | ---: | ---: | --- | --- |
| `public/admin-theme.css` | 4120 B | 1225 B | 4096 B / 1280 B | 4608 B / 1280 B |

The raw ceiling moves to the next 512 B step above the measured bytes per
`ci/budgets/README.md`; the gzip ceiling is unchanged (1225 B fits 1280 B).
Only `ci/budgets/bundle/admin-theme.css.json` changes, with the
`SHIPPING_BUNDLE_BUDGETS` pin in `ci/budget-fragments.test.mjs` updated in
the same commit. No other ceiling changes.
