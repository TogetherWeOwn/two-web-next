// Text escaping identical to hono/jsx interpolation (`" ' & < >`, with `'`
// as `&#39;`). Kit views use it with `{@html}` only where they must match
// Hono bytes exactly: Svelte interpolation leaves `>` raw, so a hostile
// `>`-carrying string renders differently across the two renderers without
// it. Fully escaped output carries no markup-opening characters.
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
