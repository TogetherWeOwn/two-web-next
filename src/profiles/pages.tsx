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
  joinResult?: JoinResult | null;
  errors?: Record<string, string>;
  values?: { bio: string; games_text: string; timezone: string };
}> = ({ member, isOwner, appUrl, joinResult, errors, values }) => {
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
        {joinResult ? <JoinResultBanner result={joinResult} /> : null}
        <section aria-labelledby="member-heading" data-testid={PROFILE_VIEW_TESTID}>
          {img ? (
            <img data-testid={PROFILE_AVATAR_TESTID} src={img.src} srcset={img.srcset} alt="" width="64" height="64" loading="eager" />
          ) : (
            <span data-testid={PROFILE_AVATAR_TESTID} aria-hidden="true" class="avatar-initial">
              {[...member.username][0]?.toUpperCase() ?? "?"}
            </span>
          )}
          <h1 id="member-heading" tabindex="-1" data-testid={PROFILE_NAME_TESTID}>{member.username}</h1>
          {member.rank ? <p data-testid={PROFILE_RANK_TESTID}>{member.rank}</p> : null}
          {joined ? <p data-testid={PROFILE_JOINED_TESTID}>Joined {joined}</p> : null}
          {member.timezone ? <p>Timezone: {member.timezone}</p> : null}
          {member.bio ? <p>{member.bio}</p> : <p>No bio yet.</p>}
          {member.games.length > 0 ? (
            <ul>{member.games.map((g) => <li>{g}</li>)}</ul>
          ) : (
            <p>No games listed yet.</p>
          )}
        </section>
        {isOwner ? (
          <section aria-labelledby="edit-heading" data-testid={PROFILE_EDIT_TESTID} {...{ [MOUNT_ATTR]: MEMBER_PROFILE_ISLAND }} data-member-id={member.id}>
            <h2 id="edit-heading" tabindex="-1">Edit your profile</h2>
            {errors && Object.keys(errors).length > 0 ? (
              <ul role="alert" tabindex="-1" data-testid={PROFILE_ERROR_TESTID}>{Object.values(errors).map((e) => <li>{e}</li>)}</ul>
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
