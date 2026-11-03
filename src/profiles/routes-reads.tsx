// GET /profile and GET /members/:user: the profile page render. Split out of
// src/profiles/routes.tsx; registered after the gate so every read is
// member-gated and access-logged by routes-gate.ts.
import { dbFor } from "../admin/db";
import { databaseUnavailableBuffered, NotFoundPage } from "../errors";
import { listOwnEchoRows, type OwnEchoRow } from "../events/echoes";
import { bufferedMemberHtml, declareMemberResult } from "../member-reads";
import { cachedNotFoundSuggestions } from "../not-found-suggestions";
import { readJoinResult } from "../return-journey";
import { ProfilePage } from "./pages";
import { type Ctx, type ProfileApp, SNOWFLAKE } from "./routes-shared";
import type { ProfileStores } from "./routes-stores";
import { findSharedGames } from "./shared-games";

export function registerReadRoutes(app: ProfileApp, { storeFor, statsFor }: ProfileStores) {
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
    const joinResult = await readJoinResult(c);
    const stats = await statsFor(c, member.id);
    // F20 own-profile view: the viewer's own played-minutes, newest first.
    // Owner-only (moderators use the admin Echo detail); a failed read omits
    // the section instead of 503ing the profile.
    let ownEchoes: OwnEchoRow[] = [];
    if (isOwner) {
      try {
        const db = await dbFor(c);
        ownEchoes = db ? await listOwnEchoRows(db, viewer.id) : [];
      } catch {
        ownEchoes = [];
      }
    }
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
        ownEchoes={ownEchoes}
      />,
    );
  };

  app.get("/profile", (c) => render(c, c.get("viewer").id));
  app.get("/members/:user", (c) => render(c, c.req.param("user")));
}
