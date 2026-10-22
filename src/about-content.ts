// About-leaf content source, shared by the Hono leaf (src/screens/about.tsx)
// and the Kit page (web/src/routes/about/). Pure data: no session, no
// cookie, no database — importing this module must never connect to
// anything. Sentences are byte-identical to the funnel leaf they port, so
// both renderers stay byte-identical too; change them here once and both
// renderers follow.
import { aboutLadderFact, type LadderRank } from "./ladder-copy";

export const ABOUT_STRAP = "Est. 1998";

export const ABOUT_LEAD =
  "An adult gaming community that spent most of its life private. Now the doors are open: turn up, say hello, come back.";

export const ABOUT_FACTS: Array<[string, string]> = [
  [
    "Voice-first",
    "The community lives in voice. Turn up, say hello, and come back — that is the whole membership path.",
  ],
  [
    "No application, no interview",
    "You start as a Prospect. Show up a few times, play, become a Member. The ladder records trust and time, not grind.",
  ],
  [
    "From forum threads to voice rooms",
    "Founded in 1998. Forum years, then voice years — duos, trios, quads, squads. Today: doors open.",
  ],
];

export type AboutPageData = {
  appUrl: string;
  strap: typeof ABOUT_STRAP;
  lead: typeof ABOUT_LEAD;
  facts: typeof ABOUT_FACTS;
};

// The Kit load function only reorders the same reads as the Hono handler
// (src/static-leaves.tsx): APP_URL plus the bot-owned ranks. Kept here (not
// in the Kit route) so the root suite can pin it without importing SvelteKit
// or worker code.
const LADDER_TERM = "No application, no interview";

// The optional ranks slice (ordered [{ key, label, memberCount }] from
// web_v1.rank_counts; extra fields ignored) derives the ladder fact from live
// data. Without ranks — the views are down — the static bytes below render as
// the null-state fallback.
export function aboutPageData(appUrl: string, ranks?: LadderRank[]): AboutPageData {
  if (!ranks?.length) return { appUrl, strap: ABOUT_STRAP, lead: ABOUT_LEAD, facts: ABOUT_FACTS };
  return {
    appUrl,
    strap: ABOUT_STRAP,
    lead: ABOUT_LEAD,
    facts: ABOUT_FACTS.map(([term, definition]): [string, string] =>
      term === LADDER_TERM ? [term, aboutLadderFact(ranks)] : [term, definition],
    ),
  };
}
