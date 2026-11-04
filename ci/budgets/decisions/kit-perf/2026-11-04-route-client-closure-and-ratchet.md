# Route client dependency closures and a lower-only measured ratchet

Decision: add hard per-route immutable JS/CSS ceilings without raising any
existing aggregate or served-asset ceiling. This is a measurement/gate change,
not permission to remove product, content, accessibility, design or tests for
bytes. Headroom restoration that would raise an existing ceiling is not included.

Undo: revert this PR's checker, build-evidence generation, route budget and
ratchet workflow through a reviewed PR; preserve the existing aggregate and
served-asset gates. Automation itself never raises a ceiling or merges a PR.

## Reproduction and baseline

Measured source: main `10099ce45e7f6a4f1ade945bbbca85278982109e`, Node 24.21.0,
locked SvelteKit 3.1.0, Vite 8.3.5 and adapter-cloudflare 8.0.1.

```sh
npm ci --include=dev
npm ci --prefix web --include=dev
npm run build --prefix web
node ci/check-kit-perf.mjs --format json
node ci/check-kit-route-perf.mjs
node --test ci/check-kit-route-perf.test.mjs ci/kit-client-ratchet.test.mjs
```

The pre-existing checker measured JS **261,250 raw / 104,332 gzip B**, 54 files;
CSS **2,861 raw / 1,019 gzip B**, 2 files. Ceilings remain JS
261,632 / 104,448 B / 55 files and CSS 3,072 / 1,280 B / 4 files.
These bytes do not change in this PR. The default headroom targets are JS
326,656 / 130,560 B and CSS 3,584 / 1,280 B. Thus aggregate JS lacks
65,024 raw / 26,112 gzip B of default target headroom, and CSS lacks 512 raw B.
Those shortfalls are reported, not silently converted into increases.

## What a route measurement means

`web/.svelte-kit/output/client/.vite/manifest.json` supplies emitted assets,
static imports, dynamic imports and route CSS. During the token-free build,
`ci/kit-route-evidence.mjs` serializes the real Kit server manifest's route IDs,
bootstrap, layout/error/leaf node indexes and node count to JSON. The checker
never executes a manifest. SHA-256 bindings catch mismatched manifest evidence.

For each page, count the cold-cache union of bootstrap, its actual layouts
(including resets), error boundaries and leaf node; follow both static and
dynamic dependencies recursively and include their CSS. Deduplicate by emitted
path, including cycles. Charge shared dependencies in full to each route that
can need them. Only the generated app router's dispatch edges to *other* page
nodes are excluded: navigating to another route is charged to that route and
also covered by the unchanged aggregate gate. Other dynamic imports, including
runtime startup and the error template, are included conservatively whether or
not a particular visit executes them. This is an upper dependency closure, not
a claim about first-request network timing, compressed concatenations or cache
reuse. Gzip is summed per emitted file, with Node's existing gzip defaults.

Inventory includes all Kit route IDs, even gated routes and endpoint-only
routes. Endpoint-only `/events` and `/[...path]` have zero **Kit immutable**
client cost; zero is not a claim about Hono responses or islands. Legacy
`public/` assets, inline scripts/styles, fonts and response HTML remain outside
this metric and under the independent existing served-asset, payload and page
quality gates. Missing/extra source, built or budget routes; unowned JS/CSS;
missing chunks; symlinks; malformed lists/indexes and orphan graph chunks refuse
enforcement (exit 2), rather than returning pass. A measured breach exits 1.

REA angle: source-first inspection of SvelteKit's shipped manifest generation
and the actual Vite build, instead of inventing entry-file proxy costs or
filesystem-parent approximations to layout/error inheritance.

## Initial values and explicit bounded headroom exception

Byte target = ceil(measured × 1.25 / step) × step; raw step **512 B**, gzip
step **256 B**. Initial route byte ceilings are the smaller of that target and
the unchanged corresponding aggregate ceiling. The extra hard route gate
therefore cannot relax the aggregate gate. Initial route file caps are measured
count + 1, bounded by the existing aggregate file cap; empty endpoint groups
remain exactly zero. File caps do not auto-ratchet.

Every page requires 2,784 raw / 927 gzip B of CSS (one file), except `/admin`,
which requires 2,861 / 1,019 B (two files). The default raw targets of 3,584 B
would exceed the existing 3,072 B aggregate CSS ceiling. Each page's initial raw
CSS ceiling is explicitly clipped to 3,072 B; gzip targets are 1,280 B. This is
reported headroom debt, not restored 25% raw headroom. No product change is made
to erase that debt. The measured JS route closures are:

| Route ID | Raw B | Gzip B | JS files |
| --- | ---: | ---: | ---: |
| `/` | 120059 | 46715 | 17 |
| `/about` | 111151 | 43225 | 17 |
| `/admin` | 116671 | 45712 | 20 |
| `/admin/activity-log` | 116937 | 46102 | 21 |
| `/admin/events` | 122948 | 48300 | 22 |
| `/admin/events/[key]` | 124858 | 48284 | 21 |
| `/admin/events/new` | 122072 | 47137 | 21 |
| `/admin/featured` | 117864 | 46229 | 20 |
| `/admin/featured/[id]` | 118667 | 46351 | 20 |
| `/admin/featured/new` | 115587 | 45230 | 20 |
| `/admin/join-attempts` | 117895 | 46500 | 21 |
| `/admin/join-attempts/[id]` | 116062 | 45759 | 21 |
| `/auth/recover` | 110172 | 42591 | 16 |
| `/e/[key]` | 136760 | 51885 | 20 |
| `/events/past` | 114816 | 44606 | 16 |
| `/faq` | 111831 | 43584 | 17 |
| `/hotzones` | 113638 | 44198 | 17 |
| `/hotzones/[signal]` | 113124 | 44059 | 17 |
| `/join` | 112660 | 43709 | 16 |
| `/leaderboards/members` | 115160 | 44944 | 17 |
| `/members/[user]` | 127231 | 48585 | 17 |
| `/privacy` | 110901 | 43038 | 16 |
| `/profile` | 127231 | 48585 | 17 |
| `/rules` | 111932 | 43587 | 17 |

The endpoint-only rows have zero bytes/files in both groups. Exact initial
ceilings live in `ci/budgets/kit-routes.json`, with strict runtime validation
and the editor-facing `ci/kit-route-budget.schema.json`.

This snapshot is the immutable measured admission anchor, not the mutable live
budget. Do not update or reset it to admit a new route: that would invalidate
historical replay. This lower-only implementation deliberately refuses new
routes, even when source, build evidence and live budget all include them.
Admission requires a separate reviewed, measured transition/migration
implementation that retains this anchor and the complete ordered history; no
such transition is implemented or authorized here. The automatic ratchet cannot
admit routes, change file caps or reset the anchor. Existing ceilings must not rise.

## Initial approved route plan

```json
{
  "version": 1,
  "scope": "kit-immutable-route-closure-v1",
  "routes": {
    "/": {
      "js": {
        "maxRawBytes": 150528,
        "maxGzipBytes": 58624,
        "maxFiles": 18
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/[...path]": {
      "js": {
        "maxRawBytes": 0,
        "maxGzipBytes": 0,
        "maxFiles": 0
      },
      "css": {
        "maxRawBytes": 0,
        "maxGzipBytes": 0,
        "maxFiles": 0
      }
    },
    "/about": {
      "js": {
        "maxRawBytes": 139264,
        "maxGzipBytes": 54272,
        "maxFiles": 18
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/admin": {
      "js": {
        "maxRawBytes": 145920,
        "maxGzipBytes": 57344,
        "maxFiles": 21
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 3
      }
    },
    "/admin/activity-log": {
      "js": {
        "maxRawBytes": 146432,
        "maxGzipBytes": 57856,
        "maxFiles": 22
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/admin/events": {
      "js": {
        "maxRawBytes": 154112,
        "maxGzipBytes": 60416,
        "maxFiles": 23
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/admin/events/[key]": {
      "js": {
        "maxRawBytes": 156160,
        "maxGzipBytes": 60416,
        "maxFiles": 22
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/admin/events/new": {
      "js": {
        "maxRawBytes": 153088,
        "maxGzipBytes": 59136,
        "maxFiles": 22
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/admin/featured": {
      "js": {
        "maxRawBytes": 147456,
        "maxGzipBytes": 57856,
        "maxFiles": 21
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/admin/featured/[id]": {
      "js": {
        "maxRawBytes": 148480,
        "maxGzipBytes": 58112,
        "maxFiles": 21
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/admin/featured/new": {
      "js": {
        "maxRawBytes": 144896,
        "maxGzipBytes": 56576,
        "maxFiles": 21
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/admin/join-attempts": {
      "js": {
        "maxRawBytes": 147456,
        "maxGzipBytes": 58368,
        "maxFiles": 22
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/admin/join-attempts/[id]": {
      "js": {
        "maxRawBytes": 145408,
        "maxGzipBytes": 57344,
        "maxFiles": 22
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/auth/recover": {
      "js": {
        "maxRawBytes": 137728,
        "maxGzipBytes": 53248,
        "maxFiles": 17
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/e/[key]": {
      "js": {
        "maxRawBytes": 171008,
        "maxGzipBytes": 65024,
        "maxFiles": 21
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/events": {
      "js": {
        "maxRawBytes": 0,
        "maxGzipBytes": 0,
        "maxFiles": 0
      },
      "css": {
        "maxRawBytes": 0,
        "maxGzipBytes": 0,
        "maxFiles": 0
      }
    },
    "/events/past": {
      "js": {
        "maxRawBytes": 143872,
        "maxGzipBytes": 55808,
        "maxFiles": 17
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/faq": {
      "js": {
        "maxRawBytes": 140288,
        "maxGzipBytes": 54528,
        "maxFiles": 18
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/hotzones": {
      "js": {
        "maxRawBytes": 142336,
        "maxGzipBytes": 55296,
        "maxFiles": 18
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/hotzones/[signal]": {
      "js": {
        "maxRawBytes": 141824,
        "maxGzipBytes": 55296,
        "maxFiles": 18
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/join": {
      "js": {
        "maxRawBytes": 141312,
        "maxGzipBytes": 54784,
        "maxFiles": 17
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/leaderboards/members": {
      "js": {
        "maxRawBytes": 144384,
        "maxGzipBytes": 56320,
        "maxFiles": 18
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/members/[user]": {
      "js": {
        "maxRawBytes": 159232,
        "maxGzipBytes": 60928,
        "maxFiles": 18
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/privacy": {
      "js": {
        "maxRawBytes": 138752,
        "maxGzipBytes": 54016,
        "maxFiles": 17
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/profile": {
      "js": {
        "maxRawBytes": 159232,
        "maxGzipBytes": 60928,
        "maxFiles": 18
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    },
    "/rules": {
      "js": {
        "maxRawBytes": 140288,
        "maxGzipBytes": 54528,
        "maxFiles": 18
      },
      "css": {
        "maxRawBytes": 3072,
        "maxGzipBytes": 1280,
        "maxFiles": 2
      }
    }
  }
}
```

## Automation boundary and step semantics

The dedicated push-to-main workflow has no PR, workflow-run or manual-input
trigger. A read-only job installs/builds and runs fixture, aggregate,
served-asset and route gates without a token in the executing process. It
uploads JSON measurements bound to that main SHA. A separate fresh writer job
checks out the same trusted SHA, installs nothing, and parses only bounded JSON
from this run's artifact. Its only token-bearing step uses the existing
`github.token`, scoped to contents/pull-requests write. No new secret, service,
ruleset, identity or approval bypass is introduced.

Only raw/gzip values in the two aggregate client fragments and route budget are
eligible. A metric lowers only when **current − rounded target > one step**.
Equality to one step does nothing. A draft's earlier decrease is an upper bound
on all later proposals: growth can report debt, never re-raise that ceiling.
Server/startup, file caps, CWV, served budgets and other files are not writable.

One stable `ci/client-budget-ratchet` branch owns at most one open draft. The
writer refuses a ready PR, edited title/body, non-bot or unsigned history,
non-client file changes, changed main budget revisions, and orphan refs.
GraphQL `createCommitOnBranch` uses `expectedHeadOid` to reject human branch
races atomically, with no retry, force push or main write. A newer main build
makes an old measurement a no-op. Missing permissions fail without fallback.
Each proposal carries the complete measurement and Undo in a generated decision.
Its machine-verifiable block includes main's original budget files and every
ordered draft measurement/result, including earlier updates. The writer binds
that replayed result to the live draft files before appending an update. Histories
must remain below 100 proposals and 2 MiB; the writer refuses excess before any
write. The shipping route gate and client allocation tests replay these measured
decisions from the unchanged initial aggregate ceilings **and the complete initial
route snapshot above**, including raw/gzip/file caps, route inventory, version
and scope. A pinned regression digest independently protects that measured
snapshot. Every decision's full base must equal the preceding approved plan;
filename/SHA sort order is not chronology. Route-only decisions advance the same
complete-plan chain even though aggregate values stay unchanged. Forks,
unsupported base resets, missing/tampered evidence, unproven earlier decreases,
disconnected decreases and re-raises fail closed. The shipping route gate binds
the complete live route budget to the final replay result before accepting any
build; a hand-edited raw/gzip/file cap cannot silently replace that result.
New route admission is explicit reviewed work, never inferred from matching
source/build/live-budget entries and never performed by the automatic writer. Existing historical
client byte fixtures retain their original pinned allocations, and separate
current-plan cases prove exact-fit and one-unit-over enforcement of raw/gzip/file
ceilings for both JS and CSS. Count fixtures use minimal bodies and verify the
count diagnostic independently if gzip framing makes a file cap unreachable.
No historical case or assertion is removed.

The writer fixture publishes through a fake GitHub API, applies the exact
base64-generated draft files to a disposable fixture tree, and runs both existing
fragment/checker suites there. Its representative decreases are JS 261632/104448
→ 250368/100096 B and CSS 3072/1280 → 1536/768 B, with file caps unchanged.
A second fixture proves both JS and CSS can decrease to 512/256 B with the same
55-file / 4-file caps, including count evidence when gzip framing also binds.
Those are synthetic test measurements, not proposed changes to today's budgets.
Run the full compatibility proof with:

```sh
node --test ci/check-kit-route-perf.test.mjs ci/kit-client-ratchet.test.mjs ci/check-kit-perf.test.mjs ci/budget-fragments.test.mjs ci/kit-parity-ci-wiring.test.mjs
```

## Generated-draft promotion and exact-head checks

There is no auto-merge. GitHub suppresses workflow runs for create/update events
caused by this workflow's repository `GITHUB_TOKEN`; those events are **not**
evidence of PR checks. That restriction is about the actor causing each event,
not a permanent property of a PR originally opened by that actor. See GitHub's
[triggering a workflow from a workflow documentation](https://docs.github.com/en/actions/how-tos/writing-workflows/choosing-when-your-workflow-runs/triggering-a-workflow#triggering-a-workflow-from-a-workflow).

Supported path, for both a new generated draft and any later automated updates:

1. Leave the PR as a draft throughout measurement and automated updates. The
   writer never marks it ready and refuses updates to a ready PR.
2. After the last update, inspect its latest head SHA. An independently
   authenticated maintainer marks it ready in the GitHub UI or with
   `gh pr ready <number>` using an **existing authorized independent identity**,
   not the writer's repository token. No credential, token scope or setting
   change is part of this path.
3. This independently originated `ready_for_review` event is subscribed by
   `.github/workflows/ci.yml`, `e2e.yml` and `pr-gates.yml`, so the normal CI,
   e2e, PR-lint and secret gates can run for the current head. Prior draft runs,
   including a scope-skipped e2e result, cannot stand in for the ready-head gates.
4. Verify every required check and review on that exact SHA, answer findings,
   then obtain the normal exact-head production merge confirmation. If a check
   or review does not appear, stop and diagnose its actor/event configuration;
   do not waive it, merge, or count an older-head result. If another update is
   needed after promotion, return it to draft first; writer ownership/history
   checks remain in force, and repeat independent promotion and exact-head
   verification after the last permitted update.

Fixture coverage asserts draft creation, draft updates, ready-PR refusal, all
three `ready_for_review` subscriptions, and these generated-body instructions.
This is source/fixture evidence, **not a live promotion experiment**; no test PR,
new identity, setting change or credential was created to validate the path.

Read-only capability inspection on 2026-11-04 returned
`default_workflow_permissions: read` and
`can_approve_pull_request_reviews: true` from the repository Actions workflow
permissions API. The write job requests its own narrow permissions. The complete
create/update/refusal path is fixture-tested; **no live ratchet PR was opened to
test capability**. If GitHub refuses PR creation, an operator must inspect the
repository's Actions “Allow GitHub Actions to create and approve pull requests”
setting and the existing workflow identity; this workflow does not change that
setting, acquire credentials, bypass required checks or substitute a token.
