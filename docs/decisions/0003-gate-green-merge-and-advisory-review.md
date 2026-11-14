# Decision 0003: gate-green PRs merge without owner approval; CodeRabbit is advisory

- Status: accepted (owner decision, 2026-10-31)
- Deciders: the project owner
- Superseded in part by: Decision 0002 (2026-11-02) on production confirmation

## Context

Shipping velocity and independent release assurance are separate concerns.
Review tooling, meanwhile, varies in reliability: an automated reviewer that
is often rate-limited cannot sit on the critical path of every small fix.

## Decision

A pull request whose required checks are green, and whose review findings
are fixed or answered with evidence, merges without owner approval. The
owner-confirmation rule of 2026-10-31 is superseded by Decision 0002 for
production deploys, which go to the Release Manager instead; this decision's
"no owner approval for routine merges" half stands. CodeRabbit review is
advisory: never post a CodeRabbit command to retry or unblock a review, and
read and answer its threads when they arrive (fixed, rejected with evidence,
or duplicate).

## Why

Routine merges should not wait on one person's queue when the gates and the
review process already did their work. Keeping the automated reviewer
advisory avoids spending a scarce hourly allowance on pings that nearly
always come back rate-limited.

## Provenance

Owner decision recorded 2026-10-31, alongside the review-flow rules in
`CONTRIBUTING.md` ("Verify a change before opening a PR") and `AGENTS.md`.
