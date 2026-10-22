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
    const joinResult = await readJoinResult(c);
    const stats = await statsFor(c, member.id);
    return bufferedMemberHtml(
      c,
      <ProfilePage
        member={member}
        stats={stats}
        isOwner={viewer.id === member.id}
        isModerator={viewer.moderator}
        appUrl={c.env.APP_URL}
        joinResult={joinResult}
      />,
    );
  };

  app.get("/profile", (c) => render(c, c.get("viewer").id));
  app.get("/members/:user", (c) => render(c, c.req.param("user")));
}
