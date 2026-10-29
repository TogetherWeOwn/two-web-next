# Featured stale-save composition on current main

GitHub reported this feature branch as conflicting. Integrate current main
`e2590f419` before measuring; do not reserve headroom on the older base.
This feature PR carries its server-size allowance, decision and boundary
proofs together. No runtime, staging, Lighthouse or other class-A limit changes.

## Locked measurements

Node 24.22.1 / npm 11.19.1; `npm ci --include=dev` in both package roots,
then `npm run build --prefix web` and `node ci/check-kit-perf.mjs`.
The pristine-main tree uses the identical root and web lockfiles and the same
installed dependencies. Gzip totals are the checker's sum per file, not gzip
of concatenated output.

| Tree | Build | Server files | Raw bytes | Gzip bytes |
| --- | --- | ---: | ---: | ---: |
| Pristine main `e2590f419` | 1 | 116 | 1202522 | 336737 |
| Current main plus this feature | 1 | 116 | 1205381 | 337600 |
| Current main plus this feature | 2 | 116 | 1205381 | 337601 |

Pristine main fits its 1203200 raw / 337152 gzip ceilings. The combined tree
does not: worst overages are 2181 raw and 449 gzip bytes. The feature's net
footprint is +2859 raw / +864 gzip bytes. Identical-tree gzip variation is
1 byte and is disclosed, not treated as a separate feature cost.

## Cause and scope

The combined server delta is concentrated in `chunks/admin.js`: +2809 raw /
+861 gzip bytes for the saved-content/incarnation baseline, committing-lock
comparison, preserved conflict form, and conflict history/session controllers.
The existing JSON fallback-zone correction contributes 26 raw bytes each in
`chunks/events.js` and `chunks/src.js`. Remaining differences are generated
manifest/import hashes and a two-byte instance-name variation. The main-side
profile presentation extraction and shared date formatter remain intact.

The source merge adds only main's operator-overrides import/route in admin;
no duplicate import, new dependency or unrelated feature implementation was
introduced in this resolution. Product source and owned stale-save acceptance
files are unchanged from the previous feature head, apart from incoming main.

Client JS is 53 files, 258314 raw / 103266 gzip bytes, within main's unchanged
258560 / 103680 limits. Pristine-main client is 258144 / 103202. Worker and
client CSS are unchanged. Server raw/gzip are the only adjusted axes; server
file count, client budgets, served assets, startup and all class-A limits stay
unchanged.

## Smallest allowance and boundary proof

Relative to current main, `server.js.maxRawBytes` moves 1203200 -> 1205760
(+2560 bytes, **0.213%**). The next lower 512-byte step, 1205248, rejects the
measured output by 133 bytes. New margin: 379 bytes.

`server.js.maxGzipBytes` moves 337152 -> 337664 (+512 bytes, **0.152%**).
This retains the feature branch's prior ceiling rather than adding a new step
on top of it. The lower 256-byte step, 337408, rejects by 193 bytes. New worst
margin: 63 bytes. Both total raises are below the 0.5% size-proxy cap.

Main's same-head a11y, Lighthouse, browser-smoke, staging-quality and
staging-journeys checks were successful when this allowance was measured;
there was no red class-A check. Draft-skipped feature checks are not runtime
proof. Full non-draft CI and independent exact-head review remain mandatory.

Both shipping oracles keep the earlier allocations and main's coupled
host/join client allocation. The new raw allocation uses fixed measured,
exact-fit and one-byte-over literals; the fragment oracle rejects adjacent
or unadmitted raw limits and file-count drift. Historical server-gzip
allocations remain admitted, including main's 337152 host/join measurement.

Undo: revert the server fragment delta, its new raw allocation proofs and this
record together with the feature. No standalone budget PR is needed. This is
pre-merge size evidence, not deployment or staging acceptance.
