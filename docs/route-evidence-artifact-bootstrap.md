# Route evidence artifact bootstrap

[CI](../.github/workflows/ci.yml) wires a synthetic producer and a separate
admission job into `ci-ok`. The producer runs only reviewed fixture code; the
consumer independently binds the live PR head (H), checks the current run and
attempt, compares the reviewed fixture digest, and validates the artifact as
bounded data. Only the uploader's actual ID and digest select the archive.
Run-level artifact metadata corroborates that association; it does not identify
which job uploaded an artifact. `ci-ok` requires admission from its own run
and attempt. If a partial rerun reuses the producer or admission result, rerun
all jobs.

An ordinary PR run uses the pinned merged helper revision, not the candidate
checkout. Its success exercises the wiring but does not authenticate the caller.
A protected invocation needs a separately activated organization rule pinned to
the reviewed, merged workflow revision (W). Verify that the provider supplies W,
that both jobs check out W rather than H or the preparation helper revision, and
that the protected run refuses substituted or missing evidence. A green check
name alone does not verify enforcement.

All PRs, including drafts and docs-only changes, need successful synthetic
admission. Merge-group runs still execute existing CI gates but fail route
admission and `ci-ok` until a reviewed group-source binding exists. Push,
schedule and dispatch runs retain their existing gates and supply no admission.
No synthetic run establishes real route parity, enables a completion
declaration, or clears API-10 retirement. Real admission still needs isolation
of candidate execution from the trusted supervisor and upload outputs.
