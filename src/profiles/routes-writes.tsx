// PATCH /members/:user and its form-override POST: the profile save. Split out
// of src/profiles/routes.tsx. Admission (throttle, owner only) runs first, then
// the body limit, then the save.
import { requestBodyLimit } from "../body-limit";
import { alertRequestError } from "../alerts";
import { isDatabaseUnavailable } from "../db/errors";
import { databaseUnavailable } from "../errors";
import {
  PROFILE_COPY,
  PROFILE_HONEY_FIELD,
  PROFILE_OPENED_AT_FIELD,
  profileTrapTripped,
} from "../islands/contracts";
import { ProfilePage } from "./pages";
import { admitWrite } from "./routes-admission";
import type { Ctx, ProfileApp, ProfileDeps } from "./routes-shared";
import type { ProfileStores } from "./routes-stores";
import { requestRoute, safeRequestId } from "../request-log";
import { normalizeLeaderboardOptOut, validateProfile } from "./validation";

// UpdateProfileRequest's fields plus the spam-trap pair. Anything else (user_id,
// username, avatar, member…) refuses the whole write: no body key can name
// another member or a roster column past the owner check.
const WRITABLE_FIELDS = new Set([
  "bio",
  "games",
  "games_text",
  "timezone",
  "leaderboard_opt_out",
  PROFILE_HONEY_FIELD,
  PROFILE_OPENED_AT_FIELD,
]);
const UNSUPPORTED_FIELDS = "Only your bio, games, timezone and leaderboard setting can be changed.";

// Media types are case-insensitive (RFC 2045 §5.1) and may carry parameters:
// compare only the type/subtype before `;`, trimmed and lowercased. Anything
// else (including a missing Content-Type) is not a save body at all: Hono's
// parseBody answers `{}` for those, which would otherwise validate as a blank
// profile and silently wipe bio/games/timezone.
const mediaType = (value: string | null | undefined): string =>
  (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

const isJsonMediaType = (value: string | null | undefined): boolean =>
  mediaType(value) === "application/json";
const isFormMediaType = (value: string | null | undefined): boolean => {
  const mt = mediaType(value);
  return mt === "application/x-www-form-urlencoded" || mt === "multipart/form-data";
};

// Response selection mirrors request admission above: Accept lists media
// ranges (`type/subtype`, case-insensitive, optional `;` parameters,
// comma-separated). A range selects JSON only when its type/subtype is
// exactly application/json: substring lookalikes (application/jsonx,
// x-application/json, quoted parameter notes) stay on the HTML path.
// Preference weighting and wildcards are unchanged: any exact JSON range
// selects JSON, anything else keeps the native HTML contract.
const acceptsJson = (value: string | null | undefined): boolean =>
  (value ?? "").split(",").some((range) => mediaType(range) === "application/json");

export function registerWriteRoutes(
  app: ProfileApp,
  deps: ProfileDeps,
  { storeFor, statsFor }: ProfileStores,
) {
  const admit = admitWrite(deps);

  const patch = async (c: Ctx, forced?: Record<string, unknown>) => {
    const id = c.req.param("user") ?? "";
    const store = await storeFor(c);
    if (!store) return databaseUnavailable(c);
    const member = await store.find(id);
    if (!member) return c.notFound();

    let input: Record<string, unknown>;
    let isJson = false;
    try {
      if (forced) input = forced;
      else if (isJsonMediaType(c.req.header("content-type"))) {
        isJson = true;
        input = (await c.req.json()) as Record<string, unknown>;
      } else if (isFormMediaType(c.req.header("content-type"))) {
        input = { ...(await c.req.parseBody({ all: true })) };
      } else {
        c.header("cache-control", "private, no-store");
        return c.text("Unsupported Media Type", 415);
      }
    } catch {
      return c.text("Bad request", 400);
    }
    if (typeof input !== "object" || input === null || Array.isArray(input))
      return c.text("Bad request", 400);
    // `games` must be present (legacy `present|array`). Only a plain form
    // submission treats absence as a blank list; JSON must say so with `games: []`,
    // otherwise an omitted key would silently wipe the stored list.
    if (!isJson && input.games === undefined && input.games_text === undefined) input.games = [];

    const result = Object.keys(input).every((key) => WRITABLE_FIELDS.has(key))
      ? validateProfile(input)
      : { ok: false as const, errors: { fields: UNSUPPORTED_FIELDS } };
    if (!result.ok) {
      if (acceptsJson(c.req.header("accept"))) return c.json({ errors: result.errors }, 422);
      c.status(422);
      return c.html(
        <ProfilePage
          member={member}
          stats={await statsFor(c, member.id)}
          isOwner
          isModerator={c.get("viewer").moderator}
          appUrl={c.env.APP_URL}
          errors={result.errors}
          values={{
            bio: typeof input.bio === "string" ? input.bio : "",
            // Round-trip whichever representation was sent; games_text wins.
            games_text:
              typeof input.games_text === "string"
                ? input.games_text
                : Array.isArray(input.games)
                  ? input.games.filter((g): g is string => typeof g === "string").join("\n")
                  : "",
            timezone: typeof input.timezone === "string" ? input.timezone : "",
            // Keep the switch where the member left it; garbage falls back to stored.
            leaderboard_opt_out:
              normalizeLeaderboardOptOut(input.leaderboard_opt_out) ??
              member.leaderboardOptOut ??
              false,
          }}
        />,
      );
    }
    // Trap (TOG-8715/TOG-9361): only after validation, so errors surface first.
    // A tripped trap skips the write and answers the byte-identical success
    // shape: no oracle, nothing logged.
    const trapped = profileTrapTripped(input, Date.now());
    try {
      if (!trapped) await store.save(id, result.attrs);
    } catch (err) {
      alertRequestError(err, {
        method: c.req.method,
        route: requestRoute(c),
        requestId: c.get("requestId"),
      });
      console.error("profile save failed", {
        exception: (err as Error)?.constructor?.name,
        request_id: safeRequestId(c.get("requestId")),
      });
      if (isDatabaseUnavailable(err)) return databaseUnavailable(c);
      return c.text("Could not save your profile.", 500);
    }
    if (acceptsJson(c.req.header("accept"))) {
      return c.json({ saved: true, message: PROFILE_COPY.saved });
    }
    return c.redirect(`/members/${id}`, 303);
  };

  app.patch("/members/:user", admit, requestBodyLimit("form"), (c) => patch(c));
  // Plain HTML forms cannot PATCH: the edit form posts `_method=PATCH`.
  app.post("/members/:user", admit, requestBodyLimit("form"), async (c) => {
    if (isFormMediaType(c.req.header("content-type"))) {
      const body = await c.req.parseBody({ all: true }).catch(() => null);
      if (body && body._method === "PATCH") {
        const { _method, ...rest } = body;
        return patch(c, rest);
      }
    }
    c.header("Allow", "GET, PATCH, POST");
    return c.text("Method Not Allowed", 405);
  });
}
