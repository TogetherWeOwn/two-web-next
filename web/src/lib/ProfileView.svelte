<script lang="ts">
import {
  MEMBER_PROFILE_ISLAND,
  MOUNT_ATTR,
  PROFILE_AVATAR_TESTID,
  PROFILE_CANCEL_TESTID,
  PROFILE_COPY,
  PROFILE_EDIT_TESTID,
  PROFILE_EMPTY_COPY,
  PROFILE_ERROR_TESTID,
  PROFILE_FORM_TESTID,
  PROFILE_HONEY_FIELD,
  PROFILE_JOINED_TESTID,
  PROFILE_NAME_TESTID,
  PROFILE_NEW_MEMBER_COPY,
  PROFILE_NEW_MEMBER_CTA_TESTID,
  PROFILE_NEW_MEMBER_TESTID,
  PROFILE_OPENED_AT_FIELD,
  PROFILE_RANK_TESTID,
  PROFILE_SAVE_TESTID,
  PROFILE_VIEW_TESTID,
  profileAvatarSrcset,
  profileIsNewMember,
  profileJoinedMonth,
} from "../../../src/islands/contracts";
import {
  PROFILE_ERROR_IDS,
  PROFILE_FIELD_IDS,
  PROFILE_SHARE_DESCRIPTION,
  PROFILE_TIMEZONE_HELP_ID,
  profileFieldForErrorKey,
  profileInitials,
  statsDate,
  statsLabel,
  type ProfileFormValues,
} from "../../../src/profiles/pages";
import type { MemberStats } from "../../../src/profiles/stats";
import type { MemberView } from "../../../src/profiles/store";
import type { JoinResult } from "../../../src/return-journey";
import { canonicalUrl } from "../../../src/seo";

// Markup contract of ProfilePage (src/profiles/pages.tsx): the header bar,
// test ids and copy are shared, so the existing profile tests and islands
// apply. Member fields render through Svelte interpolation only — never
// {@html} — so a hostile username, bio or game name stays escaped text, like
// the Hono JSX render. The edit form posts to the Hono-owned write routes
// (POST/PATCH /members/:user stay off the manifest until edit parity).
let {
  member,
  stats = null,
  isOwner,
  isModerator = false,
  appUrl,
  joinResult = null,
  restoredWrite = null,
  errors = null,
  values = null,
}: {
  member: MemberView;
  stats?: MemberStats | null;
  isOwner: boolean;
  isModerator?: boolean;
  appUrl: string;
  joinResult?: JoinResult | null;
  /** Restored-write notice from the root layout data: renders the "you
    signed in again" banner first inside <main>, ahead of the join banner,
    exactly as Hono's expiredWriteBanner middleware injects it. The
    destination is never rendered, so a hostile value stays inert. Bytes are
    twinned deliberately (never imported from the .tsx): importing the Hono
    screen would bundle the JSX runtime into the Kit worker, and the
    acceptance suite pins both copies byte-identical. */
  restoredWrite?: string | null;
  errors?: Record<string, string> | null;
  values?: ProfileFormValues | null;
} = $props();

const img = $derived(profileAvatarSrcset(member.id, member.avatar));
const joined = $derived(profileJoinedMonth(member.joinedAt ?? null));
const isNewMember = $derived(profileIsNewMember(member));
const canonical = $derived(canonicalUrl(appUrl, `/members/${member.id}`));
// Hono Layout renders the title raw with no site suffix (pinned by the
// seo-headers and public-route-meta suites): SiteMetadata's appended suffix
// would change tab text and share titles, so this head replicates the Hono
// profile head tag for tag instead.
const title = $derived(`${member.username} — Member profile`);
// A failed save re-renders with the submitted values, never the stored
// record; a fresh read renders the record. Same shape as the Hono
// ProfilePage values, so the island binder sees one form contract.
const form: ProfileFormValues = $derived(
  values ?? {
    bio: member.bio ?? "",
    games_text: member.games.join("\n"),
    timezone: member.timezone ?? "",
    leaderboard_opt_out: member.leaderboardOptOut ?? false,
  },
);
// Persisted baseline for the island: on a 422 the controls hold the rejected
// draft while these attributes hold the stored profile, so Cancel restores
// the record. Same contract as the Hono ProfilePage data-saved-* attrs.
const saved: ProfileFormValues = $derived({
  bio: member.bio ?? "",
  games_text: member.games.join("\n"),
  timezone: member.timezone ?? "",
  leaderboard_opt_out: member.leaderboardOptOut ?? false,
});
const gamesError = $derived(errors?.games ?? errors?.games_text);
// A component-level <script> is Svelte's own; the island tags are markup.
const avatarIsland = '<script src="/islands/avatar.js" defer></' + "script>";
const editorIsland = '<script src="/islands/member-profile.js" defer></' + "script>";
</script>

<svelte:head>
  <meta name="robots" content="noindex, nofollow" />
  <title>{title}</title>
  <meta name="description" content={PROFILE_SHARE_DESCRIPTION} />
  <link rel="canonical" href={canonical} />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Together We Own" />
  <meta property="og:url" content={canonical} />
  <meta property="og:title" content={title} />
  <meta property="og:description" content={PROFILE_SHARE_DESCRIPTION} />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content={title} />
  <meta name="twitter:description" content={PROFILE_SHARE_DESCRIPTION} />
  <link rel="alternate" type="application/rss+xml" title="Together We Own Events" href="/events.rss" />
</svelte:head>
<!-- Open Lobby chrome: colours resolve through web/src/app.css semantic
  tokens; the profile theme class matches the Hono Layout theme. -->
<div class="base-theme profile-theme" data-theme="profile">
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="bar profile-header-bar">
    <a class="brand" href="/">TWO</a>
    <div class="profile-header-actions">
      <nav aria-label="Primary">
        <a class="btn" href="/profile">Your profile</a>
        <a class="btn profile-secondary" href="/events">Events</a>
        {#if isModerator}
          <a class="btn profile-secondary" href="/admin" data-testid="profile-admin-link">
            Moderator admin
          </a>
        {/if}
      </nav>
      <form method="post" action="/logout" data-testid="profile-signout">
        <button type="submit" class="link">Sign out</button>
      </form>
    </div>
  </header>
  <main id="main" tabindex="-1">
    {#if restoredWrite}<div role="status" tabindex="-1" data-testid="auth-error">You signed in again. Your earlier changes were not saved. Review and submit them again.</div>{/if}
    {#if joinResult}
      <p class="notice" role="status" data-testid="join-result">
        {#if joinResult === "added"}
          You are in. Finish Discord's rules screening before you can post.
        {:else}
          You are already in the server.{" "}
          <a href="/discord" data-testid="reinvite-link">Rejoin with the Discord invite</a>
        {/if}
      </p>
    {/if}
    <section class="profile-player" aria-labelledby="member-heading" data-testid={PROFILE_VIEW_TESTID}>
      <div class="profile-identity">
        <span data-testid={PROFILE_AVATAR_TESTID} data-avatar="" aria-hidden="true" class="avatar">
          {#if img}
            <img src={img.src} srcset={img.srcset} alt="" width="64" height="64" loading="eager" />
          {/if}
          <span data-avatar-initial="" class="avatar-initial" hidden={!!img}>
            {profileInitials(member.username)}
          </span>
        </span>
        <div>
          <p class="profile-caption">Member profile</p>
          <h1 id="member-heading" tabindex="-1" data-testid={PROFILE_NAME_TESTID}>
            {member.username}
          </h1>
          <p class="profile-handle" data-testid="profile-handle">@{member.username}</p>
          <div class="profile-meta">
            <p class="profile-chip" data-testid="profile-provenance">From Discord</p>
            {#if !stats?.joinedAt && joined}
              <p data-testid={PROFILE_JOINED_TESTID}>Joined {joined}</p>
            {/if}
            <p data-testid="profile-timezone">
              Timezone: {member.timezone ||
                (isOwner ? PROFILE_EMPTY_COPY.timezoneOwner : PROFILE_EMPTY_COPY.timezoneOther)}
            </p>
          </div>
        </div>
      </div>
      <div class="profile-details">
        <section aria-labelledby="profile-about-heading">
          <h2 id="profile-about-heading">About</h2>
          <p class="profile-bio" data-testid="profile-bio">
            {member.bio ||
              (isNewMember
                ? PROFILE_EMPTY_COPY.bioNew
                : isOwner
                  ? PROFILE_EMPTY_COPY.bioOwner
                  : PROFILE_EMPTY_COPY.bioOther(member.username))}
          </p>
        </section>
        <section aria-labelledby="profile-games-heading">
          <h2 id="profile-games-heading">Games</h2>
          <div data-testid="profile-games">
            {#if member.games.length > 0}
              <ul>
                {#each member.games as g}<li>{g}</li>{/each}
              </ul>
            {:else}
              <p>{isOwner ? PROFILE_EMPTY_COPY.gamesOwner : PROFILE_EMPTY_COPY.gamesOther}</p>
            {/if}
          </div>
        </section>
      </div>
    </section>
    {@html avatarIsland}
    {#if isOwner}
      <section
        class="profile-panel profile-new-member"
        aria-labelledby="new-member-heading"
        data-testid={PROFILE_NEW_MEMBER_TESTID}
        hidden={!isNewMember}
      >
        <h2 id="new-member-heading">{PROFILE_NEW_MEMBER_COPY.heading}</h2>
        <p>{PROFILE_NEW_MEMBER_COPY.body}</p>
        <div class="actions">
          <a class="btn" href="#edit-heading" data-testid={PROFILE_NEW_MEMBER_CTA_TESTID}>
            {PROFILE_NEW_MEMBER_COPY.cta}
          </a>
          <a class="btn profile-secondary" href="/events">Find an event</a>
        </div>
      </section>
    {/if}
    {#if stats}
      <section class="profile-panel" aria-labelledby="member-stats-heading" data-testid="profile-stats">
        <h2 id="member-stats-heading">Member stats</h2>
        <dl class="profile-stats-grid">
          {#if stats.rankKey}
            <div>
              <dt>Rank</dt>
              <dd data-testid={PROFILE_RANK_TESTID}>{statsLabel(stats.rankKey)}</dd>
            </div>
          {/if}
          {#if stats.joinedAt}
            <div>
              <dt>Joined</dt>
              <dd data-testid={PROFILE_JOINED_TESTID}>
                <time datetime={stats.joinedAt.toISOString()}>{statsDate(stats.joinedAt)}</time>
              </dd>
            </div>
          {/if}
          {#if stats.tenureDays !== null}
            <div>
              <dt>Tenure</dt>
              <dd>{stats.tenureDays} {stats.tenureDays === 1 ? "day" : "days"}</dd>
            </div>
          {/if}
          <div>
            <dt>Membership</dt>
            <dd>{stats.isCurrentMember ? "Current member" : "Former member"}</dd>
          </div>
          <div>
            <dt>Milestones</dt>
            <dd>{stats.milestonesTruncated ? `${stats.milestones.length}+` : stats.milestones.length}</dd>
          </div>
        </dl>
        <h3>Milestones</h3>
        {#if stats.milestones.length > 0}
          <ol class="profile-milestones">
            {#each stats.milestones as milestone}
              <li>
                <div>
                  <strong>{statsLabel(milestone.type)}</strong>
                  {#if milestone.detail}<p>{milestone.detail}</p>{/if}
                </div>
                <time datetime={milestone.occurredAt.toISOString()}>
                  {statsDate(milestone.occurredAt)}
                </time>
              </li>
            {/each}
          </ol>
        {:else}
          <p>No milestones yet.</p>
        {/if}
      </section>
    {/if}
    {#if isOwner}
      <section
        class="profile-panel profile-editor"
        aria-labelledby="edit-heading"
        data-testid={PROFILE_EDIT_TESTID}
        {...{ [MOUNT_ATTR]: MEMBER_PROFILE_ISLAND }}
        data-member-id={member.id}
        data-saved-bio={saved.bio}
        data-saved-games-text={saved.games_text}
        data-saved-timezone={saved.timezone}
        data-saved-leaderboard-opt-out={saved.leaderboard_opt_out ? "1" : "0"}
      >
        <h2 id="edit-heading" tabindex="-1">Edit your profile</h2>
        <div data-testid="profile-edit-control" hidden>
          <button class="btn" type="button" data-testid="profile-edit-again">Edit your profile</button>
        </div>
        {#if errors && Object.keys(errors).length > 0}
          <div role="alert" tabindex="-1" data-testid={PROFILE_ERROR_TESTID}>
            <ul>
              {#each Object.entries(errors) as [key, message]}
                {@const field = profileFieldForErrorKey(key)}
                <li>
                  {#if field}
                    <a href={`#${PROFILE_FIELD_IDS[field]}`}>{message}</a>
                  {:else}
                    {message}
                  {/if}
                </li>
              {/each}
            </ul>
          </div>
        {/if}
        <form method="post" action={`/members/${member.id}`} data-testid={PROFILE_FORM_TESTID}>
          <input type="hidden" name="_method" value="PATCH" />
          <input type="hidden" name="leaderboard_opt_out" value="0" />
          <label class="profile-field profile-switch">
            <input
              id={PROFILE_FIELD_IDS.leaderboard_opt_out}
              name="leaderboard_opt_out"
              type="checkbox"
              value="1"
              checked={form.leaderboard_opt_out}
              aria-invalid={errors?.leaderboard_opt_out ? "true" : undefined}
              aria-describedby={errors?.leaderboard_opt_out
                ? PROFILE_ERROR_IDS.leaderboard_opt_out
                : undefined}
            />
            Hide me from the member leaderboard
          </label>
          <p class="profile-hint">
            Opted out, you leave every board and every count. Tick to hide, untick to show again.
          </p>
          {#if errors?.leaderboard_opt_out}
            <p id={PROFILE_ERROR_IDS.leaderboard_opt_out} class="error">
              {errors.leaderboard_opt_out}
            </p>
          {/if}
          <label class="profile-field">
            Bio{" "}
            <textarea
              id={PROFILE_FIELD_IDS.bio}
              name="bio"
              rows="4"
              value={form.bio}
              aria-invalid={errors?.bio ? "true" : undefined}
              aria-describedby={errors?.bio ? PROFILE_ERROR_IDS.bio : undefined}
            ></textarea>
          </label>
          {#if errors?.bio}
            <p id={PROFILE_ERROR_IDS.bio} class="error">{errors.bio}</p>
          {/if}
          <label class="profile-field">
            Games (one per line){" "}
            <textarea
              id={PROFILE_FIELD_IDS.games_text}
              name="games_text"
              rows="4"
              value={form.games_text}
              aria-invalid={gamesError ? "true" : undefined}
              aria-describedby={gamesError ? PROFILE_ERROR_IDS.games_text : undefined}
            ></textarea>
          </label>
          {#if gamesError}
            <p id={PROFILE_ERROR_IDS.games_text} class="error">{gamesError}</p>
          {/if}
          <label class="profile-field">
            Timezone{" "}
            <input
              id={PROFILE_FIELD_IDS.timezone}
              name="timezone"
              value={form.timezone}
              placeholder="Europe/London"
              aria-invalid={errors?.timezone ? "true" : undefined}
              aria-describedby={errors?.timezone
                ? `${PROFILE_TIMEZONE_HELP_ID} ${PROFILE_ERROR_IDS.timezone}`
                : PROFILE_TIMEZONE_HELP_ID}
            />
          </label>
          {#if errors?.timezone}
            <p id={PROFILE_ERROR_IDS.timezone} class="error">{errors.timezone}</p>
          {/if}
          <p id={PROFILE_TIMEZONE_HELP_ID} class="profile-hint">{PROFILE_COPY.timezoneHelp}</p>
          <div data-device-timezone hidden>
            <button
              class="btn profile-secondary"
              type="button"
              data-device-timezone-use
              aria-describedby="profile-device-timezone-help"
            >
              {PROFILE_COPY.deviceTimezone}
            </button>
            <p id="profile-device-timezone-help" class="profile-hint">
              {PROFILE_COPY.deviceTimezoneHelp}
            </p>
          </div>
          <div aria-hidden="true" class="sr-only">
            <label>
              Website <input name={PROFILE_HONEY_FIELD} tabindex="-1" autocomplete="off" />
            </label>
          </div>
          <input type="hidden" name={PROFILE_OPENED_AT_FIELD} value={String(Date.now())} />
          <div class="actions">
            <button class="btn" type="submit" data-testid={PROFILE_SAVE_TESTID}>
              {PROFILE_COPY.save}
            </button>
            <button class="btn profile-secondary" type="reset" data-testid={PROFILE_CANCEL_TESTID}>
              {PROFILE_COPY.cancel}
            </button>
          </div>
        </form>
        {@html editorIsland}
      </section>
    {/if}
  </main>
</div>
