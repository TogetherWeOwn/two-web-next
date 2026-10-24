import { error, redirect } from "@sveltejs/kit";
import { env } from "cloudflare:workers";
import { parse } from "hono/utils/cookie";
import { JOURNEY_TTL_SECONDS, LOGIN_INTENDED_COOKIE } from "../../../../../src/return-journey";
import type { PageServerLoad } from "./$types";
import { kitProfileDeps, resolveKitProfile } from "../../../../../src/profiles/kit";

// Server-rendered only: the Hono page ships no Svelte hydration bundle (its
// interactivity is the existing /islands/*.js), so the Kit page carries none
// that the CSP (script-src 'self') would block.
export const csr = false;

// Same reads and cache policy as the Hono GET /members/:user handler
// (src/profiles/routes-reads.tsx): the retrieved member record, member-gated,
// audited by the hook's member-read boundary before any bytes leave.
export const load: PageServerLoad = async ({ locals, params, url, cookies, setHeaders }) => {
  const { storeFor, statsFor, upcomingFor, sessionSecret } = kitProfileDeps(env);
  const outcome = await resolveKitProfile(
    {
      session: { status: locals.status ?? "unknown", session: locals.session ?? null },
      requestedId: params.user,
      joinResult: locals.joinResult ?? null,
      url: url.href,
    },
    {
      store: await storeFor(),
      stats: (id) => statsFor(id),
      upcoming: (id) => upcomingFor(id),
      sessionSecret,
    },
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
    upcoming: outcome.upcoming,
    isOwner: outcome.isOwner,
    isModerator: outcome.isModerator,
    appUrl: env.APP_URL,
    joinResult: outcome.joinResult,
  };
};
