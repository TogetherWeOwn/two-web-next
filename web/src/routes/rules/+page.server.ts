import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { rulesPageData } from "../../../../src/rules-content";

// Server-rendered only: the stamp and the five rules are in the raw fetch
// body, so the no-JS contract holds and there is no inline bootstrap script
// for the CSP (script-src 'self') to block. No island on this page.
export const csr = false;

// Same reads and cache policy as the Hono handler (src/static-leaves.tsx):
// APP_URL plus the config stamp only. No session, no cookie, no database —
// the page stays 200 during an app-DB outage, exactly like the Hono leaf.
export const load: PageServerLoad = async ({ setHeaders }) => {
  setHeaders({ "cache-control": "public, max-age=3600" });
  return rulesPageData(env.APP_URL, env.RULES_LAST_UPDATED);
};
