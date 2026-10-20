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

// Stable field/error ids for profile validation association.
// The server `games` key maps to the `games_text` control; any other key is
// global and stays in the summary without a fabricated control link.
export const PROFILE_FIELD_IDS = {
  bio: "profile-bio",
  games_text: "profile-games-text",
  timezone: "profile-timezone",
  leaderboard_opt_out: "profile-leaderboard-opt-out",
} as const;
type ProfileField = keyof typeof PROFILE_FIELD_IDS;
export const PROFILE_ERROR_IDS: Record<ProfileField, string> = {
  bio: "profile-bio-error",
  games_text: "profile-games-text-error",
  timezone: "profile-timezone-error",
  leaderboard_opt_out: "profile-leaderboard-opt-out-error",
};
export const profileFieldForErrorKey = (key: string): ProfileField | null =>
  key === "bio"
    ? "bio"
    : key === "games" || key === "games_text"
      ? "games_text"
      : key === "timezone"
        ? "timezone"
        : key === "leaderboard_opt_out"
          ? "leaderboard_opt_out"
          : null;
export const statsLabel = (key: string) =>
  key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
// Legacy parity: the avatar fallback is the first two code points, uppercased.
export const profileInitials = (username: string) =>
  [...username].slice(0, 2).join("").toUpperCase() || "?";
export const statsDate = (date: Date) =>
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
        <dd>
          {stats.milestonesTruncated ? `${stats.milestones.length}+` : stats.milestones.length}
        </dd>
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

// Failed-save re-render shape, shared with the Svelte view: preserved inputs
// plus the 422 error bag, so both renderers show the same form.
export type ProfileFormValues = {
  bio: string;
  games_text: string;
  timezone: string;
  leaderboard_opt_out: boolean;
};

export const ProfilePage: FC<{
  member: MemberView;
  isOwner: boolean;
  /** Viewer's session moderator bit: only decides whether the /admin shortcut renders. */
  isModerator?: boolean;
  appUrl: string;
  joinResult?: JoinResult | null;
  stats?: MemberStats | null;
  errors?: Record<string, string>;
  values?: ProfileFormValues;
}> = ({ member, isOwner, isModerator, appUrl, joinResult, stats, errors, values }) => {
  const img = profileAvatarSrcset(member.id, member.avatar);
  const joined = profileJoinedMonth(member.joinedAt ?? null);
  const isNewMember = profileIsNewMember(member);
  const form = values ?? {
    bio: member.bio ?? "",
    games_text: member.games.join("\n"),
    timezone: member.timezone ?? "",
    leaderboard_opt_out: member.leaderboardOptOut ?? false,
  };
  // Saved baseline for the island: on a native 422 the controls hold the
  // rejected draft B while these attributes hold the persisted profile A, so
  // the enhancement can treat B as unsaved work and Cancel can restore A.
  // On an ordinary GET both sides are A and re-pinning is a no-op.
  const saved = {
    bio: member.bio ?? "",
    games_text: member.games.join("\n"),
    timezone: member.timezone ?? "",
    leaderboard_opt_out: member.leaderboardOptOut ?? false,
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
            <a class="btn profile-secondary" href="/events">
              Events
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
            <div class="actions">
              <a class="btn" href="#edit-heading" data-testid={PROFILE_NEW_MEMBER_CTA_TESTID}>
                {PROFILE_NEW_MEMBER_COPY.cta}
              </a>
              <a class="btn profile-secondary" href="/events">
                Find an event
              </a>
            </div>
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
            data-saved-bio={saved.bio}
            data-saved-games-text={saved.games_text}
            data-saved-timezone={saved.timezone}
            data-saved-leaderboard-opt-out={saved.leaderboard_opt_out ? "1" : "0"}
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
                  {Object.entries(errors).map(([key, message]) => {
                    const field = profileFieldForErrorKey(key);
                    return field ? (
                      <li>
                        <a href={`#${PROFILE_FIELD_IDS[field]}`}>{message}</a>
                      </li>
                    ) : (
                      <li>{message}</li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            <form method="post" action={`/members/${member.id}`} data-testid={PROFILE_FORM_TESTID}>
              <input type="hidden" name="_method" value="PATCH" />
              {/* Unchecked still submits: the hidden 0 keeps the choice explicit
                  so an absent key always means "leave the stored choice alone". */}
              <input type="hidden" name="leaderboard_opt_out" value="0" />
              <label class="profile-field profile-switch">
                <input
                  id={PROFILE_FIELD_IDS.leaderboard_opt_out}
                  name="leaderboard_opt_out"
                  type="checkbox"
                  value="1"
                  checked={form.leaderboard_opt_out}
                  aria-invalid={errors?.leaderboard_opt_out ? "true" : undefined}
                  aria-describedby={
                    errors?.leaderboard_opt_out ? PROFILE_ERROR_IDS.leaderboard_opt_out : undefined
                  }
                />
                Hide me from the member leaderboard
              </label>
              <p class="profile-hint">
                Opted out, you leave every board and every count. Tick to hide, untick to show
                again.
              </p>
              {errors?.leaderboard_opt_out ? (
                <p id={PROFILE_ERROR_IDS.leaderboard_opt_out} class="error">
                  {errors.leaderboard_opt_out}
                </p>
              ) : null}
              {/* Native maxlength counts UTF-16 units; code-point limits belong to the validators. */}
              <label class="profile-field">
                Bio{" "}
                <textarea
                  id={PROFILE_FIELD_IDS.bio}
                  name="bio"
                  rows={4}
                  aria-invalid={errors?.bio ? "true" : undefined}
                  aria-describedby={errors?.bio ? PROFILE_ERROR_IDS.bio : undefined}
                >
                  {form.bio}
                </textarea>
              </label>
              {errors?.bio ? (
                <p id={PROFILE_ERROR_IDS.bio} class="error">
                  {errors.bio}
                </p>
              ) : null}
              <label class="profile-field">
                Games (one per line){" "}
                <textarea
                  id={PROFILE_FIELD_IDS.games_text}
                  name="games_text"
                  rows={4}
                  aria-invalid={errors && (errors.games ?? errors.games_text) ? "true" : undefined}
                  aria-describedby={
                    errors && (errors.games ?? errors.games_text)
                      ? PROFILE_ERROR_IDS.games_text
                      : undefined
                  }
                >
                  {form.games_text}
                </textarea>
              </label>
              {errors && (errors.games ?? errors.games_text) ? (
                <p id={PROFILE_ERROR_IDS.games_text} class="error">
                  {errors.games ?? errors.games_text}
                </p>
              ) : null}
              <label class="profile-field">
                Timezone{" "}
                <input
                  id={PROFILE_FIELD_IDS.timezone}
                  name="timezone"
                  value={form.timezone}
                  placeholder="Europe/London"
                  aria-invalid={errors?.timezone ? "true" : undefined}
                  aria-describedby={
                    errors?.timezone ? PROFILE_ERROR_IDS.timezone : "profile-timezone-help"
                  }
                />
              </label>
              {errors?.timezone ? (
                <p id={PROFILE_ERROR_IDS.timezone} class="error">
                  {errors.timezone}
                </p>
              ) : null}
              <p id="profile-timezone-help" class="profile-hint">
                {PROFILE_COPY.timezoneHelp}
              </p>
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
