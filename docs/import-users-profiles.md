# Legacy users and profiles import

Cutover tooling for [TOG-10831](/TOG/issues/TOG-10831). Implementing or testing this script does **not** authorize a real legacy/Neon run. That remains an operator cutover step subject to the migration and data-transfer gates in `docs/db-migrations.md`.

## Operator invocation

Provision `LEGACY_DATABASE_URL` (source) and `DATABASE_URL` (migrated Next destination) in the execution environment through the approved secret mechanism. Never place credentials in arguments, shell history, committed files, or logs. Both URLs require a PostgreSQL scheme, host, username and database; an empty password does not fall back to `PGPASSWORD`. Each client uses the URL's explicit port or 5432, never inherited `PGPORT` (Postgres.js options override URL/environment defaults: https://github.com/porsager/postgres#connection).

```sh
node bin/import/users-profiles.mjs             # default: read-only dry run
node bin/import/users-profiles.mjs --dry-run   # explicit preview
node bin/import/users-profiles.mjs --apply     # opt-in upsert
```

Use a **read-only source principal** and a destination principal limited to the users/profiles slice. Apply the destination's migrations first. Table resolution follows each connection's `search_path` (normally `public`). Take the approved cutover backup and pause legacy writes before the final import; this script is a snapshot import, not continuous replication. Do not add URLs to CLI arguments, even for tests.

Each successful run emits two JSON lines, one per table: `table`, `dryRun`, `read`, `changed`, `unchanged`, `written`. In a dry run, `changed` means rows that would be inserted or updated and `written` is always zero. On apply, `changed` equals `written`. An unchanged rerun emits zero writes and does not update row versions or timestamps. Source counts can differ: a legacy user is not required to have a profile. Output never contains identities or profile contents.

Exit codes: `0` success/help; `2` invalid invocation, missing variables or identical source/destination URLs; `1` import failure. Failures deliberately omit raw driver errors, URLs and row values. A lost connection around commit can have an ambiguous outcome; inspect counts privately and retry the idempotent command rather than assuming a failed invocation wrote nothing.

## Mapping and source evidence

DDL and model semantics are pinned to frozen `TogetherWeOwn/two-web` commit `2eaefb8dc7af6e7e9bf62fd561d09e8babf31ba4`:

- `database/migrations/0001_01_01_000000_create_users_table.php:14-23`
- `database/migrations/2026_08_19_000400_add_discord_role_fields_to_users_table.php:11-21`
- `database/migrations/2026_08_19_000100_create_profiles_table.php:14-21`
- `app/Models/User.php:20-42`, `app/Models/Profile.php:10-35`
- `app/Http/Controllers/Auth/DiscordLoginController.php:269-285`

| Legacy | Next | Rule |
|---|---|---|
| `users.discord_id` | `users.id` | Unique natural key, kept as text; never numeric conversion |
| `COALESCE(NULLIF(users.display_name, ''), users.username)` | `users.username` | Preserve a non-empty display name; null/empty falls back to the handle, matching Next sign-in naming |
| `users.avatar` | `users.avatar` | Same-user Discord CDN URL → hash; existing hash preserved; null/empty/default avatar → null |
| `users.discord_joined_at` | `users.member` | Non-null is positive **historical** guild-join evidence; null imports as false |
| `profiles.user_id` → `users.id` → `users.discord_id` | `profiles.user_id` | Resolve legacy integer FK to Discord natural key |
| `profiles.bio`, `games`, `timezone` | Same fields | Preserve nulls and JSON string array; no invented timezone |
| Both `created_at`, `updated_at` | Same fields | UTC wall times → `timestamptz`; preserve creation time on conflicts too |

Legacy Socialite's `getAvatar()` supplies a URL (`DiscordLoginController.php:277`), whereas Next's `profileAvatarSrcset` consumes a hash. Normalize only HTTPS `cdn.discordapp.com/avatars/<same-discord-id>/<hash>.(png|jpg|jpeg|webp|gif)` URLs; discard image query parameters, preserve animated `a_` hashes and support already-normalized hashes matching the renderer. Discord default `/embed/avatars/0.png` through `5.png` map to null (Next's initial fallback), as do null/empty avatars. Other hosts, userinfo, fragments, non-default ports, mismatched IDs and unsupported paths fail validation before destination writes, without logging source values. CDN path definitions: https://docs.discord.com/developers/reference#image-formatting. No avatar URL is fetched.

**No legacy member boolean exists.** `discord_joined_at` is an import proxy, not a current-membership check: legacy failed logins do not clear old join evidence, and a successful guild response missing `joined_at` can store null (`DiscordLoginController.php:107-113,248-249,280-282`). Next recomputes actual membership and moderator status at sign-in. The import creates **no sessions or authorization state**. `is_moderator`, `remember_token`, sync markers and all credentials are excluded from the source query, not merely dropped before writing. Only the resolved display name/handle is projected as `username`; no separate display-name field is added.

Legacy timestamp interpretation follows `config/app.php:68` (`UTC`) and `config/database.php:45` (`Etc/UTC`). Both import transactions pin `DateStyle` to `ISO, YMD` before formatting or parsing timestamp text, independent of URL/session/server settings. This is the application convention, not verification of real historical records. Null `updated_at` falls back to that row's `created_at`; null creation timestamps, invalid/missing Discord identities, orphaned profiles and non-string-array games fail the entire import rather than guessing or silently discarding rows.

Source reads use a repeatable-read, read-only transaction. Destination users and profiles apply in a single transaction, so a profile write failure rolls back user writes. Natural-key conflicts update only when imported fields differ. Users also retain a newer Next row when its `updated_at` is later than the imported timestamp (for example, after a subsequent Discord sign-in); dry runs count these retained rows as unchanged. Equal-timestamp users can still receive mapping corrections. Profile conflict rules are unchanged. No deletions, session restoration, credentials or moderator assignments are performed.

The verification diff tool tracked by [TOG-10835](/TOG/issues/TOG-10835) is not merged as of this change. Its user-name comparison must use the same `COALESCE(NULLIF(display_name, ''), username)` source expression, not the raw legacy handle.

## Synthetic verification

`test/fixtures/legacy/users-profiles.sql` transcribes the three migrations and adds only synthetic rows/token sentinels. Tests create isolated `legacy_up_*` and `next_up_*` schemas to avoid collisions with other import domains or agent runs, and apply the canonical Next users/profiles migrations. The suite explicitly refuses database targets other than `agent-testdb:5432/two_web_next` (empty-password `agent_test`) or this repository's CI PostgreSQL service container.

```sh
# With DATABASE_URL supplied via env for the approved disposable test service:
npx vitest run test/import-users-profiles.test.ts
npm run check
```

Without `DATABASE_URL`, CLI safety tests run and the DB fixture tests skip. With it, tests prove counts, dry-run no writes, display-name/null/empty/whitespace mapping, exact-key/time mapping (including conflicting DateStyles), normalized avatar import-to-render and refusal cases, no moderator/token import, actual no-op row versions, equal-timestamp mapping corrections, newer Next user preservation, conflict updates, source immutability, validation failures and transaction rollback. Fixture construction reuses the strict test URL validator: caller query strings/fragments are rejected before driver construction or DDL, CI requires both `CI=true` and `GITHUB_ACTIONS=true`, and test port/password are pinned rather than inherited from libpq environment variables. Only fixture-generated connection URLs carry an isolated `search_path`. Mocked-driver coverage in `test/member-data-fixture.test.ts` proves refusal before connecting. Tests never contact Discord, legacy VPS, Neon, production or staging.
