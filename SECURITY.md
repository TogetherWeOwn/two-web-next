# Security Policy

## Reporting a Vulnerability

**Do not open a public issue, pull request, or discussion for a security vulnerability.**

Report privately via
[GitHub private vulnerability reporting](https://github.com/TogetherWeOwn/two-web-next/security/advisories/new)
(Security tab → Report a vulnerability). Only maintainers see the report, and
we will coordinate the fix and disclosure with you.

Describe the affected route or component, the impact, and the steps to
reproduce. **Do not paste secrets** into the report, an issue, a PR, or a
comment: no tokens, session cookies, OAuth codes, API keys, `.dev.vars`
contents, or member data. Redact them and name the variable or field instead.
If you find a live secret in the repository or its history, report it
privately and do not copy the value.

## Threat Model

See the [TWO Web Next threat model](docs/threat-model.md) for the assets, trust boundaries, abuse cases, and repository evidence considered for this application. It is not a penetration-test report or external review.

## Supported Versions

Production at <https://togetherweown.com> serves `main` as promoted by the
production deploy. Security fixes land on `main` and ship with the next
production promote, which tags a release (see the GitHub Releases page and
[docs/releases.md](docs/releases.md)).

We accept reports about the live site and the latest tagged release. The
tag can trail what is live, so say which one your report concerns.
