import type { FC } from "hono/jsx";
import { Layout } from "../pages";
import type { MemberView } from "./store";

const AVATAR = /^[a-z0-9_]{1,64}$/i;

function avatarUrl(m: MemberView): string | null {
  return m.avatar && AVATAR.test(m.avatar) ? `https://cdn.discordapp.com/avatars/${m.id}/${m.avatar}.png?size=128` : null;
}

export const ProfilePage: FC<{
  member: MemberView;
  isOwner: boolean;
  errors?: Record<string, string>;
  values?: { bio: string; games_text: string; timezone: string };
}> = ({ member, isOwner, errors, values }) => {
  const img = avatarUrl(member);
  const form = values ?? { bio: member.bio ?? "", games_text: member.games.join("\n"), timezone: member.timezone ?? "" };
  return (
    <Layout title={`${member.username} — Together We Own`} robots="noindex, nofollow">
      <header class="bar">
        <a class="brand" href="/">TWO</a>
        <nav>
          <a class="btn" href="/profile">Your profile</a>
        </nav>
      </header>
      <main>
        <section aria-labelledby="member-heading">
          {img ? <img src={img} alt="" width="64" height="64" /> : null}
          <h1 id="member-heading">{member.username}</h1>
          {member.timezone ? <p>Timezone: {member.timezone}</p> : null}
          {member.bio ? <p>{member.bio}</p> : <p>No bio yet.</p>}
          {member.games.length > 0 ? (
            <ul>{member.games.map((g) => <li>{g}</li>)}</ul>
          ) : (
            <p>No games listed yet.</p>
          )}
        </section>
        {isOwner ? (
          <section aria-labelledby="edit-heading">
            <h2 id="edit-heading">Edit your profile</h2>
            {errors && Object.keys(errors).length > 0 ? (
              <ul role="alert">{Object.values(errors).map((e) => <li>{e}</li>)}</ul>
            ) : null}
            <form method="post" action={`/members/${member.id}`}>
              <input type="hidden" name="_method" value="PATCH" />
              <label>Bio <textarea name="bio" maxlength="1000">{form.bio}</textarea></label>
              <label>Games (one per line) <textarea name="games_text" maxlength="1700">{form.games_text}</textarea></label>
              <label>Timezone <input name="timezone" value={form.timezone} placeholder="Europe/London" /></label>
              <button class="btn" type="submit">Save</button>
            </form>
          </section>
        ) : null}
      </main>
    </Layout>
  );
};
