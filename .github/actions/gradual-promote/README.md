# Gradual promotion: caller verification

The existing 5 → 50 → 100 rollout, smoke/error-rate gates and recorded-target
rollback remain unchanged. Callers may add a fresh recovery check **immediately
before each** `wrangler versions deploy` invocation:

```yaml
with:
  pre-promotion-verifier: ops/verify-recovery.mjs
  require-pre-promotion-verifier: "true"
  pre-promotion-timeout-seconds: "120"
```

Recovery-dependent callers must set `require-pre-promotion-verifier: "true"`.
The default is false with an empty path, preserving non-opted-in callers. A
nonempty path runs even when the requirement flag is false. Invalid boolean or
timeout configuration fails closed, not as an opt-out. The timeout is an integer
from 1 to 300 seconds per invocation (default 120), plus at most five seconds
for the local Git tracking check. Git runs asynchronously in its own process
group; timeout/cancellation hard-kills that group and refuses verification,
including when Git ignores SIGTERM or leaves descendants holding output pipes.
Success is checked against a monotonic deadline,
not merely a timer callback. Configured verification requires a POSIX runner
(Linux/macOS process groups); Windows refuses before the first mutation rather
than attempting unsupported group termination. Non-opted-in callers are unchanged.

## Module contract

The verifier must be a tracked, regular `.mjs` file in the caller's checked-out
`GITHUB_WORKSPACE`. Paths are repository-relative ASCII components containing
letters, numbers, dots, underscores or dashes; absolute paths, empty components,
`.` / `..`, `.git`, and symlinks in any component are rejected. A configured
missing/untracked module fails. The action rechecks the path at every stage.
It uses the runner's Node executable with an argv array, **no shell or eval**.
No package installation or executable bit is needed.

The module receives these flag/value pairs:

| Flag | Meaning |
| --- | --- |
| `--candidate-version-id` | Exact resolved lowercase Worker UUID |
| `--candidate-tag` | Validated uploaded candidate tag |
| `--worker-name` | Intended Worker script |
| `--account-id` | Intended Cloudflare account |
| `--environment` | `production` |
| `--percentage` | Intended next mutation: `5`, `50`, or `100` |
| `--previous-version-id` | Original recorded rollback UUID, never the current split |

The working directory is the workspace root. The module inherits the step's
environment, including credentials already authorized by the caller workflow;
there is no arbitrary command-string or extra-argument input. Caller-specific
custody configuration/credentials belong in the caller workflow's environment.
This is **trusted repository code**, like the existing caller smoke checker,
not a sandbox for untrusted PR code. Use a reviewed exact checkout and serialize
production promotion in the caller. Do not modify the checkout during promotion.

**Exit 0 means fresh, complete, affirmative evidence for this exact tuple.**
The caller must retrieve its archive anew, validate attestation/digests, and
qualify recovery against the current environment for every invocation. Unknown,
empty, stale or mismatched evidence must exit nonzero. The action cannot infer
custody or qualification from an arbitrary module; a no-op is not a recovery
implementation. This interface supplies neither Release Manager acceptance nor
permission to bypass changed-secret 10220, recreate resources or alter secrets.

Module stdout/stderr and exception details are suppressed to avoid logging
recovery material. Record only non-secret evidence through the caller's existing
approved evidence mechanism. Timeout, signal, startup error or nonzero exit
fails the promotion step before Wrangler. The module process group is killed
on timeout/cancellation and cleaned up after exit; detached background work is
not supported. A failure at 50/100 leaves the earlier traffic change subject to
the existing bounded automatic rollback to the originally recorded version;
the job remains failed and subsequent promotions are skipped. Existing smoke,
error-rate, rollback-retry and cancellation guards are not replaced.

## Immutable adoption

Adopt only a reviewed, reachable immutable snapshot under the existing publisher
contract. Inventory **every** action/helper/document file (including
`pre-promotion-check.mjs`), retain complete SHA256 hashes and append-only
source-to-snapshot provenance, and synchronize any approved consumer mirror.
Never move historical tags or rewrite old source mappings. Source delivery is
not consumer adoption, recovery qualification or production release acceptance.
