# Operator panel — final requested-width fixture captures

Rendered source: `dcf95d35c3951196b77697e17ab7130045e1169a`. This evidence-only addition changes no application, test, fixture, stylesheet, threshold or dependency bytes. These are local synthetic fixtures, not staging or production records.

The [existing design contract](../README.md) is unchanged: control-token holders inspect a read-only record and epoch; reload with an approved in-memory bearer-header client; no token form, browser credential store or dashboard write path. Standard admin typography/layout and scoped wrapping remain. Required states are populated, empty, upstream unavailable and bearer refused.

A scratch-only copy of the existing accessibility driver selected those four scenarios and used the requested **390×844 mobile** and **1280×800 desktop** viewports. It launched the real bundled Worker with current assets and the repository's schema-isolated fixture lifecycle. The tracked driver, coverage matrix and its normal 154-scan viewports were not changed. All eight HTTP/status/content/CSS and axe checks passed; the deliberate axe-negative control also ran. Every image below was opened and inspected. Full-page image height may exceed the viewport. No visible horizontal overflow was observed; setting keys wrap within the mobile table.

| State | Desktop | Mobile |
| --- | --- | --- |
| Populated record | [200](populated-desktop.png) | [200](populated-mobile.png) |
| No overrides | [200](empty-desktop.png) | [200](empty-mobile.png) |
| Upstream unavailable | [503](unavailable-desktop.png) | [503](unavailable-mobile.png) |
| Control bearer refused | [401](refused-desktop.png) | [401](refused-mobile.png) |

[Machine-readable browser report](report.json). The [before-state and historical after captures](../README.md) remain preserved at their original source scope. These evidence images are not pinned visual regression baselines; no baseline was regenerated or accepted.

## Other current-source evidence and limits

- Mobile `npm run lighthouse`: exit 0; 8 URLs × 3 runs, 24 samples and unchanged assertions processed. Desktop `npm run lighthouse:quality`: exit 0; 24/24 reports and unchanged assertions processed. These gates cover the ordinary Hono fixture routes, not the bearer panel itself.
- The complete configured Vitest file census has 1,209/1,209 nonduplicated completion receipts: 25,138 passed, 9 failed, 676 existing pending/skipped cases. This combines the previous completed shard with bounded groups and explicitly completed file receipts; it is **not a single green `npm run check`**.
- Six failures are authenticated Git-baseline fetch fixtures in `test/workflow-migration-auth.test.ts`, reproduced on pristine main. Three are release-script subprocess/timing failures: two in `test/release-workflow.test.ts` and one in `test/release-promotion-proof.test.ts`. Pristine main reproduces the release selftest timeout and provenance subprocess timeout; the historical-release timeout did not recur there. Source/fixture files match main, but no flake waiver or universal root-cause claim is made.
- A fresh read-only local review verified no blocking correctness defect. Deferred minor: intentional empty-string cells are blank and ordinary table styling collapses distinctions in whitespace-sensitive string values. That local review did not independently reopen these PNGs or execute the whole suite and is not hosted approval.
- Full local check remains red. Exact ready-head full CI, independent Paperclip 5/5, pinned visual comparisons and authorized staging verification remain required. No merge, deployment, credential or production-probe claim.

The initial quality attempts and their failures are preserved separately: a missing real `ps` utility on PATH broke mobile teardown; that owned orphan occupied the fixed port and the first desktop attempt failed with 0/24 reports. Adding the existing real process utility and stopping only the proven owned orphan allowed the clean complete commands above. No host installation, process stub, audit weakening or threshold change was used.
