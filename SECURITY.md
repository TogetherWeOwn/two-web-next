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

## Supported Versions

Security fixes land on `main` and ship with the next release-please release
(see [CHANGELOG.md](CHANGELOG.md)). Pre-`1.0.0` versions are pre-production;
upgrade to the latest tagged release.
