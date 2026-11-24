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

export function profileDraftHeaders(
  status: KitProfileWriteDraft["status"],
): Record<string, string> {
  return status === 503
    ? { "cache-control": "no-store, private", vary: "Accept" }
    : { "cache-control": "private, no-store" };
}

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

// Programmatic requests can still negotiate the legacy HTML draft envelope.
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
  // The ownership hook has already checked the origin. Kit would reject
  // non-form POSTs or dispatch named-action keys before our default action.
  // Preserve the public POST contract and treat those query keys as inert.
  if (
    !isProfileForm(event.request) ||
    Array.from(event.url.searchParams.keys()).some((key) => key.startsWith("/"))
  ) {
    return writeKitProfileEndpoint(event.request, env, event.locals.requestId);
  }
  const response = await render();
  if (event.locals.profileWriteResponse) return event.locals.profileWriteResponse;
  // Kit can serialize fail() as JSON for wildcard Accept ranges. The profile
  // contract selects JSON only for an explicit application/json range.
  const draft = event.locals.profileWriteDraft;
  if (draft && !response.headers.get("content-type")?.startsWith("text/html")) {
    return renderProfileWriteDraft(event.request, env, draft);
  }
  return response;
}
