# TWO Web Next threat model

This document records the main trust boundaries and abuse cases for the website as implemented in this repository. It is a maintenance map, not a penetration-test report or external review. Proof links identify existing controls and regression tests; a test path is evidence for the stated behavior, not proof that all attacks are impossible. Revisit this model when a boundary, data class, or deployment binding changes.

## Scope and assumptions

The application is a public Cloudflare Worker serving member and moderator routes, backed by Postgres through Hyperdrive in deployed configuration. It also integrates with Discord OAuth and bot APIs, accepts optional machine-only agent-event ingress, emits queue work, and has a separate Tail Worker for alert delivery. The model covers the repository's application controls and their configured interfaces; it does not assert the security of Cloudflare, Discord, Postgres operators, browser devices, or credential provisioning.

### Assets

| Asset | Security interest |
| --- | --- |
| Member data: Discord identity, profile, RSVP, join and access records | Confidentiality, integrity, retention and availability |
| Sessions and OAuth journeys; Discord OAuth access token and bot credential | Authentication integrity, confidentiality and limited use |
| Moderator authority and moderator-edited event/featured content | Authorization integrity and attributable changes |
| Queue ledger, locks, retries and failed-job records | Correct ownership, replay behavior and recoverability |
| Append-only audit tables (member-data access, agent-event and activity audits) | Integrity and accountability |
| Agent-event grants, ownership and idempotency receipts | Scoped machine authority and replay resistance |
| Operational alert summaries and webhook destination | Minimized disclosure and reliable incident signaling |

### Actors

| Actor | Trust posture |
| --- | --- |
| Guest / member | External browser user; member access depends on a valid server-side session and member status. |
| Moderator | Member whose Discord role matched the configured role-ID allowlist at sign-in; session-held authority persists until session ends or is replaced. |
| Agent grant holder | External machine caller holding an enabled, scoped bearer grant; not a browser identity. |
| Discord | External OAuth, guild-role and bot API provider; responses and availability are not controlled by this Worker. |
| Operator | Authorized person configuring bindings, credentials, database roles and deployments; outside application authorization. |

## Boundaries and abuse cases

Each case names the repository control and at least one existing test or documentation path. Cases describe plausible abuse, not claims that an incident occurred.

### Browser, same-origin and response policy

**Boundary:** untrusted browser requests enter the Worker; rendered pages and cookies return to the browser.

| Abuse case | Control and evidence |
| --- | --- |
| A hostile site submits a state-changing request using a victim's ambient session cookie. | Unsafe browser methods are checked against configured `APP_URL`; this is a CSRF defense, not authorization. Exact `POST /api/agent-events`, `POST /csp-reports` and `POST /mcp` exemptions have separate controls: bearer grants with budgets and replay protection, bounded sampled non-persistent sink, and handler-side validation of supplied Origins behind the global TrustHosts Host pin before routing respectively. See `src/mcp/routes.ts` (lines 7-13), `src/trust-hosts.ts` (lines 72-85), `src/same-origin.ts`, `docs/same-origin.md`, `test/same-origin.test.ts`. |
| An attacker supplies a hostile Host value to influence host admission or generated URLs. | Host admission is centralized before route handling; see `src/trust-hosts.ts`, `test/trust-hosts.test.ts`, `test/trust-hosts-worker.test.ts`. Forwarding-header behavior is not asserted here. |
| Injected or compromised content attempts script execution or framing to steal data or drive actions. | Security response headers and CSP are centralized; see `src/headers.ts`, `test/csp-policy.test.ts`, `test/security-headers-builder.test.ts`. |
| An attacker floods or submits oversized/forged CSP reports to consume report-ingress resources. | Report abuse and body limits are separately checked; see `src/csp-reports.ts`, `test/csp-report-abuse.test.ts`, `test/csp-report-body-deadline.test.ts`. |

### Discord OAuth, session and credential handling

**Boundary:** browser redirect/callback crosses to Discord OAuth; returned identity and credentials enter application session logic and Postgres.

| Abuse case | Control and evidence |
| --- | --- |
| An attacker forges OAuth journey state to alter the callback's stored login intent or return path. | Signed, short-lived journey cookies are verified; see `src/oauth-journeys.ts`, `test/oauth-journeys.test.ts`. Callback identity binding is outside this assertion. |
| An attacker replays a consumed OAuth callback journey. | Journey freshness and one-use admission are checked against the shared store; see `src/oauth-journeys.ts`, `test/oauth-journeys.test.ts`, `test/oauth-exchange-outcomes.test.ts`. |
| A stolen session cookie is replayed after logout, expiry, fresh login or concurrent rotation. | Only token hashes are stored; sessions expire, rotate atomically and can be revoked; see `src/sessions.ts`, `test/sessions.test.ts`, `test/session-rotation-revocation-race.test.ts`. |
| An OAuth access token is persisted by the web application after sign-in or the join flow. | The token remains request-local in `src/auth/routes.ts` and `src/join/route.ts` and is omitted from their persistence payloads. Successful sign-in and join are proven by `test/oauth-token-persistence.test.ts`: `ordinary sign-in writes a valid session and roster row; no recorded write carries the marker`, `join writes a valid session, roster row and added attempt; no recorded write carries the marker`, `ordinary sign-in persists a valid session and roster row; no table row carries the marker` and `join persists a valid session, roster row, added attempt and throttle hits; no table row carries the marker`. A planted roster write is reported by the same check (negative control). `test/join.test.ts` also checks join-attempt and throttle records. Log lines and failure-path diagnostics are outside this assertion. |
| An OAuth access token is exposed in a failure-path diagnostic. | For the exchange and user-lookup failure branches of the two mocked callback journeys (`GET /join/callback` and `GET /auth/discord/callback`), plus the post-exchange join bot-failure branches (`GET /join/callback` degraded after a successful exchange: bot refusal with a marker-bearing 403 body, and a transport throw carrying canaries; each proves 200 recovery with invite/retry controls, no member session, one degraded attempt, no canary in response material or recorded attempts, and a clean stream with the request line required), plus the post-bot-success downstream branches (`GET /join/callback` signed_in after a successful exchange, user lookup and bot add: moderator transport throw and marker-bearing 500 each prove 302 with a non-moderator session, one added attempt, upstream call counts and a clean stream with the request line required; session-create throw with nested canaries proves 500 with no usable session cookie, one added attempt, upstream call counts and a clean stream with the request line required; a planted post-bot-success marker fails the same inspection without printing marker bytes), each argument of every `console.log`, `info`, `debug`, `warn` and `error` call is read as the call is made, including the Error name, message, stack and cause, own and non-enumerable fields, and Map and Set contents. Traversal is cycle-safe and budgeted. Opaque, function, binary, over-deep or unreadable values fail the check, as does any own key on any intermediate prototype up to the built-in Error, Map, Set, RegExp or Array prototype (other than `constructor`, and other than the Error name, message, stack and cause fields which are read explicitly), such as a `toString` override, `nodejs.util.inspect.custom`, a `Symbol.toStringTag` value or another prototype data property; each intermediate constructor's name is read as text, so a marker there is a hit. Each journey must first write its request line and, where it has one, its expected failure record. A marker is detected by exact substring of the synthetic canaries, within one value or across the values of one call. See `test/oauth-failure.test.ts`, `test/helpers/diagnostic-stream.ts` and the negative controls in `test/diagnostic-stream-oracle.test.ts`. Not covered: join-approval paths after a successful bot add, the join `error=` denial, other callbacks, other console methods and live log sinks. Transformed tokens and writes landing after response consumption stay outside this assertion. This residual is listed below. |

### Hyperdrive / Postgres, member data and audit records

**Boundary:** Worker code and its database binding access Postgres rows containing member data, sessions, queues and audit records.

| Abuse case | Control and evidence |
| --- | --- |
| A guest or non-member obtains protected profile data or submits a profile write. | Guest and non-member route requests are gated before data exposure or writes; member-data reads are audited and buffered. See `src/member-reads.ts`, `src/access-log.ts`, `test/member-exposure.test.ts`, `test/member-data-access.test.ts`. |
| A database outage or unavailable audit write causes protected data to be served without its required audit record. | Read paths fail closed when session or audit operations fail; see `src/admin/guard.ts`, `src/access-log.ts`, `test/db-outage-matrix.test.ts`, `test/admin-reads.test.ts`. |
| An application path attempts to update or delete protected audit rows. | Migration `drizzle/1018_audit-immutability.sql` adds append-only protections; see `test/audit-immutability.test.ts`. This evidence does not establish resistance to table owners or superusers. |
| A duplicate or misidentified queued job changes ledger ownership or repeats a protected action. | Queue IDs, ledger transitions and lock ownership are checked in the Postgres-backed queue path; see `src/jobs/ledger.ts`, `src/jobs/postgres.ts`, `test/jobs-ledger.test.ts`, `test/jobs-lock-ownership.test.ts`, `test/queue-replay.test.ts`. |
| An overprivileged database operator bypasses append-only enforcement or extracts stored member data. | The migration documents append-only protections and their database-role caveat; repository tests do not establish defenses against operator-level access. See `drizzle/1018_audit-immutability.sql`, `test/audit-immutability.test.ts`. |

### Moderator authority

**Boundary:** Discord role membership and configured role IDs become a moderator flag in the server-side session; that flag gates moderator routes and writes.

| Abuse case | Control and evidence |
| --- | --- |
| A guest, non-member or ordinary member attempts to access moderator routes by guessing URLs or changing client-side state. | Server-side session authorization rejects guests and non-moderators; see `src/admin/guard.ts`, `test/admin-guard-matrix.test.ts`, `test/admin-authwall-probe.test.ts`. |
| A similarly named or malformed role grants elevated rights. | Role checks use configured numeric snowflake IDs, not names; blank allowlists and failed lookups fail closed. See `src/roles.ts`, `test/moderator-malformed-success.test.ts`. |
| A moderator's Discord role is removed but their existing session remains privileged. | Role membership is recomputed at login, not on every admin request; rotation preserves the session's moderator flag. Operators can invalidate active sessions using `bin/revoke-sessions.mjs`, backed by `src/session-revocation.ts` and `test/revoke-sessions.test.ts`. `docs/runbook.md` documents immediate invalidation and quarterly `audit:moderator-roles` drift checks; see also `docs/moderator-admin-guide.md`. Removal does not automatically trigger revocation: detection and operator action are still required. |

### Bot internal actions and Discord credentials

**Boundary:** the web/job Worker signs internal actions for a separately credentialed bot endpoint. This repository documents the sender contract; receiver-side authentication and replay behavior are not established here.

| Abuse case | Control and evidence |
| --- | --- |
| A caller forges or modifies an internal action request. | HMAC covers method, path, timestamp, nonce and body digest; see `src/bot/signer.ts`, `docs/agent-events.md`, `test/bot-signer.test.ts`, `test/bot-hmac-vectors.test.ts`. |
| A captured signed request is replayed at the bot receiver. | The web client generates a fresh nonce for each request; see `src/bot/client.ts`, `test/bot-nonce-generation.test.ts`. Receiver-side replay rejection is not established by this repository's cited evidence and is listed as a residual gap. |
| An unauthenticated caller submits an internal action directly to the bot receiver. | The web sender signs method, path, timestamp, nonce and body digest; see `src/bot/signer.ts`, `test/bot-signer.test.ts`. Receiver-side authentication is outside this repository's cited evidence and remains a gap. |
| A refusal or transport error leaks bot credentials or response content through application diagnostics. | Bot-client and queue redaction paths are covered for known secret/body fixtures; see `src/bot/client.ts`, `test/bot-client-no-secret-log.test.ts`, `test/queue-error-redaction.test.ts`. This is not a claim about all arbitrary error strings or external log sinks. |

### Agent-event ingress grants

**Boundary:** machine bearer requests enter `/api/agent-events`, bypassing browser-origin checks but subject to separate grant, operation and rate controls.

| Abuse case | Control and evidence |
| --- | --- |
| An unauthenticated caller or caller with a disabled, expired or wrong-scope grant mutates events. | Grant admission checks hash, caller, guild, operation and status; see `src/agent-events/service.ts`, `docs/agent-events.md`, `test/agent-events.test.ts`. |
| A valid grant replays or races a mutation to apply it more than once or overwrite a human edit. | Advisory locks, idempotency receipts and versions serialize operations; see `src/agent-events/service.ts`, `test/agent-events-replay-audit.test.ts`, `test/agent-events-grant-admission-race.test.ts`, `test/agent-events-cross-operation-idempotency.test.ts`. |
| Oversized or malformed ingress floods processing or reaches unintended records. | Input bounds, ownership checks and an outer per-credential shield restrict admission; see `src/agent-events/route.ts`, `docs/agent-events.md`, `test/agent-events-input-bounds.test.ts`, `test/agent-events-shield.test.ts`. |

### Tail Worker alert egress

**Boundary:** application error logs cross from the app Worker trace to a separate Tail Worker, which may send a minimized summary to an operator Discord webhook.

| Abuse case | Control and evidence |
| --- | --- |
| A foreign Worker in the account feeds forged logs into the alert channel. | Only exact application script names, event shapes and allowlisted jobs are accepted; see `tail/worker.ts`, `test/tail-alerts.test.ts`. |
| A crafted route, fingerprint, exception or queue payload leaks member data or secrets to Discord. | Routes are mapped to templates, fingerprints are hashed, and raw payloads/errors are not forwarded; see `tail/worker.ts`, `test/tail-alerts.test.ts`, `test/queue-error-redaction.test.ts`. |
| A malicious or misconfigured destination redirects webhook traffic or injects mentions. | Destination URL is restricted to the Discord webhook path; redirects are refused and mentions disabled. See `tail/worker.ts`, `test/tail-alerts.test.ts`. |

## Gaps and residual risks

This table lists the residual portion of the abuse cases above that the cited controls and evidence do not fully address, including cases with no application-level control or dedicated test for the stated threat. Suggested owner types are routing suggestions only. Do not interpret this table as a claim that a gap was tested, exploited, or fixed. No remediation is included in this documentation change.

| Abuse case with an unresolved control or evidence gap | Suggested owner |
| --- | --- |
| Discord role removal does not automatically revoke an already-issued moderator session; operator detection and revocation are required, including between quarterly access reviews. | Security |
| An OAuth access token is exposed in a failure-path diagnostic outside the branches named in the failure-stream claim above, through other console methods, or through live log sinks. It also stays open for a token in a transformed form (truncated, encoded or case-folded), and for a write that lands after the test has read the response, such as a timer or `waitUntil` callback. | Security |
| An unauthenticated caller submits an internal action directly to the bot receiver. | Security (coordinate with bot receiver maintainers) |
| A captured signed request is replayed at the bot receiver. | Security (coordinate with bot receiver maintainers) |
| An overprivileged database operator bypasses append-only enforcement or extracts stored member data. | Security |
| A request arriving behind a proxy carries `X-Forwarded-Host` (or other forwarding headers) that admission does not read. Control: only the environment's `APP_URL` hostname is trusted and `X-Forwarded-Host` is deliberately ignored as client-controlled; Host admission is centralized before routing with branded DB-free 404 refusals that never echo the host. Unresolved: forwarding-header behavior is not asserted — the model states no expectation about deployments that rely on forwarded host values. Proof: `src/trust-hosts.ts` (lines 1-8, 72-85), `test/trust-hosts.test.ts`, `test/trust-hosts-worker.test.ts`. | Security |
| A page outside the five inline-critical paths emits an inline `<style>` block, or the leaf bundle is regenerated without updating its recorded hash. Control: `style-src` keeps no `unsafe-inline`; only `/`, `/about`, `/faq`, `/rules` and `/privacy` carry the `sha256-` hash of the exact leaf bundle, widened per-route after `secureHeaders`. Unresolved: the model asserts no hash lifecycle on bundle regeneration and pins no claim that no other route emits an inline-style block. Proof: `src/headers.ts` (lines 81-97, 114-122, 144-146), `src/leaf-critical-css.ts`, `test/csp-policy.test.ts`, `test/leaf-css-drift.test.ts`, `test/security-headers-builder.test.ts`. | Security |
| A member who only browses Kit event pages misses the sliding session renewal. Control: Hono re-stamps the 120-minute window on login and on authenticated page views served through the rotating `readSession` (`SESSION_TTL_SECONDS`, `src/sessions.ts`, `src/index.tsx`); the profile gate (`src/profiles/routes-gate.ts`) and the admin guard (`src/admin/guard.ts`) read the session row without rotating, and the Kit bridge is read-only by construction (one `store.get` per request, no rotation, no revocation, no `Set-Cookie`). Unresolved: Kit-only, profile-only and admin-only browsing never re-stamp, so the session can expire sooner than on a journey through rotating page views; enabling Kit `GET /e/:key` stays blocked on this divergence, pinned by the member-detail rotation asserts. The behavior change is pending backlog work tracked outside this document — this row records only the residual and changes no behavior. Proof: `src/kit-session.ts` (lines 1-15, 88-94), `docs/parity.md` section 12 session row, `docs/kit-parity-gates.md`, `e2e/kit-parity/parity.spec.ts`. | Security (behavior change pending) |
| An operator passes the wrong `--target` for the database host. Control: dry-run is the default; any host outside loopback and `agent-testdb` needs `--target staging` or `--target production`; a production-looking URL needs `--target production` and `--target staging` on it is refused; `DATABASE_URL` comes from the environment only; every refusal happens before a connection opens with fixed-string messages. Unresolved: the target is an operator assertion the tool cannot verify — a mistaken value against a matching-looking host is undetectable by the tool. Proof: `docs/member-erasure.md` (lines 11-25, 34-36), `bin/erase-member.mjs`, `test/member-erasure.test.ts` (target and TLS policy suite). | Security |

## Limits and review

The tests listed are repository-level regression evidence, not an independent security assessment. This model does not establish safety of production configuration, deployment permissions, secret rotation, third-party infrastructure, or controls outside this repository. The gaps table records residual cases where cited proof does not establish the full abuse-case claim, including operator-level database threats not addressed by application tests. No penetration test or external review is claimed. Report suspected vulnerabilities using [the private reporting process](../SECURITY.md#reporting-a-vulnerability).
