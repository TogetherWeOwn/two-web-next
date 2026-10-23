# Kit server shell compression

Measured 2026-10-22 and rechecked 2026-10-23. This is a prerequisite for [the Logo 1 theme](https://github.com/TogetherWeOwn/two-web-next/pull/1607), not approval of that feature or a deployment.

## Current decision: group the shared error shell too

Co-group `src/brand-lockup.ts`, `web/src/lib/SiteHeader.svelte` and `web/src/lib/ErrorShell.svelte` in the **SSR environment only**, named `site-shell`. Default recursive dependency handling also includes the existing `Shell.svelte`, footer, metadata, error-copy helpers and Svelte server runtime. These modules define renderers, constants and functions; no request, session or database read is added. Preserve every existing admin/events group, conservative minification, constructor names and legal comments. No renderer source, artwork, acceptance test, budget or client configuration changes.

The original header-only group passed on the original baseline below, but after main was incorporated into PR #1659 at `9bd639f31661c4209d19c1367dd9aca629e56584`, its server gzip reached **327889B** in CI against **327680B**. The incorporated main `62abf8c28d216771950490b406560f2a154d51b2` passed `check` and `ci-ok` ([run](https://github.com/TogetherWeOwn/two-web-next/actions/runs/39929451711)); its server gzip measured 327647B in that CI run. This is a branch-specific compression regression, not a flaky test or main-red. No further main merge, rebase, budget increase or CI rerun is part of this repair.

Two clean locked builds with Node 24.22.1 and npm 11.19.1 reproduce the failure, then pass after adding only `ErrorShell.svelte` to the group and renaming it:

| Tree | Server files | Server raw B, builds 1 / 2 | Server gzip B, builds 1 / 2 | Existing gzip ceiling B | Checker exits |
| --- | ---: | ---: | ---: | ---: | --- |
| Current PR, header-only | 124 | 1114024 / not captured | 327890 / 327889 | 327680 | 1 / 1 |
| Current PR, shared shell | 122 | 1113404 / 1113404 | 327660 / 327658 | 327680 | 0 / 0 |
| Frozen theme + shared shell | 120 | 1121798 / 1121796 | 329430 / 329431 | 330240 | 0 / 0 |

The current fix saves **230 / 231B** relative to its red PR head, leaving only **20 / 22B** margin. The second before-build gzip value comes from its separate checker log; both fixed emitted-render comparisons deliberately use the preserved first before-build (327890B), so their JSON inventories repeat that control value. It is not claimed as a reduction from pristine current main: the first fixed build is 13B larger than main's CI measurement (not a paired local comparison). The frozen theme head remains `414f01aeb4eaba9f4a5b87e79e3c0f8935a07356`; a fresh unmodified build measures **330410B** and fails, corroborating the original two-build red proof below. The updated grouping leaves **809B or more** under that theme's unchanged ceiling. File caps, raw-byte limits and all other budgets stay unchanged.

For both fixed builds, all client JS/CSS path/SHA-256 entries and Worker entry bytes match their corresponding before tree. Current client JS is 53 files, 249333/100464B raw/gzip; CSS is 2 files, 2737/983B. Frozen-theme client JS is 52 files, 252164/100694B; CSS is 1 file, 3490/1056B. Worker stays 2551/1219B in both families.

The emitted renderer comparison imports each tree's own exported `render`, `Shell` and `ErrorShell`, never a separately compiled source substitute. It compares head/body bytes for 12 shell states and both ordinary/admin-back variants of every supported error status: **28 states on current PR, 26 on the frozen theme**, repeated against both fixed builds. The frozen theme predates the 422 shell; an initial harness attempt to render unsupported 422 there threw, so that invalid fixture was removed only from the scratch comparator, not from any acceptance test. A missing scratch `devalue` resolution was corrected by linking the locked Kit install; neither harness failure is counted as passing evidence. Existing `ci/check-kit-perf.test.mjs` passes 13/13. Full-check results are reported separately in the PR, without inferring green from this targeted proof.

Final grouping attribution, current PR build 1 versus its preserved header-only control:

| Emitted server file | Raw delta B | Gzip delta B |
| --- | ---: | ---: |
| New `chunks/site-shell.js` | +62745 | +20188 |
| Removed `chunks/site-header.js` | -28258 | -8981 |
| `chunks/admin.js` | -25884 | -8505 |
| Removed `chunks/ErrorShell.js` | -4716 | -1579 |
| Removed `chunks/Shell.js` | -3946 | -1309 |
| Other files, net | -561 | -44 |
| **Total** | **-620** | **-230** |

The admin delta is relocation of already-bundled shared dependencies into the recursive shell group, not removal of admin behavior or an admin-route runtime proof. Existing budget selftests were re-run on the final configuration (6/6); the historical Workerd smoke below was not. No admin-route or native-Kit browser result is inferred from it.

This co-compresses shared server markup instead of keeping `Shell.js`, `ErrorShell.js` and the header runtime in separate gzip streams. The same anchored rule still captures the future Hono artwork constants. No route is transferred to Kit; no browser, staging, production or visual-baseline claim is made by these emitted-byte comparisons. Reproduce with the clean-build procedure below, applying the final `web/vite.config.ts` to each frozen source tree. Revert that configuration change to undo the optimization.

## Original header-only decision (superseded)

The following 2026-10-22 measurements document the original header-only trial, not the final `site-shell` output.

Co-group `src/brand-lockup.ts` and `web/src/lib/SiteHeader.svelte` in the **SSR environment only**. The first module arrives with the theme; the second already exists on main. The two representations carry the same artwork but otherwise occupy separate gzip streams. Keep Rolldown's default recursive dependency handling, all existing admin/events groups, conservative minification, constructor names and legal comments.

No renderer, artwork, gradient ID, route, acceptance test, byte ceiling, file cap or startup limit changes. Client chunking is not configured by this change. This is compression placement, not removal of either renderer's content.

### Historical locked clean-build evidence

Node **24.22.1**, npm **11.19.1**, the committed root and web lockfiles, `npm ci --include=dev`, `npm run build --prefix web`. Each row contains two builds after removing the owned `web/.svelte-kit` output. The checker sums `gzipSync(bytes).length` **per emitted JS file**, with Node's default gzip options; it excludes source maps.

- Main baseline: `d1e3def9c0941ad231075079434beb4b4d92cbf7`.
- Frozen combined baseline: `414f01aeb4eaba9f4a5b87e79e3c0f8935a07356`.
- Modified trees: the same sources plus only this PR's `web/vite.config.ts` change.

| Tree | Server files | Server raw B, builds 1 / 2 | Server gzip B, builds 1 / 2 | Existing gzip ceiling B | Checker exits |
| --- | ---: | ---: | ---: | ---: | --- |
| Pristine main | 122 | 1102572 / 1102572 | 324076 / 324078 | 327680 | 0 / 0 |
| Main + header group | 122 | 1102802 / 1102802 | 324327 / 324329 | 327680 | 0 / 0 |
| Frozen combined | 122 | 1122434 / 1122434 | 330409 / 330412 | 330240 | 1 / 1 |
| Combined + header group | 122 | 1122778 / 1122780 | 330149 / 330149 | 330240 | 0 / 0 |

The main-only tradeoff is **+251B gzip** in these paired builds. The combined improvement is **260 / 263B gzip**, turning the 169 / 172B breach into **91B headroom**. This margin is deliberately reported as small, not a new growth allowance. Identical-source server rebuilds have several bytes of hash/global-ID variation; an earlier header-group build measured 330145B. Future source or dependency growth still fails closed and needs its own review. The change is not claimed as a main-only byte reduction.

### Growth attribution before the fix

Combined versus pristine main, build 2:

| Emitted server file | Raw delta B | Gzip delta B |
| --- | ---: | ---: |
| `chunks/admin.js` | +13007 | +4336 |
| `chunks/Shell.js` | +6713 | +1966 |
| `chunks/internal.js` | +142 | +35 |
| Other manifests/nodes/chunks, net | 0 | -3 |
| **Total** | **+19862** | **+6334** |

Grouping moves the compiled Svelte header and its existing server rendering dependencies into `chunks/site-header.js`, alongside the theme's Hono SVG constants. The old `chunks/server.js` contents move into that group; neither the aggregate file count nor a client import grows. Hono `admin.js` and Svelte `Shell.js` import the shared group. The matched header source has only a type import; the artwork module exports constants. The date, request, database and session modules are not targets of the rule.

### Client, CSS and Worker controls

Every JS/CSS path and SHA-256, plus the Worker entry SHA-256, matches the corresponding **unmodified** baseline in both final builds. Cross-tree comparisons are not claimed: the theme itself already changes the client and CSS.

| Tree family | Client JS files | Client JS raw / gzip B | CSS files | CSS raw / gzip B | Worker raw / gzip B |
| --- | ---: | ---: | ---: | ---: | ---: |
| Main, before and after | 52 | 245468 / 98721 | 1 | 2660 / 891 | 2551 / 1219 |
| Combined, before and after | 52 | 252164 / 100694 | 1 | 3490 / 1056 | 2551 / 1219 |

Both keep server raw below 1203200B and server files below 123. The combined candidate uses its own previously reviewed client/CSS ceilings; this prerequisite does not copy those ceilings onto main.

### Historical behavior evidence and limits

These rows describe the superseded 2026-10-22 header-only trial. Its Workerd smoke was **not re-run on the final grouping** and is not current runtime evidence. Current emitted-render/hash proofs and freshly run budget selftests are reported above; current lint/typecheck/full-check results are reported in the PR separately.

- Directly imported the **emitted** `Shell.js` and its own emitted SSR `render` function, before and after, on both main and combined trees. Head and body are byte-identical across **12 states per tree**: all six themes, member navigation, active event navigation with an encoded return path, leaderboard navigation, hidden account, supplied account snippet and inlined content CSS. No source-only compiler harness substitutes for these chunks.
- Started each adapter-generated Worker in local Workerd with fixture variables, no live credentials and no database. `/about`, `/faq`, `/rules` and `/privacy` each returned 200. Before/after HTML bytes and response headers match on both trees, excluding only Date and request-ID headers. **These responses had no Kit renderer marker, so this smoke proves the Hono fallback and shared chunk initialization, not native Kit route ownership.** An initial `/admin` probe returned a baseline 500 under incomplete fixture configuration; it is not counted as a passing admin test.
- The Node default loader cannot import `cloudflare:workers` for a direct full-server probe. The emitted shell proof above instead imports only the pure renderer chunks. No runtime module, production source or loader configuration was changed to make that proof pass.
- Unchanged budget selftests: 6 passed; `node --test ci/check-kit-perf.test.mjs`: 13 passed, none skipped. Root lint and typecheck passed during the configuration investigation; final checks are recorded in the PR.
- No page styling or content is changed. No visual baselines are updated. The theme's archive-image acceptance loop and its exact-head CI, browser checks and independent review remain required. No staging or production action is claimed here.

### Historical alternatives measured and discarded

A broader group containing both complete shells measured 330448B combined gzip. Grouping the pure about/privacy/rules content measured 330755B. Both were worse, and neither is in the diff. Shortening artwork IDs was excluded: it changes supplied artwork identifiers and the prior diagnostic saving was insufficient. A ceiling increase was unnecessary once the narrow header grouping passed; every budget is unchanged.

## Reproduce

Use the same Node version and frozen SHAs above, with clean source directories extracted by `git archive <sha> | tar -x -C <owned-scratch-dir>`. Install the corresponding root/web lockfiles with `npm ci --include=dev`; external dependency directories may be symlinked when the execution environment requires that. Do not change the lockfiles or use dependencies from an unrelated install.

For each tree, remove only its owned generated `web/.svelte-kit` directory, then run twice:

```sh
npm run build --prefix web
node ci/check-kit-perf.mjs
```

For the modified combined tree, apply only this PR's Vite configuration diff, not main's budget file. Compare all `*.js` and `*.css` paths and SHA-256 hashes under `web/.svelte-kit/output/client/_app`; compare `web/.svelte-kit/cloudflare/_worker.js` separately. Sum each server file's default Node `gzipSync` length, not gzip of concatenated files or only the adapter entry. The attached engineering evidence includes per-file inventories and the emitted-shell comparison script.
