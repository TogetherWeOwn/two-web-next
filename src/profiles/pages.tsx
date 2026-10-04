import type { FC } from "hono/jsx";
import { JoinResultBanner, Layout } from "../pages";
import type { JoinResult } from "../return-journey";
import { canonicalUrl } from "../seo";
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
} from "../islands/contracts";
import type { MemberView } from "./store";
import type { MemberStats } from "./stats";

const statsLabel = (key: string) =>
  key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
// Legacy parity: the avatar fallback is the first two code points, uppercased.
export const profileInitials = (username: string) =>
  [...username].slice(0, 2).join("").toUpperCase() || "?";
const statsDate = (date: Date) =>
  date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

const MemberStatsBlock: FC<{ stats: MemberStats }> = ({ stats }) => (
  <section class="profile-panel" aria-labelledby="member-stats-heading" data-testid="profile-stats">
    <h2 id="member-stats-heading">Member stats</h2>
    <dl class="profile-stats-grid">
      {stats.rankKey ? (
        <div>
          <dt>Rank</dt>
          <dd data-testid={PROFILE_RANK_TESTID}>{statsLabel(stats.rankKey)}</dd>
        </div>
      ) : null}
      {stats.joinedAt ? (
        <div>
          <dt>Joined</dt>
          <dd data-testid={PROFILE_JOINED_TESTID}>
            <time datetime={stats.joinedAt.toISOString()}>{statsDate(stats.joinedAt)}</time>
          </dd>
        </div>
      ) : null}
      {stats.tenureDays !== null ? (
        <div>
          <dt>Tenure</dt>
          <dd>
            {stats.tenureDays} {stats.tenureDays === 1 ? "day" : "days"}
          </dd>
        </div>
      ) : null}
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
    {stats.milestones.length > 0 ? (
      <ol class="profile-milestones">
        {stats.milestones.map((milestone) => (
          <li>
            <div>
              <strong>{statsLabel(milestone.type)}</strong>
              {milestone.detail ? <p>{milestone.detail}</p> : null}
            </div>
            <time datetime={milestone.occurredAt.toISOString()}>
              {statsDate(milestone.occurredAt)}
            </time>
          </li>
        ))}
      </ol>
    ) : (
      <p>No milestones yet.</p>
    )}
  </section>
);

// Share tags (TOG-6793): the canonical is always the shareable member URL,
// so /profile and /members/{user} never present as duplicates. The
// description stays generic on purpose — the only member data in the tags is
// the name already in the title. Guests are bounced to login before any
// profile HTML renders, so no tags can leak to them.
export const PROFILE_SHARE_DESCRIPTION = "A member of Together We Own.";

export const ProfilePage: FC<{
  member: MemberView;
  isOwner: boolean;
  /** Viewer's session moderator bit: only decides whether the /admin shortcut renders. */
  isModerator?: boolean;
  appUrl: string;
  joinResult?: JoinResult | null;
  stats?: MemberStats | null;
  errors?: Record<string, string>;
  values?: { bio: string; games_text: string; timezone: string };
}> = ({ member, isOwner, isModerator, appUrl, joinResult, stats, errors, values }) => {
  const img = profileAvatarSrcset(member.id, member.avatar);
  const joined = profileJoinedMonth(member.joinedAt ?? null);
  const isNewMember = profileIsNewMember(member);
  const form = values ?? {
    bio: member.bio ?? "",
    games_text: member.games.join("\n"),
    timezone: member.timezone ?? "",
  };
  return (
    <Layout
      title={`${member.username} — Member profile`}
      canonical={canonicalUrl(appUrl, `/members/${member.id}`)}
      shareDescription={PROFILE_SHARE_DESCRIPTION}
      robots="noindex, nofollow"
      theme="profile"
    >
      <header class="bar profile-header-bar">
        <a class="brand" href="/">
          TWO
        </a>
        <div class="profile-header-actions">
          <nav aria-label="Primary">
            <a class="btn" href="/profile">
              Your profile
            </a>
            {/* Convenience link only: /admin still 403s anyone without the moderator bit. */}
            {isModerator ? (
              <a class="btn profile-secondary" href="/admin" data-testid="profile-admin-link">
                Moderator admin
              </a>
            ) : null}
          </nav>
          <form method="post" action="/logout" data-testid="profile-signout">
            <button type="submit" class="link">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main id="main" tabindex={-1}>
        {joinResult ? <JoinResultBanner result={joinResult} /> : null}
        <section
          class="profile-player"
          aria-labelledby="member-heading"
          data-testid={PROFILE_VIEW_TESTID}
        >
          <div class="profile-identity">
            <span
              data-testid={PROFILE_AVATAR_TESTID}
              data-avatar=""
              aria-hidden="true"
              class="avatar"
            >
              {img ? (
                <img
                  src={img.src}
                  srcset={img.srcset}
                  alt=""
                  width="64"
                  height="64"
                  loading="eager"
                />
              ) : null}
              <span data-avatar-initial="" class="avatar-initial" hidden={!!img}>
                {profileInitials(member.username)}
              </span>
            </span>
            <div>
              <p class="profile-caption">Member profile</p>
              <h1 id="member-heading" tabindex={-1} data-testid={PROFILE_NAME_TESTID}>
                {member.username}
              </h1>
              <p class="profile-handle" data-testid="profile-handle">
                @{member.username}
              </p>
              <div class="profile-meta">
                <p class="profile-chip" data-testid="profile-provenance">
                  From Discord
                </p>
                {!stats?.joinedAt && joined ? (
                  <p data-testid={PROFILE_JOINED_TESTID}>Joined {joined}</p>
                ) : null}
                <p data-testid="profile-timezone">
                  {`Timezone: ${
                    member.timezone ||
                    (isOwner ? PROFILE_EMPTY_COPY.timezoneOwner : PROFILE_EMPTY_COPY.timezoneOther)
                  }`}
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
                {member.games.length > 0 ? (
                  <ul>
                    {member.games.map((g) => (
                      <li>{g}</li>
                    ))}
                  </ul>
                ) : (
                  <p>{isOwner ? PROFILE_EMPTY_COPY.gamesOwner : PROFILE_EMPTY_COPY.gamesOther}</p>
                )}
              </div>
            </section>
          </div>
        </section>
        <script src="/islands/avatar.js" defer></script>
        {isOwner ? (
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
        ) : null}
        {stats ? <MemberStatsBlock stats={stats} /> : null}
        {isOwner ? (
          <section
            class="profile-panel profile-editor"
            aria-labelledby="edit-heading"
            data-testid={PROFILE_EDIT_TESTID}
            {...{ [MOUNT_ATTR]: MEMBER_PROFILE_ISLAND }}
            data-member-id={member.id}
          >
            <h2 id="edit-heading" tabindex={-1}>
              Edit your profile
            </h2>
            <div data-testid="profile-edit-control" hidden>
              <button class="btn" type="button" data-testid="profile-edit-again">
                Edit your profile
              </button>
            </div>
            {errors && Object.keys(errors).length > 0 ? (
              <div role="alert" tabindex={-1} data-testid={PROFILE_ERROR_TESTID}>
                <ul>
                  {Object.values(errors).map((e) => (
                    <li>{e}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <form method="post" action={`/members/${member.id}`} data-testid={PROFILE_FORM_TESTID}>
              <input type="hidden" name="_method" value="PATCH" />
              {/* Native maxlength counts UTF-16 units; code-point limits belong to the validators. */}
              <label class="profile-field">
                Bio{" "}
                <textarea name="bio" rows={4}>
                  {form.bio}
                </textarea>
              </label>
              <label class="profile-field">
                Games (one per line){" "}
                <textarea name="games_text" rows={4}>
                  {form.games_text}
                </textarea>
              </label>
              <label class="profile-field">
                Timezone <input name="timezone" value={form.timezone} placeholder="Europe/London" />
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
                <button
                  class="btn profile-secondary"
                  type="reset"
                  data-testid={PROFILE_CANCEL_TESTID}
                >
                  {PROFILE_COPY.cancel}
                </button>
              </div>
            </form>
            <script src="/islands/member-profile.js" defer></script>
          </section>
        ) : null}
      </main>
    </Layout>
  );
};
