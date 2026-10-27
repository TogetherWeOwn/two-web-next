import { env } from "cloudflare:workers";
import type { PageServerLoad } from "./$types";
import { POLICY_VERSION, renderPolicyMarkdown } from "../../../../src/privacy";
import { POLICY_MARKDOWN } from "../../../../src/privacy-content";
import { LEAF_CRITICAL_CSS } from "../../../../src/leaf-critical-css";

// Pre-rendered once at module load, so the request path performs zero reads
// of any kind — same posture as the Hono handler in src/seo-leaves.tsx. No
// session, no cookie, no cache, no database: the page stays 200 during an
// app-DB outage.
const PRIVACY_HTML = renderPolicyMarkdown(POLICY_MARKDOWN, { navigation: true });

// Server-rendered only: the Hono page ships no JavaScript, so the Kit page
// carries no hydration bundle that the CSP (script-src 'self') would block.
export const csr = false;

// Same reads and cache policy as the Hono handler: public, no viewer.
export const load: PageServerLoad = async ({ setHeaders }) => {
  setHeaders({ "cache-control": "public, max-age=3600" });
  return {
    html: PRIVACY_HTML,
    version: POLICY_VERSION,
    appUrl: env.APP_URL,
    leafCss: LEAF_CRITICAL_CSS,
  };
};
