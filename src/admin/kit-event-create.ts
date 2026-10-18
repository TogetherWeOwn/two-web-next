// Kit moderator event-create model. The new-event load
// (web/src/routes/admin/events/new/+page.server.ts) is a thin SvelteKit
// binding around this: cloudflare:workers + SvelteKit imports stay out of the
// root test process, so the serializable view decision lives here where unit
// tests can drive it.
//
// Framework-free by construction, like src/admin/kit-events.ts: it shapes
// already-known form state, performs zero reads, and never touches cookies,
// the session, or the audit. The member-read boundary around resolve() still
// owns classification and the audit; this only tells the load which values
// and field errors to render. The create form needs no database read: a fresh
// GET renders empty values and no errors, while a rejected POST re-renders
// through the Hono owner (src/admin/routes.tsx, admin.events.create) until
// the write slice migrates — the Svelte page mirrors that 422 shape so the
// error aggregation, retained values and dirty-draft marker stay identical
// when the route owns traffic.
export type KitEventCreateView = {
  values: Record<string, string>;
  errors: Record<string, string>;
  hasErrors: boolean;
  isDraft: boolean;
};

/** Stringify one submitted value the way the Hono form echoes it back. */
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Build the serializable create-form view from raw values/errors maps. */
export function buildEventCreateView(
  values: Record<string, unknown> = {},
  errors: Record<string, string> = {},
): KitEventCreateView {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    const s = str(v);
    // Skip empty echoes so the Svelte defaults (e.g. Europe/London) apply.
    if (s !== "") out[k] = s;
  }
  const cleanErrors: Record<string, string> = {};
  for (const [k, v] of Object.entries(errors)) {
    if (typeof v === "string" && v !== "") cleanErrors[k] = v;
  }
  const hasErrors = Object.keys(cleanErrors).length > 0;
  return { values: out, errors: cleanErrors, hasErrors, isDraft: hasErrors };
}
