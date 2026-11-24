import { Context } from "hono";
import { getPath, tryDecodeURIComponent } from "hono/utils/url";
import { admissionExceptionClass, warnAdmissionStoreFailure } from "../admission-diagnostics";
import { alertRequestError } from "../alerts";
import { isDatabaseQueryCancellation, isDatabaseUnavailable } from "../db/errors";
import type { Env, Session } from "../env";
import {
  BadRequestPage,
  InternalErrorPage,
  badRequest,
  databaseUnavailable,
  forbidden,
  nonOwnerProfileWrite,
  notFoundHandler,
  payloadTooLarge,
  prefersHtmlError,
  rateLimitExceeded,
  varyAccept,
} from "../errors";
import { limitRequestBody } from "../http/body-limit";
import { inviteDestination } from "../invite";
import { PROFILE_COPY } from "../islands/contracts-member-profile";
import { jsonRefusal } from "../json-refusal";
import { createRateLimitedWarn } from "../log-budget";
import { acceptsJson, isJsonMediaType, mediaType } from "../media-type";
import { safeRequestId } from "../request-log";
import { readContextSession } from "../session-hono";
import { expiredWriteBounce } from "../write-recovery";
import { KIT_PROFILE_WRITE_PATH } from "./kit-write-route";
import { ProfilePage } from "./pages";
import {
  admitProfilePatch,
  type ProfileMemberAdmission,
  profileDraftValues,
  saveProfilePatch,
} from "./patch-core";
import type { ProfileFormValues } from "./presentation";
import { profileWriteThrottleFor } from "./routes-admission";
import type { ProfileDeps } from "./routes-shared";
import { profileStores } from "./routes-stores";
import type { MemberStats } from "./stats";
import type { MemberView } from "./store";

type WriteContext = Context<{ Bindings: Env }>;
type Input = Record<string, unknown>;
type WriteDeps = Pick<ProfileDeps, "store" | "stats" | "throttle">;

export type KitProfileWriteDraft = {
  status: 422 | 503;
  member: MemberView;
  stats: MemberStats | null;
  isModerator: boolean;
  errors: Record<string, string>;
  values: ProfileFormValues;
};

const malformedLog = createRateLimitedWarn({ shedLine: "profile.write.shed" });

export const isProfileForm = (request: Request): boolean => {
  const type = mediaType(request.headers.get("content-type"));
  return type === "application/x-www-form-urlencoded" || type === "multipart/form-data";
};

function newContext(request: Request, env: Env, requestId?: string): WriteContext {
  const c = new Context<{ Bindings: Env }>(request, { env, path: getPath(request) });
  const id = safeRequestId(requestId);
  if (id) c.set("requestId", id);
  return c;
}

function logFailure(c: WriteContext, err: unknown, event: string): void {
  // Match the fixed built-in class only. Driver names, causes and messages
  // may contain query text or profile fields.
  console.error(event, {
    exception: admissionExceptionClass(err),
    request_id: safeRequestId(c.get("requestId")),
  });
}

function logWriteError(c: WriteContext, err: unknown): void {
  alertRequestError(new Error("Profile write failed"), {
    method: c.req.method,
    route: KIT_PROFILE_WRITE_PATH,
    requestId: c.get("requestId"),
  });
  logFailure(c, err, "profile write failed");
}

function malformedBody(c: WriteContext, exception: string) {
  const requestId = safeRequestId(c.get("requestId"));
  malformedLog.warn("profile.write.malformed_body", {
    exception,
    // Only called after the media type is admitted.
    content_type: mediaType(c.req.header("content-type")),
    ...(requestId ? { request_id: requestId } : {}),
  });
  return badRequest(c);
}

function unsupportedMediaType(c: WriteContext, json: boolean) {
  varyAccept(c);
  if (json) return jsonRefusal(c, "unsupported_media_type", 415);
  if (prefersHtmlError(c)) return c.html(<BadRequestPage code="415" />, 415);
  return c.text("Unsupported Media Type", 415);
}

async function readFormOverride(c: WriteContext): Promise<Input | null> {
  if (!isProfileForm(c.req.raw)) return null;
  const form = await c.req.parseBody({ all: true }).catch(() => null);
  if (!form || form._method !== "PATCH") return null;
  const { _method, ...input } = form;
  return input;
}

export function profileDraftHeaders(
  status: KitProfileWriteDraft["status"],
): Record<string, string> {
  return status === 503
    ? { "cache-control": "no-store, private", vary: "Accept" }
    : { "cache-control": "private, no-store" };
}

/** Owned route only. The Kit hook checks trusted host and same origin before
 * either entry point reaches the body cap, signed session and owner gate. */
export async function writeKitProfile(
  request: Request,
  env: Env,
  requestId?: string,
  deps: WriteDeps = {},
): Promise<Response | KitProfileWriteDraft> {
  const c = newContext(request, env, requestId);
  const limited = await limitRequestBody(request, "form");
  if (!limited.ok) return limited.status === 413 ? payloadTooLarge(c) : badRequest(c);
  c.req.raw = limited.request;
  c.header("cache-control", "private, no-store");

  let viewer: Session | null = null;
  const admitMember = async (): Promise<ProfileMemberAdmission> => {
    try {
      viewer = await readContextSession(c, false);
    } catch (err) {
      logFailure(c, err, "profiles could not resolve the session; refusing.");
      return { kind: "unavailable" };
    }
    if (!viewer) return { kind: "guest" };
    return viewer.member ? { kind: "member", id: viewer.id } : { kind: "forbidden" };
  };
  const throttle = async (bucket: string) => {
    try {
      return await (deps.throttle ? deps.throttle(bucket) : profileWriteThrottleFor(env, bucket));
    } catch (err) {
      warnAdmissionStoreFailure(c, "profile-write", err);
      return { limited: false } as const;
    }
  };
  const admission = await admitProfilePatch(
    tryDecodeURIComponent(c.req.path.slice("/members/".length)),
    { admitMember, throttle },
  );
  switch (admission.kind) {
    case "guest":
      return expiredWriteBounce(c);
    case "forbidden":
      return forbidden(c);
    case "unavailable":
      c.res = await databaseUnavailable(c);
      c.header("cache-control", "private, no-store");
      return c.res;
    case "limited":
      return rateLimitExceeded(c, admission.retryAfter);
    case "nonOwner":
      return nonOwnerProfileWrite(c);
  }

  const json = acceptsJson(c.req.header("accept"));
  const form = request.method === "POST" ? await readFormOverride(c) : null;
  // The legacy POST gate checks the override before looking up the profile.
  if (request.method === "POST" && !form) {
    c.header("allow", "GET, PATCH, POST");
    varyAccept(c);
    return json ? jsonRefusal(c, "method_not_allowed", 405) : c.text("Method Not Allowed", 405);
  }

  const { storeFor, statsFor } = profileStores(deps);
  try {
    const store = await storeFor(c);
    if (!store) return databaseUnavailable(c);
    const member = await store.find(admission.id);
    if (!member || member.id !== admission.id) return await notFoundHandler(c);

    const isJson = !form && isJsonMediaType(c.req.header("content-type"));
    if (!isJson && !form && !isProfileForm(c.req.raw)) return unsupportedMediaType(c, json);
    let input: unknown;
    try {
      input = form ?? (isJson ? await c.req.json() : { ...(await c.req.parseBody({ all: true })) });
    } catch (err) {
      return malformedBody(c, admissionExceptionClass(err));
    }
    if (!isJson && input != null) {
      const fields = input as Input;
      if (fields.games === undefined && fields.games_text === undefined) fields.games = [];
    }

    const draft = async (
      status: KitProfileWriteDraft["status"],
      errors: Record<string, string>,
    ): Promise<KitProfileWriteDraft> => ({
      status,
      member,
      stats: await statsFor(c, member.id),
      isModerator: viewer?.moderator === true,
      errors,
      values: profileDraftValues(input as Input, member),
    });

    const outcome = await saveProfilePatch(admission.id, input, store);
    if (outcome.kind === "saveFailed") {
      const { error } = outcome;
      logWriteError(c, error);
      if (isDatabaseUnavailable(error)) {
        const uncertain = isDatabaseQueryCancellation(error);
        if (!json)
          return await draft(503, {
            save: uncertain ? PROFILE_COPY.saveUncertain : PROFILE_COPY.saveFailed,
          });
        if (!uncertain) return databaseUnavailable(c);
        c.header("cache-control", "no-store, private");
        varyAccept(c);
        const id = safeRequestId(c.get("requestId"));
        return c.json(
          {
            error: "profile_save_uncertain",
            message: PROFILE_COPY.saveUncertain,
            ...(id ? { request_id: id } : {}),
          },
          503,
        );
      }
      c.header("cache-control", "no-store, private");
      varyAccept(c);
      return prefersHtmlError(c)
        ? c.html(
            <InternalErrorPage
              inviteUrl={inviteDestination(env.DISCORD_INVITE_URL)}
              supportReference={safeRequestId(c.get("requestId"))}
            />,
            500,
          )
        : c.text("Could not save your profile.", 500);
    }
    switch (outcome.kind) {
      case "badRequest":
        return malformedBody(c, "TypeError");
      case "invalid":
        return json
          ? jsonRefusal(c, "invalid", 422, { fields: outcome.fields })
          : await draft(422, outcome.fields);
      case "saved":
        return json ? c.json(outcome.body) : c.redirect(`/members/${admission.id}`, 303);
    }
  } catch (err) {
    logWriteError(c, err);
    if (isDatabaseUnavailable(err)) return databaseUnavailable(c);
    return c.text("Member data is temporarily unavailable.", 503);
  }
}

// Direct PATCH can negotiate HTML too. The browser's native POST action uses
// the Svelte page for the same draft model.
export async function writeKitProfileEndpoint(
  request: Request,
  env: Env,
  requestId?: string,
): Promise<Response> {
  const result = await writeKitProfile(request, env, requestId);
  if (result instanceof Response) return result;
  return renderProfileWriteDraft(request, env, result);
}

export function renderProfileWriteDraft(request: Request, env: Env, draft: KitProfileWriteDraft) {
  const c = newContext(request, env);
  return c.html(
    <ProfilePage
      member={draft.member}
      stats={draft.stats}
      isOwner
      isModerator={draft.isModerator}
      appUrl={env.APP_URL}
      statsDraftWarning
      errors={draft.errors}
      values={draft.values}
    />,
    draft.status,
    profileDraftHeaders(draft.status),
  );
}
