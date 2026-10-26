import type { PageServerLoad } from "./$types";
import { env } from "cloudflare:workers";
import { dbFor } from "../../../../../../src/admin/db";
import { loadGameSuggestions } from "../../../../../../src/events/game-suggestions";
import { buildEventCreateView } from "../../../../../../src/admin/kit-event-create";

// Server-rendered only: the Hono create form ships only progressive islands
// (text-limits + dirty-navigation editor), so the Kit viewer carries no
// hydration bundle that the CSP (script-src 'self') would block.
//
// Same shape as the Hono new-event form (src/admin/routes.tsx,
// admin.events.create): empty values and no errors on a fresh GET. The guard
// must settle first: SvelteKit starts layout and page loads together, so the
// read below waits on parent() — a guest 302 or non-moderator 403 propagates
// before the optional published-name read. Classified catalog failures omit
// assistance; other failures retain the existing error diagnostics. Exactly
// one setHeaders call on the success path:
// SvelteKit throws `header_already_set` on a double-set.
// POST /admin/events stays Hono-owned: the ported form keeps submitting to
// the unchanged Hono handler during mixed mode, so draft-first creation,
// weekly recurrence (max 52), wall-time/timezone validation, body cap,
// throttle, error aggregation, retained values and the 303 stay one
// authority until the write slice lands. The Svelte page mirrors the Hono
// 422 error shape (values + field errors + dirty-draft marker) so the
// progressive islands behave identically when this route owns traffic.
export const csr = false;

export const load: PageServerLoad = async ({ parent, setHeaders }) => {
  await parent();
  setHeaders({ "cache-control": "private, no-store" });
  const games = await loadGameSuggestions(await dbFor({ env }));
  return { ...buildEventCreateView({}, {}), games };
};
