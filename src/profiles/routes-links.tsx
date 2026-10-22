// S1 link-in-bio routes (spec section 9, S1): the public no-JS member links
// page plus the owner's editor and both saves. Registered in two halves:
// the public GET runs before the member gate (guests get 200 with no
// session, no cookie and no access-log row), while the editor and the saves
// carry explicit gates — GET reuses memberGate (guest 302 to OAuth), writes
// bounce guests to explicit recovery (303) and refuse non-members (403).
// Saves are owner-only by construction (the key is always the viewer id),
// throttled per member on a links bucket with the one 429 envelope, and
// shape-strict: POST takes the native form, PATCH takes JSON.
import type { Next } from "hono";
import { getSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { sessionStoreFor } from "../admin/guard";
import { alertRequestError } from "../alerts";
import { requestBodyLimit } from "../body-limit";
import { databaseOptions, databaseUrl } from "../db/connection";
import { isDatabaseUnavailable } from "../db/errors";
import type { Env } from "../env";
import {
  BadRequestPage,
  InternalErrorPage,
  NotFoundPage,
  badRequest,
  databaseUnavailable,
  forbidden,
  prefersHtmlError,
  rateLimitExceeded,
  varyAccept,
} from "../errors";
import { inviteDestination } from "../invite";
import { checkJoinThrottle } from "../join/service";
import { acceptsJson, isJsonMediaType, mediaType } from "../media-type";
import { requestRoute, safeRequestId } from "../request-log";
import { SESSION_COOKIE } from "../session-cookie";
import { hashToken, isValidSessionToken, type Sql } from "../sessions";
import { recoveryUrl } from "../write-recovery";
import { LinksEditorPage, MemberLinksPage } from "./links-pages";
import type { MemberLink } from "./links-store";
import { parseLinksFormText, validateLinksJson } from "./links-validation";
import { PROFILE_WRITE_THROTTLE_PER_MINUTE } from "./routes-admission";
import { memberGate } from "./routes-gate";
import {
  type Ctx,
  type ProfileApp,
  type ProfileDeps,
  SNOWFLAKE,
  type Verdict,
  type Viewer,
} from "./routes-shared";
import type { ProfileStores } from "./routes-stores";

const LINKS_SAVED_MESSAGE = "Your links were saved.";

const toDraft = (links: MemberLink[]): string =>
  links.map((link) => `${link.label} | ${link.url}`).join("\n");

const isFormMediaType = (value: string | null | undefined): boolean => {
  const mt = mediaType(value);
  return mt === "application/x-www-form-urlencoded" || mt === "multipart/form-data";
};

const notFound = (c: Ctx) => {
  c.header("cache-control", "private, no-store");
  return c.html(<NotFoundPage />, 404);
};

const unsupportedMedia = (c: Ctx) => {
  c.header("cache-control", "private, no-store");
  varyAccept(c);
  if (prefersHtmlError(c)) return c.html(<BadRequestPage code="415" />, 415);
  return c.text("Unsupported Media Type", 415);
};

/** Write gate: guests to explicit recovery, non-members refused, outage fails closed. */
function linksWriteGate(deps: ProfileDeps) {
  return async (c: Ctx, next: Next) => {
    c.header("cache-control", "private, no-store");
    const token = await getSignedCookie(c, c.env.SESSION_SECRET, SESSION_COOKIE);
    if (!isValidSessionToken(token)) {
      c.header("vary", "Cookie");
      return c.redirect(recoveryUrl("/profile/links"), 303);
    }
    let viewer: Viewer | null = null;
    try {
      const sessions = deps.sessionStore ?? (await sessionStoreFor(c));
      if (!sessions) throw new Error("no session store");
      const row = await sessions.get(await hashToken(token));
      if (row) {
        viewer = {
          id: row.userId,
          username: row.username,
          member: row.member,
          moderator: row.moderator,
        };
      }
    } catch (err) {
      // Bounded like the member gate: class name only, never driver text.
      console.error("member links could not resolve the session; refusing.", {
        exception: err instanceof Error ? err.constructor.name : "unknown",
      });
      c.res = await databaseUnavailable(c);
      c.header("cache-control", "private, no-store");
      return c.res;
    }
    // A cookie whose row is gone (revoked/expired/rotated) is a guest: the
    // recovery page names the editor as the safe return, never a re-submit.
    if (!viewer) {
      c.header("vary", "Cookie");
      return c.redirect(recoveryUrl("/profile/links"), 303);
    }
    if (!viewer.member) return forbidden(c);
    c.set("viewerId", viewer.id);
    c.set("viewer", viewer);
    await next();
    c.header("cache-control", "private, no-store");
  };
}

/** Per-member links write throttle with the one 429 envelope. */
function admitLinksWrite(deps: ProfileDeps) {
  const throttle = async (c: { env: Env }, bucket: string): Promise<Verdict> => {
    if (deps.throttle) return deps.throttle(bucket);
    const url = databaseUrl(c.env);
    if (!url) return { limited: false };
    const sql = postgres(url, databaseOptions) as unknown as Sql;
    return checkJoinThrottle(sql, bucket, PROFILE_WRITE_THROTTLE_PER_MINUTE);
  };

  return async (c: Ctx, next: Next) => {
    const viewer = c.get("viewer");
    const verdict = await throttle(c, `member-links-write:${viewer.id}`).catch(
      () => ({ limited: false }) as Verdict,
    );
    if (verdict.limited) return rateLimitExceeded(c, verdict.retryAfter);
    await next();
  };
}

const saveFailed = (c: Ctx, err: unknown) => {
  alertRequestError(err, {
    method: c.req.method,
    route: requestRoute(c),
    requestId: c.get("requestId"),
  });
  console.error("member links save failed", {
    exception: (err as Error)?.constructor?.name,
    request_id: safeRequestId(c.get("requestId")),
  });
  if (isDatabaseUnavailable(err)) return databaseUnavailable(c);
  c.header("cache-control", "no-store, private");
  varyAccept(c);
  if (prefersHtmlError(c)) {
    return c.html(
      <InternalErrorPage
        inviteUrl={inviteDestination(c.env.DISCORD_INVITE_URL)}
        supportReference={safeRequestId(c.get("requestId"))}
      />,
      500,
    );
  }
  return c.text("Could not save your links.", 500);
};

export function registerPublicLinksRoutes(app: ProfileApp, { storeFor, linksFor }: ProfileStores) {
  app.get("/members/:user/links", async (c) => {
    const id = c.req.param("user") ?? "";
    if (!SNOWFLAKE.test(id)) return notFound(c);
    const store = await storeFor(c);
    const linksStore = await linksFor(c);
    if (!store || !linksStore) return databaseUnavailable(c);
    const member = await store.find(id);
    if (!member) return notFound(c);
    const links = (await linksStore.find(id)) ?? [];
    c.header("cache-control", "private, no-store");
    return c.html(
      <MemberLinksPage
        member={member}
        links={links}
        appUrl={c.env.APP_URL}
        reportHref={inviteDestination(c.env.DISCORD_INVITE_URL)}
      />,
    );
  });
}

export function registerLinksEditorRoutes(
  app: ProfileApp,
  deps: ProfileDeps,
  { storeFor, linksFor }: ProfileStores,
) {
  const readGate = memberGate(deps);
  const writeGate = linksWriteGate(deps);
  const admit = admitLinksWrite(deps);

  app.get("/profile/links", readGate, async (c) => {
    const viewer = c.get("viewer");
    const store = await storeFor(c);
    const linksStore = await linksFor(c);
    if (!store || !linksStore) return databaseUnavailable(c);
    const member = await store.find(viewer.id);
    if (!member) return notFound(c);
    const links = (await linksStore.find(viewer.id)) ?? [];
    return c.html(
      <LinksEditorPage
        member={member}
        appUrl={c.env.APP_URL}
        isModerator={viewer.moderator}
        draft={toDraft(links)}
      />,
    );
  });

  const save = async (c: Ctx, shape: "form" | "json") => {
    const viewer = c.get("viewer");
    const store = await storeFor(c);
    const linksStore = await linksFor(c);
    if (!store || !linksStore) return databaseUnavailable(c);
    const member = await store.find(viewer.id);
    if (!member) return notFound(c);

    if (shape === "form") {
      if (!isFormMediaType(c.req.header("content-type"))) return unsupportedMedia(c);
      let body: Record<string, unknown>;
      try {
        body = { ...(await c.req.parseBody({ all: true })) };
      } catch {
        return badRequest(c);
      }
      const result = parseLinksFormText(body.links_text);
      if (!result.ok) {
        c.status(422);
        return c.html(
          <LinksEditorPage
            member={member}
            appUrl={c.env.APP_URL}
            isModerator={viewer.moderator}
            draft={typeof body.links_text === "string" ? body.links_text : ""}
            errors={result.errors}
          />,
        );
      }
      try {
        await linksStore.save(viewer.id, result.links);
      } catch (err) {
        return saveFailed(c, err);
      }
      return c.redirect(`/members/${viewer.id}/links`, 303);
    }

    if (!isJsonMediaType(c.req.header("content-type"))) return unsupportedMedia(c);
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      return badRequest(c);
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) return badRequest(c);
    const result = validateLinksJson(input as Record<string, unknown>);
    if (!result.ok) {
      // The write-path 422 pattern: the validated log id rides along when the
      // requestLog context set one, never raw client header bytes.
      const requestId = safeRequestId(c.get("requestId"));
      return c.json(
        { errors: result.errors, ...(requestId ? { request_id: requestId } : {}) },
        422,
      );
    }
    try {
      await linksStore.save(viewer.id, result.links);
    } catch (err) {
      return saveFailed(c, err);
    }
    if (acceptsJson(c.req.header("accept"))) {
      return c.json({ saved: true, message: LINKS_SAVED_MESSAGE });
    }
    return c.redirect(`/members/${viewer.id}/links`, 303);
  };

  app.post("/profile/links", requestBodyLimit("form"), writeGate, admit, (c) => save(c, "form"));
  app.patch("/profile/links", requestBodyLimit("form"), writeGate, admit, (c) => save(c, "json"));
}
