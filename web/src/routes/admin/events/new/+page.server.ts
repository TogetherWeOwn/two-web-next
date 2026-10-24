import type { PageServerLoad } from "./$types";
import { buildEventCreateView } from "../../../../../../src/admin/kit-event-create";

// Server-rendered only: the Hono create form ships only progressive islands
// (text-limits + dirty-navigation editor), so the Kit viewer carries no
// hydration bundle that the CSP (script-src 'self') would block.
//
// Same shape as the Hono new-event form (src/admin/routes.tsx,
// admin.events.create): empty values and no errors on a fresh GET. The guard
// must settle first: SvelteKit starts layout and page loads together, so the
// read below waits on parent() — a guest 302 or non-moderator 403 propagates
// before any work. Keep the await outside the try: there is no store read to
// map to 503 here. Exactly one setHeaders call on the success path:
// SvelteKit throws `header_already_set` on a double-set.
// POST /admin/events stays Hono-owned: the ported form keeps submitting to
// the unchanged Hono handler during mixed mode, so draft-first creation,
// weekly/monthly recurrence (max 52), wall-time/timezone validation, body cap,
// throttle, error aggregation, retained values and the 303 stay one
// authority until the write slice lands. The Svelte page mirrors the Hono
// 422 error shape (values + field errors + dirty-draft marker) so the
// progressive islands behave identically when this route owns traffic.
export const csr = false;

export const load: PageServerLoad = async ({ parent, setHeaders }) => {
  await parent();
  setHeaders({ "cache-control": "private, no-store" });
  return buildEventCreateView({}, {});
};
