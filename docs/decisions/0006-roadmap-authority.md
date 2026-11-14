# Decision 0006: `ROADMAP.md` is the public direction entry point, not a tracker

- Status: accepted (owner docs-pilot authorization, 2026-11-10)
- Deciders: the project owner (docs-pilot authorization, 2026-11-10), implemented by the roadmap entry pull request (2026-11-09)
- Entry point: [website roadmap](../../ROADMAP.md)
- Scope: this repository only

## Context

The website's direction lived across an internal task tracker and assorted
repository documents. A fresh reader could not tell which source described
approved direction, which described proposals, and which described history.

## Decision

`ROADMAP.md` at the repository root is the public entry point for direction:
approved direction, the accepted Ember Hours scope, explicit non-goals, and
links to the milestone specs and plans. It is not a delivery schedule and
not a task tracker. Priorities, assignments and live status stay in the
internal planning system; durable product and engineering knowledge lives in
the repository.

This record applies to this repository only. Whether other projects adopt
the same entry point remains an open owner question; no company-wide rule
is established by this record.

## Why

A repo-only reader must be able to resume the work from the repository
alone, without instructions in an external system. The roadmap gives that
reader the direction and the boundaries; the tracker remains canonical for
live work, but no decision should exist only in a tracker description.

## Provenance

Owner authorization for the repository-only docs pilot on 2026-11-10 (each
project must be understandable and resumable from its git repo alone).
Implemented by the public roadmap entry pull request of 2026-11-09.
