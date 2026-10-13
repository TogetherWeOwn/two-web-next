import { safeNext } from "../../../../../src/join/service";
import type { PageServerLoad } from "./$types";

// Server-rendered only: the Hono recovery page ships no JavaScript, so the
// Kit page carries no hydration bundle that the CSP (script-src 'self')
// would block. The retry link and invite fallback are plain anchors, so the
// no-JS contract (way back in, invite fallback, copy in the raw fetch body)
// holds byte-for-byte.

// Same model and cache policy as the Hono handler (recoveryLanding in
// src/write-recovery.tsx): the expired-session copy, a safe login retry
// destination, the invite fallback, private no-store. The one-use journey
// writes (the signed intended + expired-write cookies) stay Hono-owned: this
// load never mints, consumes or signs journey state, reads sessions or
// touches the database, so a Kit read can never double-spend a journey. The
// manifest keeps GET /auth/recover on Hono (enabled: false) until the
// enablement review, which must move those writes before flipping ownership.
export const csr = false;

export const load: PageServerLoad = async ({ url, setHeaders }) => {
  // A safe ?next= survives onto the login retry link; a hostile one falls
  // back to /profile and leaves no trace in the HTML (safeNext pins the
  // guard: single leading slash, no scheme, no backslash).
  const next = safeNext(url.searchParams.get("next")) ?? "/profile";
  setHeaders({ "cache-control": "no-store, private" });
  return {
    title: "Your session expired",
    message:
      "Your earlier changes were not saved. Sign in again, then review and submit them when you are ready.",
    retryUrl: `/auth/discord?next=${encodeURIComponent(next)}`,
    retryLabel: "Log in with Discord",
    inviteUrl: "/discord",
  };
};
