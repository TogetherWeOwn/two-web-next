import { env } from "cloudflare:workers";
import { isRestoredBannerEligible, readReturnJourney } from "../../../src/kit-session";
import type { LayoutServerLoad } from "./$types";

// Root layout data every Kit page inherits: the restored-write notice the
// Svelte views render as the "you signed in again" banner. A read-only,
// signature-verified peek — CPU only, no session, no database — so the
// content leaves keep their outage posture (a DB failure still renders the
// page, with or without the banner). SvelteKit merges this into every page's
// data, so no page load passes it through; pages hand data.restoredWrite to
// their shell, which renders the banner first inside <main> like Hono's
// expiredWriteBanner middleware. The hook core consumes the one-shot cookie
// after the released response through the same bridge peek, gated on the
// same eligibility: a request excluded here never renders and never
// consumes, so the notice always survives for the next visible page.
export const load: LayoutServerLoad = async ({ request }) => {
  if (!isRestoredBannerEligible(request)) return { restoredWrite: null };
  const journey = await readReturnJourney(request, env.SESSION_SECRET);
  return { restoredWrite: journey.restoredWrite };
};
