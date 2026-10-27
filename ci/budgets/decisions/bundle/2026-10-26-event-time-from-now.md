# 2026-10-26 decision: new event-time-from-now island ceilings 2048/1024 (ported from the monolith)

New fragment `ci/budgets/bundle/event-time-from-now.js.json` carries
`public/islands/event-time-from-now.js` at 2048 raw / 1024 gzip bytes;
no existing ceiling changes. This allocation was recorded on the
feature branch as an edit to the monolith `ci/bundle-budget.json`,
which main deleted in the budget-fragment split, so it is ported into
a fragment during that merge instead of being lost with the file. The
decision record the branch appended to the monolith `$comment` is
preserved verbatim below (leading separator space kept); earlier
history stays frozen in
`0000-legacy-history-through-2026-10-26.md`. The folded-alternative
numbers below describe the event-device-timezone ceiling as it stood
on the branch (2048/1024); that ceiling has since moved independently
on main and is not changed here.

 2026-10-24 event time-from-now (new island): measured 1253/745B raw/gzip; ceilings 2048/1024 = measured x1.25 rounded up (raw to 512B, gzip to 256B), the repository rule and join-widget new-file precedent. A separate file because folding it into event-device-timezone.js (1073/663B against 2048/1024) measured 2282/1132B and would have breached that unchanged ceiling; no existing ceiling moves.
