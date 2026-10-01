import type { FC } from "hono/jsx";
import { Layout } from "../pages";
import { canonicalUrl } from "../seo";
import {
  MEMBER_PROFILE_ISLAND,
  MOUNT_ATTR,
  PROFILE_AVATAR_TESTID,
  PROFILE_CANCEL_TESTID,
  PROFILE_COPY,
  PROFILE_EDIT_TESTID,
  PROFILE_ERROR_TESTID,
  PROFILE_FORM_TESTID,
  PROFILE_HONEY_FIELD,
  PROFILE_JOINED_TESTID,
  PROFILE_NAME_TESTID,
  PROFILE_OPENED_AT_FIELD,
  PROFILE_RANK_TESTID,
  PROFILE_SAVE_TESTID,
  PROFILE_VIEW_TESTID,
  profileAvatarSrcset,
  profileJoinedMonth,
} from "../islands/contracts";
import type { MemberView } from "./store";
import type { MemberStats } from "./stats";

const statsLabel = (key: string) => key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
const statsDate = (date: Date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const MemberStatsBlock: FC<{ stats: MemberStats }> = ({ stats }) => (
  <section aria-labelledby="member-stats-heading" data-testid="profile-stats">
    <h2 id="member-stats-heading">Member stats</h2>
    <dl>
      {stats.rankKey ? <><dt>Rank</dt><dd data-testid={PROFILE_RANK_TESTID}>{statsLabel(stats.rankKey)}</dd></> : null}
      {stats.joinedAt ? <><dt>Joined</dt><dd data-testid={PROFILE_JOINED_TESTID}><time datetime={stats.joinedAt.toISOString()}>{statsDate(stats.joinedAt)}</time></dd></> : null}
      {stats.tenureDays !== null ? <><dt>Tenure</dt><dd>{stats.tenureDays} {stats.tenureDays === 1 ? "day" : "days"}</dd></> : null}
      <dt>Membership</dt><dd>{stats.isCurrentMember ? "Current member" : "Former member"}</dd>
    </dl>
    <h3>Milestones</h3>
    {stats.milestones.length > 0 ? (
      <ol>{stats.milestones.map((milestone) => (
        <li>
          {statsLabel(milestone.type)}{milestone.detail ? ` — ${milestone.detail}` : ""}
          {" · "}<time datetime={milestone.occurredAt.toISOString()}>{statsDate(milestone.occurredAt)}</time>
        </li>
      ))}</ol>
    ) : <p>No milestones yet.</p>}
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
  appUrl: string;
  stats?: MemberStats | null;
  errors?: Record<string, string>;
  values?: { bio: string; games_text: string; timezone: string };
}> = ({ member, isOwner, appUrl, stats, errors, values }) => {
  const img = profileAvatarSrcset(member.id, member.avatar);
  const joined = profileJoinedMonth(member.joinedAt ?? null);
  const form = values ?? { bio: member.bio ?? "", games_text: member.games.join("\n"), timezone: member.timezone ?? "" };
  return (
    <Layout
      title={`${member.username} — Member profile`}
      canonical={canonicalUrl(appUrl, `/members/${member.id}`)}
      shareDescription={PROFILE_SHARE_DESCRIPTION}
      robots="noindex, nofollow"
    >
      <header class="bar">
        <a class="brand" href="/">TWO</a>
        <nav aria-label="Primary">
          <a class="btn" href="/profile">Your profile</a>
        </nav>
      </header>
      <main id="main" tabindex={-1}>
        <section aria-labelledby="member-heading" data-testid={PROFILE_VIEW_TESTID}>
          <span data-testid={PROFILE_AVATAR_TESTID} data-avatar="" aria-hidden="true" class="avatar">
            {img ? <img src={img.src} srcset={img.srcset} alt="" width="64" height="64" loading="eager" /> : null}
            <span data-avatar-initial="" class="avatar-initial" hidden={!!img}>
              {[...member.username][0]?.toUpperCase() ?? "?"}
            </span>
          </span>
          <h1 id="member-heading" tabindex="-1" data-testid={PROFILE_NAME_TESTID}>{member.username}</h1>
          {!stats?.rankKey && member.rank ? <p data-testid={PROFILE_RANK_TESTID}>{member.rank}</p> : null}
          {!stats?.joinedAt && joined ? <p data-testid={PROFILE_JOINED_TESTID}>Joined {joined}</p> : null}
          <p data-testid="profile-timezone" hidden={!member.timezone}>{member.timezone ? `Timezone: ${member.timezone}` : ""}</p>
          <p data-testid="profile-bio">{member.bio || "No bio yet."}</p>
          <div data-testid="profile-games">
            {member.games.length > 0 ? (
              <ul>{member.games.map((g) => <li>{g}</li>)}</ul>
            ) : (
              <p>No games listed yet.</p>
            )}
          </div>
        </section>
        <script src="/islands/avatar.js" defer></script>
        {stats ? <MemberStatsBlock stats={stats} /> : null}
        {isOwner ? (
          <section aria-labelledby="edit-heading" data-testid={PROFILE_EDIT_TESTID} {...{ [MOUNT_ATTR]: MEMBER_PROFILE_ISLAND }} data-member-id={member.id}>
            <h2 id="edit-heading" tabindex="-1">Edit your profile</h2>
            <div data-testid="profile-edit-control" hidden>
              <button class="btn" type="button" data-testid="profile-edit-again">Edit your profile</button>
            </div>
            {errors && Object.keys(errors).length > 0 ? (
              <div role="alert" tabindex="-1" data-testid={PROFILE_ERROR_TESTID}><ul>{Object.values(errors).map((e) => <li>{e}</li>)}</ul></div>
            ) : null}
            <form method="post" action={`/members/${member.id}`} data-testid={PROFILE_FORM_TESTID}>
              <input type="hidden" name="_method" value="PATCH" />
              <label>Bio <textarea name="bio" maxlength="1000">{form.bio}</textarea></label>
              <label>Games (one per line) <textarea name="games_text" maxlength="1700">{form.games_text}</textarea></label>
              <label>Timezone <input name="timezone" value={form.timezone} placeholder="Europe/London" /></label>
              <div aria-hidden="true" style="position:absolute;left:-10000px">
                <label>Website <input name={PROFILE_HONEY_FIELD} tabindex="-1" autocomplete="off" /></label>
              </div>
              <input type="hidden" name={PROFILE_OPENED_AT_FIELD} value={String(Date.now())} />
              <button class="btn" type="submit" data-testid={PROFILE_SAVE_TESTID}>{PROFILE_COPY.save}</button>
              <button class="btn" type="reset" data-testid={PROFILE_CANCEL_TESTID}>{PROFILE_COPY.cancel}</button>
            </form>
            <script src="/islands/member-profile.js" defer></script>
          </section>
        ) : null}
      </main>
    </Layout>
  );
};
