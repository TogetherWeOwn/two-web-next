import { error, fail, redirect } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { parse } from "hono/utils/cookie";
import { JOURNEY_TTL_SECONDS, LOGIN_INTENDED_COOKIE } from "../../../../../src/return-journey";
import type { Actions, PageServerLoad } from "./$types";
import { kitProfileDeps, resolveKitProfile } from "../../../../../src/profiles/kit";
import { writeKitProfile } from "../../../../../src/profiles/kit-write";
import { profileDraftHeaders } from "#lib/server/profile-write.ts";

// Server-rendered only: the Hono page ships no Svelte hydration bundle (its
// interactivity is the existing /islands/*.js), so the Kit page carries none
// that the CSP (script-src 'self') would block.
export const csr = false;

// Same reads and cache policy as the Hono GET /members/:user handler
// (src/profiles/routes-reads.tsx): the retrieved member record, member-gated,
// audited by the hook's member-read boundary before any bytes leave.
export const load: PageServerLoad = async ({ locals, params, url, cookies, setHeaders }) => {
  const draft = locals.profileWriteDraft;
  if (draft) {
    setHeaders(profileDraftHeaders(draft.status));
    return {
      member: draft.member,
      stats: draft.stats,
      isOwner: true,
      isModerator: draft.isModerator,
      appUrl: env.APP_URL,
      joinResult: null,
      sharedGames: [],
    };
  }
  const { storeFor, statsFor, sessionSecret } = kitProfileDeps(env);
  const outcome = await resolveKitProfile(
    {
      session: { status: locals.status ?? "unknown", session: locals.session ?? null },
      requestedId: params.user,
      joinResult: locals.joinResult ?? null,
      url: url.href,
    },
    { store: await storeFor(), stats: (id) => statsFor(id), sessionSecret },
  );
  // redirect()/error() never return: after these guards the outcome is ok.
  if (outcome.kind === "redirect") {
    if (outcome.intendedCookie) {
      // Decode once: SvelteKit's cookies API encodes the signed value again.
      const intended = parse(outcome.intendedCookie)[LOGIN_INTENDED_COOKIE] ?? "";
      cookies.set(LOGIN_INTENDED_COOKIE, intended, {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "lax",
        maxAge: intended ? JOURNEY_TTL_SECONDS : 0,
      });
    }
    setHeaders({ "cache-control": "no-store, private", vary: "Cookie" });
    redirect(302, outcome.location);
  }
  if (outcome.kind === "unavailable") error(503, "Member data is temporarily unavailable.");
  if (outcome.kind === "forbidden") error(403, "Forbidden");
  if (outcome.kind === "notFound") error(404, "Not found");
  setHeaders({ "cache-control": "private, no-store" });
  return {
    member: outcome.member,
    stats: outcome.stats,
    isOwner: outcome.isOwner,
    isModerator: outcome.isModerator,
    appUrl: env.APP_URL,
    joinResult: outcome.joinResult,
    sharedGames: outcome.sharedGames,
  };
};

export const actions = {
  default: async ({ request, locals }) => {
    const result = await writeKitProfile(request, env, locals.requestId);
    if (result instanceof Response) {
      // Actions cannot return a raw response. The hook sends this exact wire
      // response after Kit skips the GET loads, including on auth refusals.
      locals.profileWriteResponse = result;
      redirect(303, result.headers.get("location") ?? "/profile");
    }
    locals.profileWriteDraft = result;
    return fail(result.status, { errors: result.errors, values: result.values });
  },
} satisfies Actions;
