import type { RequestEvent } from "@sveltejs/kit";
import { Context } from "hono";
import type { Env } from "../../../../src/env";
import { KIT_PROFILE_WRITE_ROUTE_ID } from "../../../../src/profiles/kit-write-route";
import {
  isProfileForm,
  type KitProfileWriteDraft,
  writeKitProfile,
} from "../../../../src/profiles/kit-write";
import { ProfilePage } from "../../../../src/profiles/pages";

export const profileDraftHeaders = (status: 422 | 503): Record<string, string> =>
  status === 503
    ? { "cache-control": "no-store, private", vary: "Accept" }
    : { "cache-control": "private, no-store" };

function renderProfileWriteDraft(request: Request, env: Env, draft: KitProfileWriteDraft) {
  return new Context(request).html(
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

export async function writeKitProfileEndpoint(
  request: Request,
  env: Env,
  requestId?: string,
): Promise<Response> {
  const result = await writeKitProfile(request, env, requestId);
  return result instanceof Response ? result : renderProfileWriteDraft(request, env, result);
}

export async function resolveProfileWrite(
  event: RequestEvent,
  render: () => Promise<Response>,
  env: Env,
): Promise<Response> {
  if (event.request.method !== "POST" || event.route.id !== KIT_PROFILE_WRITE_ROUTE_ID) {
    return render();
  }
  // Kit handles non-form bodies and named-action keys before the default action.
  if (
    !isProfileForm(event.request) ||
    Array.from(event.url.searchParams.keys()).some((key) => key.startsWith("/"))
  ) {
    return writeKitProfileEndpoint(event.request, env, event.locals.requestId);
  }
  const response = await render();
  if (event.locals.profileWriteResponse) return event.locals.profileWriteResponse;
  // Preserve the HTML draft when Kit negotiates wildcard Accept as JSON.
  const draft = event.locals.profileWriteDraft;
  if (draft && !response.headers.get("content-type")?.startsWith("text/html")) {
    return renderProfileWriteDraft(event.request, env, draft);
  }
  return response;
}
