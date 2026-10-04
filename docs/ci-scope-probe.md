# Documentation-only CI probe

This temporary pull request verifies the change-gated CI introduced in PR #473.
Documentation-only changes should skip heavy suites while `check` and `ci-ok`
report success. Close this probe after recording the result; do not merge it.
