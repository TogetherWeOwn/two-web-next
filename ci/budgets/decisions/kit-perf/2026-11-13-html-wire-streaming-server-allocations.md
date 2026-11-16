# HTML wire streaming: server raw and gzip allocation

The HTML compression fix (TWO-7591) adds `src/html-stream.ts` and calls it
from `src/route-ownership.ts` (`decorateKitResponse`). The helper reaches the
Kit server bundle and measures 1234582 raw / 344075 gzip server bytes on the
exact-head `d020bf0e1` `check` job (run 43343222288, which failed only at the
`kit perf budget` step on both axes). This file records the least-cover
raises to 1234944 raw / 344320 gzip. No shipped product code is removed and
no other ceiling or gate changes.

## Why the growth is intentional

The 1233920 ceiling was allocated for the content display face leaf growth
(see [2026-11-11-content-face-server-raw.md](2026-11-11-content-face-server-raw.md)).
The new bytes are `withStreamedBody` plus its dispatch seam: staging
Lighthouse shows every `text/html` response uncompressed while CSS/JSON are
encoded, because a declared `Content-Length` gets the `cache-control:
no-transform` untransformable-body marker at the edge. Re-wrapping the HTML
body as an unknown-length stream removes the marker so the platform's own
br/gzip negotiation applies; the Kit dispatch path needs the same wrap
inside `decorateKitResponse`, which is why the bytes land in the server
bundle. This is a measured, reviewed product fix, not drift or unbounded
relaxation.

## Measurements

Exact-head Actions CI measured the composed build:

- Head `d020bf0e1` (run 43343222288, job `check`): `server js: raw
  1234582B over 1233920B` and `server js: gzip 344075B over 342272B`,
  the only `check` failure on that head. The next steps 1234432 raw and
  344064 gzip reject by 150 and 11 bytes, so 1234944 and 344320 are the
  least cover on both axes.
