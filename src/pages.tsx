import type { FC, PropsWithChildren } from "hono/jsx";
import type { Session } from "./env";

const Layout: FC<PropsWithChildren<{ title: string }>> = ({ title, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <meta name="description" content="Together We Own: a close-knit adult gaming community, founded 1998." />
      <link rel="stylesheet" href="/styles.css" />
    </head>
    <body>{children}</body>
  </html>
);

export type Notice = "joined" | "already_member" | "join_failed" | "signin_failed" | null;

const NOTICES: Record<Exclude<Notice, null>, string> = {
  joined: "You're in. Welcome to the TWO Discord.",
  already_member: "Signed in. You're already in the TWO Discord.",
  join_failed: "Signed in, but we couldn't add you to the Discord automatically. Use the invite link below.",
  signin_failed: "Discord sign-in didn't complete. Please try again.",
};

export const Home: FC<{ session: Session | null; notice: Notice; inviteUrl: string }> = ({ session, notice, inviteUrl }) => (
  <Layout title="Together We Own — adult gaming community">
    <header class="bar">
      <a class="brand" href="/">TWO</a>
      <nav>
        {session ? (
          <form method="post" action="/logout">
            <span class="who">{session.username}</span>
            <button type="submit" class="link">Sign out</button>
          </form>
        ) : (
          <a class="btn" href="/auth/discord" data-testid="signin">Sign in with Discord</a>
        )}
      </nav>
    </header>
    <main>
      {notice && <p class="notice" role="status" data-testid="notice">{NOTICES[notice]}</p>}
      <section class="hero">
        <p class="strap">A close-knit gaming clan / mostly evenings / 18+</p>
        <h1>We spent most of our life private. Now you can just turn up.</h1>
        <p class="lead">Small enough that people notice when you come back.</p>
        {session?.member ? (
          <a class="btn" href={inviteUrl}>Open Discord</a>
        ) : (
          <a class="btn" href="/auth/discord" data-testid="join">Join with Discord</a>
        )}
        {notice === "join_failed" && <p><a href={inviteUrl}>Join with an invite link instead</a></p>}
      </section>
      <section>
        <h2>No application. No interview.</h2>
        <p>Show up a few times. Play. Become a Member. The ladder records trust and time, not grind.</p>
      </section>
      <section>
        <h2>Not a crowd. A place that knows your name.</h2>
        <p>The community is voice-first. Game nights get posted in the Discord first.</p>
      </section>
    </main>
    <footer>Together We Own · adult gaming community · founded 1998</footer>
  </Layout>
);
