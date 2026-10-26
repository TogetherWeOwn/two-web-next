// GET /profile and GET /members/:user: the profile page render. Split out of
// src/profiles/routes.tsx; registered after the gate so every read is
// member-gated and access-logged by routes-gate.ts.
import { databaseUnavailableBuffered, NotFoundPage } from "../errors";
import { bufferedMemberHtml, declareMemberResult } from "../member-reads";
import { cachedNotFoundSuggestions } from "../not-found-suggestions";
import { readJoinResult } from "../return-journey";
import { ProfilePage } from "./pages";
import { type Ctx, type ProfileApp, SNOWFLAKE } from "./routes-shared";
import type { ProfileStores } from "./routes-stores";
import { findScheduledGames, findSharedGames } from "./shared-games";

export function registerReadRoutes(
  app: ProfileApp,
  { storeFor, statsFor, publishedGamesFor }: ProfileStores,
) {
  const render = async (c: Ctx, id: string) => {
    // Same per-isolate, DB-source-scoped cached guest snapshot as ordinary
    // 404s and event-detail 404s: one fill per TTL, never one Postgres
    // transaction per probe.
    const notFound = async () =>
      bufferedMemberHtml(
        c,
        <NotFoundPage suggestions={await cachedNotFoundSuggestions(c.env, c.req.path)} />,
        404,
      );
    if (!SNOWFLAKE.test(id)) return notFound();
    const store = await storeFor(c);
    if (!store) return databaseUnavailableBuffered(c);
    const member = await store.find(id);
    // Borrowed non-SQL stores declare retrieved keys, never the requested id.
    declareMemberResult(member ? [member.id] : []);
    if (!member) return notFound();
    const viewer = c.get("viewer");
    const isOwner = viewer.id === member.id;
    // Another member's page marks the games the viewer also plays: at most one
    // extra keyed read of the viewer's own stored row, bounded by the stored
    // list. The boundary filters the viewer out of the audit subjects, so the
    // access log keeps exactly one row for the viewed member. Self reads skip
    // it, as do reads of a member listing no games: findSharedGames([], ...)
    // is [] for any viewer list, so the read would be pure waste and would
    // trip the single-keyed-read pins on game-less profiles.
    const needsMatch = !isOwner && member.games.length > 0;
    const viewerRow = needsMatch ? await store.find(viewer.id) : null;
    const sharedGames = needsMatch ? findSharedGames(member.games, viewerRow?.games ?? []) : [];
    let scheduledGames: Record<string, string> = {};
    if (member.games.length > 0) {
      try {
        scheduledGames = findScheduledGames(member.games, await publishedGamesFor(c));
      } catch {
        // Schedule availability must not refuse an otherwise readable profile.
        scheduledGames = {};
      }
    }
    const joinResult = await readJoinResult(c);
    const stats = await statsFor(c, member.id);
    return bufferedMemberHtml(
      c,
      <ProfilePage
        member={member}
        stats={stats}
        isOwner={isOwner}
        isModerator={viewer.moderator}
        appUrl={c.env.APP_URL}
        joinResult={joinResult}
        sharedGames={sharedGames}
        scheduledGames={scheduledGames}
      />,
    );
  };

  app.get("/profile", (c) => render(c, c.get("viewer").id));
  app.get("/members/:user", (c) => render(c, c.req.param("user")));
}
