# actionlint concurrency queue compatibility

Workflow lint builds **patched actionlint v1.7.7**, not the stock release binary.
`build.sh` runs only in GitHub Actions, on the blocking scope → ci-ok path. It
checks the immutable source archive, applies `queue.patch` without fuzz, keeps
upstream go.mod/go.sum unchanged, runs the upstream tests and added parser tests,
builds the CLI, exercises positive/negative CLI fixtures, and lints all original
workflow files. No workflow transformation or diagnostic suppression is used.
The existing `-shellcheck= -pyflakes=` settings are unchanged.

The carried patch adds only a typed pending-queue policy, literal `single`/`max`
parsing and the `max`/cancellation incompatibility check. Existing unknown-key
diagnostic text is retained to keep upstream fixture expectations unchanged;
unknown keys still fail. Both workflow and job scopes use the same parser.
`queue-cases.json` drives parser and actual-CLI checks. Stock v1.7.7 must reject
new valid queue fixtures; patched v1.7.7 must accept them. Both must reject the
legacy invalid controls. Group-expression and unrelated-workflow errors must
still fail the patched CLI. These are offline fixtures, not live queue tests.

Source: [actionlint v1.7.7](https://github.com/rhysd/actionlint/tree/03d0035246f3e81f36aed592ffb4bebf33a03106),
MIT licensed; the archive retains its license. SHA-256 and immutable commit are
pinned in `build.sh`. The Go toolchain is pinned and verified by checksum there;
no downloaded installation scripts run. Module resolution is read-only, uses the
upstream checked-in go.sum and public checksum database, verifies module contents,
and refuses manifest drift or toolchain auto-download. Go has no supported native
release-age filter or blanket build-code refusal: that residual gap is retained,
not represented as an npm-style policy. No module version update or hook exception
is introduced. Builds/tests run only on the Actions runner, without deploy secrets,
not on the shared host. Existing upstream optional external-tool test skips are
not changed or counted as executed coverage.

Retirement: replace this build/patch with a verified immutable upstream release
once its parser accepts these queue literals, rejects the same invalid controls,
and passes the repository's unchanged workflow lint. Keep the queue regression
and native PR smoke. No separate scheduler or upstream contribution is required.

Native semantics: [GitHub concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
`queue: max` retains at most 100 pending entries and cancels the new arrival at
capacity. No FIFO guarantee is assumed. All managed staging entrants use max/false;
the whole qualification lock and candidate revision checks remain mandatory.
Out-of-band provider mutations are outside the managed serialization guarantee.
