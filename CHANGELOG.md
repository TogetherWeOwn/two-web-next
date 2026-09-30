# Changelog

## Unreleased

### Added

- Port member-data exposure and access-log acceptance tests from Pest to Vitest, including the mounted Worker role matrix and real failing Postgres INSERTs.

### Fixed

- Refuse admin member-data responses when the access-log INSERT fails; replace Hono's finalized response rather than returning an ignored 503.

## [0.2.0](https://github.com/TogetherWeOwn/two-web-next/compare/v0.1.0...v0.2.0) (2026-09-29)


### Added

* **admin:** pt1 resources, tables, role gate, write loop ([#15](https://github.com/TogetherWeOwn/two-web-next/issues/15)) ([d57a9ca](https://github.com/TogetherWeOwn/two-web-next/commit/d57a9cada2c3626b424d839cd8e56f4d75c3c2ac))
* **admin:** pt2 RSVP roster, join attempts viewer, funnel stats ([#20](https://github.com/TogetherWeOwn/two-web-next/issues/20)) ([cf86048](https://github.com/TogetherWeOwn/two-web-next/commit/cf86048a10953060e7fe6833e06e33ded7983ca7))
* **agent-events:** bearer ingress, idempotency replay and byte-parity bot signer ([#8](https://github.com/TogetherWeOwn/two-web-next/issues/8)) ([8b40f38](https://github.com/TogetherWeOwn/two-web-next/commit/8b40f3846fa44c8a00f2d7942e259fb10057aac4))
* **auth:** db-backed sessions with rotation, role recompute, staging QA seam ([#11](https://github.com/TogetherWeOwn/two-web-next/issues/11)) ([bb86671](https://github.com/TogetherWeOwn/two-web-next/commit/bb86671bc63bba464c86590aa78b698411bc2541))
* **auth:** upsert user roster on sign-in and join ([#19](https://github.com/TogetherWeOwn/two-web-next/issues/19)) ([d80f25c](https://github.com/TogetherWeOwn/two-web-next/commit/d80f25c527be04598b94c37b91298671d7007e4c))
* **db:** drizzle users slice with migrations and staging deploy ([#5](https://github.com/TogetherWeOwn/two-web-next/issues/5)) ([a00f3c8](https://github.com/TogetherWeOwn/two-web-next/commit/a00f3c80ec7d6f7da88ec9493d51797724f1caa5))
* **db:** shared Neon Postgres foundation and nightly backups ([#10](https://github.com/TogetherWeOwn/two-web-next/issues/10)) ([069b8cd](https://github.com/TogetherWeOwn/two-web-next/commit/069b8cd9ea019219b0790690f1e51ba950cbaef4))
* **islands:** going-count contract, binder and drift tests ([#9](https://github.com/TogetherWeOwn/two-web-next/issues/9)) ([46da8a8](https://github.com/TogetherWeOwn/two-web-next/commit/46da8a8fcf3c2355e27e886e382c0e042a770678))
* **join:** one-click journey with synchronous bot add and throttle ([#13](https://github.com/TogetherWeOwn/two-web-next/issues/13)) ([24fadcb](https://github.com/TogetherWeOwn/two-web-next/commit/24fadcbb55f1c8e090530c171d0205a3803772ea))
* **privacy:** versioned DB-free /privacy policy page ([#21](https://github.com/TogetherWeOwn/two-web-next/issues/21)) ([41d14bb](https://github.com/TogetherWeOwn/two-web-next/commit/41d14bb007e19ffc9ded0371e29824e994bc07e8))
* **profiles:** member profile, PATCH and member-access-log with exposure matrix ([#26](https://github.com/TogetherWeOwn/two-web-next/issues/26)) ([889db5a](https://github.com/TogetherWeOwn/two-web-next/commit/889db5a3c69d2dab4af39298d5dc02669ba7368a))
* **pwa:** webmanifest, install icons, branded error pages ([#18](https://github.com/TogetherWeOwn/two-web-next/issues/18)) ([f2521ac](https://github.com/TogetherWeOwn/two-web-next/commit/f2521ac6ebd61d918def830359373a225d5d8332))
* **seo:** public shell parity with static leaves and sitemap ([#6](https://github.com/TogetherWeOwn/two-web-next/issues/6)) ([b079fc4](https://github.com/TogetherWeOwn/two-web-next/commit/b079fc4bc4ae0c9e0f8d361f235c763d432e374a))


### Fixed

* **db:** rewire Neon backup to EU-pinned R2 bucket ([#12](https://github.com/TogetherWeOwn/two-web-next/issues/12)) ([f100e0a](https://github.com/TogetherWeOwn/two-web-next/commit/f100e0a52af570f25ea8b975ec897bd9ac55cbeb))
