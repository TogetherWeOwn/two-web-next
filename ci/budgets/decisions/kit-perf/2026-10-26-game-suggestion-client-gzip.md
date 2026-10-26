# Published game suggestions: client gzip capacity

## Current decision

Raise only `client.js.maxGzipBytes` from 102912 to 103168 B in
`ci/budgets/kit/client-js.json`. Main already supplies server gzip 335104 B
(#1826) and client raw 256000 B (#1798); neither is changed here. All other
fragments and the frozen legacy history are unchanged. The fragment loader,
checkers, application, dependencies, assets, file counts and startup allowance
are unchanged relative to main.

Main `0f8fdd17f21abe7d0f7c015001b9415b180efe99` and feature
`7d390f4b8c54e30b0da703c2085530d1876c78f4` merge cleanly to tree
`f7830a2a6042c197ed17696041bf86096998e73d`. With identical locked root/web
dependencies, Node 24.22.1 and npm 11.19.1, two builds per tree through the
canonical checker measure:

| Measurement | Main build 1 / 2 | Combined build 1 / 2 |
| --- | ---: | ---: |
| Server JS raw | 1179526 / 1179528 | 1183170 / 1183170 |
| Server JS gzip | 334041 / 334041 | 334922 / 334923 |
| Client JS raw | 253949 / 253949 | 255698 / 255698 |
| Client JS gzip | 102273 / 102273 | 103034 / 103034 |
| Server / client JS files | 115 / 54 both | 115 / 55 both |

Worker 2551/1219 B raw/gzip and CSS 2833/1006 B across two files are identical
in all four builds. Both main measurements fit. Both combined measurements
fail only client gzip, by 122 B. The proposed 103168 B ceiling leaves 134 B
margin and is the smallest 256-byte-aligned step covering the observation;
it is not a fresh size-times-1.25 allocation or speculative headroom.
Startup is not measured.

ACT: allocate only this measured client-gzip step through independent review.
WHY: the exact feature composition exhausts this axis; main now covers the
other originally breached axes. The earlier shared-component experiment did
not recover the required capacity and was discarded.
UNDO: reviewed revert of this one ceiling and its matching acceptance delta,
retaining earlier decisions and coordinating with the dependent feature.
This is not feature, staging, deployment or release approval. The parent
feature must reverify its actual integrated head through CI and independent
review. See [the full evidence](../../../../docs/game-suggestion-kit-budget.md).

## Historical branch records

The records below are preserved verbatim from this branch's former monolith
history suffix. Their earlier three-axis and two-axis proposals are historical;
the one-axis decision above supersedes them. Main's frozen legacy record is
not edited.

 2026-10-26 decision (published game suggestion assistance): main 91b66a68d2d37bd2c717f3a75299300d3617b811 plus feature 7d390f4b8c54e30b0da703c2085530d1876c78f4 merges cleanly to source tree a51b15238a8a28880fc4e87c7f432e9143fcf81f. Node 24.22.1/npm 11.19.1, identical locked root/web dependencies, two builds per tree through the unchanged canonical checker: pristine main server 115 files raw 1178762/1178764B and gzip 333875/333875B, client 54 files raw 253949B/gzip 102273B both builds; combined server 115 files raw 1182408/1182406B and gzip 334761/334762B, client 55 files raw 255698B/gzip 103034B both builds. Native datalist/hint rendering across board and event create/edit adds client 1749 raw/761 gzip bytes and server 886-887 gzip bytes. A throwaway shared Svelte component still breaches (server raw/gzip 1182115/334766B, client 255652/103162B); it is discarded and changes no product code. Admit only the measured combined capacity: server.js.maxGzipBytes 334080->334848 (+768B, 86B above largest observation); client.js.maxRawBytes 254976->256000 (+1024B, 302B margin), client.js.maxGzipBytes 102912->103168 (+256B, 134B margin). These are the smallest 256B gzip/512B raw boundary steps that fit; this is not a fresh x1.25 allocation or speculative headroom. Worker 2551/1219B, CSS two files 2833/1006B, server raw, all file caps, startup 60000ms, checker, dependencies, original acceptance tests and every unrelated threshold remain unchanged. Incoming limits reject; the proposed limits pass the same restored combined output; reducing any changed cap by one rounding step rejects again. Full pinned evidence, rejected sharing experiment and limits are in docs/game-suggestion-kit-budget.md. This independent budget decision is not feature, staging, deployment or release approval; the feature must reverify its actual integrated head under exact-head CI and independent review. ACT: allocate these three measured byte steps in this standalone PR. WHY: current caps are exhausted and measured shared-component extraction does not recover the native assistance cost; HTML serialization or escaping-boundary changes are not justified solely to chase these bytes. UNDO: reviewed revert of only these three steps and this appended record, retaining all prior history; coordinate with the dependent feature before reverting. 2026-10-26 reconcile (game-suggestion capacity onto main 0141158a01b32d7d6e16901f49a26558583da9c7): main #1779 changed only this history line (1-file diff, numerics byte-identical, zero build-input change); the 91b66a68d-based combined measurements stand; merged-tree build re-verified post-merge under these caps. 2026-10-26 reconcile (game-suggestion capacity onto main 4d9ebeee5): main #1814 restructured the shipping test to explicit server-gzip allocation tiers (no numeric or build-input change); this decision adopts that structure and adds the measured 334848 tier (interval 334762). Sibling #1816 justifies the same tier with its own interval (334683); the first merger sets the test literal and the second reconciles rows while prose cites both measurements. 2026-10-26 reconcile (game-suggestion capacity onto main 0fe4dd903): main #1826 already moved server.js.maxGzipBytes 334080->335104; fresh repeated builds (Node 24.22.1/npm 11.19.1, identical locked root/web dependencies, unchanged canonical checker, two builds per tree) measure pristine main 0fe4dd903 server 115 files raw 1179526/1179528B gzip 334041/334040B, client 54 files raw 253949B/gzip 102273B both builds, and the clean main+feature tree d8fd764d71e1ccfac62843cdc8d24da236009328 (feature 7d390f4b8 unchanged) server raw 1183170/1183172B gzip 334923/334924B, client 55 files raw 255698B/gzip 103034B both builds. The combined server gzip worst 334924B already fits the reviewed 335104 ceiling (180B margin), so the 334848 server step proposed in the record above is NOT taken: taking it would lower the reviewed ceiling. server.js.maxGzipBytes stays 335104 and the shipping test keeps main's supported tiers (334080/335104/335360) unchanged. The combined client still breaches 254976/102912 on both builds (+722/+122B), so only the two measured client steps are retained: client.js.maxRawBytes 254976->256000 (302B margin; 255488 rejects the same built output) and client.js.maxGzipBytes 102912->103168 (134B margin; 102912 rejects). Every other bound unchanged; evidence updated in docs/game-suggestion-kit-budget.md. Not feature or release approval.
