import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { aboutPageData } from "../../../../src/about-content";
import { readRanks } from "../../../../src/counts";
import { LEAF_CRITICAL_CSS } from "../../../../src/leaf-critical-css";

// Server-rendered only: the strap, lead and fact cards are in the raw fetch
// body, so the no-JS contract holds and there is no inline bootstrap script
// for the CSP (script-src 'self') to block. No island on this page.
export const csr = false;

// Same reads and cache policy as the Hono handler (src/static-leaves.tsx):
// APP_URL plus the bot-owned ranks for the ladder fact. No session, no
// cookie, no web database — the ranks read degrades to the static null-state
// copy, so the page stays 200 during a database outage, exactly like Hono.
export const load: PageServerLoad = async ({ setHeaders }) => {
  setHeaders({ "cache-control": "public, max-age=3600" });
  const ranks = await readRanks(env);
  return { ...aboutPageData(env.APP_URL, ranks), leafCss: LEAF_CRITICAL_CSS };
};
