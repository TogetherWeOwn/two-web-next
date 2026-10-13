<script lang="ts">
import {
  MEMBER_PROFILE_ISLAND,
  MOUNT_ATTR,
  PROFILE_AVATAR_TESTID,
  PROFILE_CANCEL_TESTID,
  PROFILE_COPY,
  PROFILE_EDIT_TESTID,
  PROFILE_EMPTY_COPY,
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
  PROFILE_FIELD_IDS,
  PROFILE_SHARE_DESCRIPTION,
  profileInitials,
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
}: {
  member: MemberView;
  stats?: MemberStats | null;
  isOwner: boolean;
  isModerator?: boolean;
  appUrl: string;
  joinResult?: JoinResult | null;
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
const form = $derived({
  bio: member.bio ?? "",
  games_text: member.games.join("\n"),
  timezone: member.timezone ?? "",
});
// A component-level <script> is Svelte's own; the island tags are markup.
const avatarIsland = '<script src="/islands/avatar.js" defer></' + "script>";
const editorIsland = '<script src="/islands/member-profile.js" defer></' + "script>";

const statsLabel = (key: string) =>
  key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const statsDate = (date: Date) =>
  date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
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
        <a class="btn" href="#edit-heading" data-testid={PROFILE_NEW_MEMBER_CTA_TESTID}>
          {PROFILE_NEW_MEMBER_COPY.cta}
        </a>
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
            <dd>{stats.milestones.length}</dd>
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
      >
        <h2 id="edit-heading" tabindex="-1">Edit your profile</h2>
        <div data-testid="profile-edit-control" hidden>
          <button class="btn" type="button" data-testid="profile-edit-again">Edit your profile</button>
        </div>
        <form method="post" action={`/members/${member.id}`} data-testid={PROFILE_FORM_TESTID}>
          <input type="hidden" name="_method" value="PATCH" />
          <label class="profile-field">
            Bio{" "}
            <textarea id={PROFILE_FIELD_IDS.bio} name="bio" rows={4} value={form.bio}></textarea>
          </label>
          <label class="profile-field">
            Games (one per line){" "}
            <textarea
              id={PROFILE_FIELD_IDS.games_text}
              name="games_text"
              rows={4}
              value={form.games_text}
            ></textarea>
          </label>
          <label class="profile-field">
            Timezone{" "}
            <input
              id={PROFILE_FIELD_IDS.timezone}
              name="timezone"
              value={form.timezone}
              placeholder="Europe/London"
            />
          </label>
          <div aria-hidden="true" class="sr-only">
            <label>
              Website <input name={PROFILE_HONEY_FIELD} tabindex={-1} autocomplete="off" />
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
