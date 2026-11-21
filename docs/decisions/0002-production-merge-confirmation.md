# Decision 0002: merges to `main` deploy production and need exact-head Release Manager confirmation

- Status: accepted (owner decision, 2026-11-02)
- Deciders: the project owner (decision); the Release Manager (confirmation role)
- Supersedes: the earlier owner-confirmation rule of 2026-10-31

## Context

This repository is the Together We Own website served by a Cloudflare Worker,
and a merge to the default branch `main` reaches production through the
repository's release path. Release assurance therefore cannot be left to the
same queue that ships code: someone independent of the author, pinned to the
exact candidate head, must confirm production steps.

## Decision

Every merge to `main` — which deploys production — needs a fresh, per-PR
`request_confirmation` approval from the Release Manager, bound to the exact
head SHA that merges. Every other production deploy needs the same
confirmation. Any new push to the branch yields a new head and therefore
requires a new confirmation.

## Why

The author who just landed a head cannot be the check on whether that exact
head may reach production. Binding approval to the reviewed head makes the
confirmation meaningful: bytes reviewed are bytes released, and a changed
head is a new decision, not a carryover.

## Provenance

Owner decision recorded 2026-11-02; it superseded the earlier owner
confirmation of 2026-10-31. The repository's own merge record reflects the
rule in `CONTRIBUTING.md` ("Definition of done" and the release-flow
section) and `AGENTS.md`.
