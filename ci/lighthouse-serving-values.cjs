// Value validators shared by the main-document-timing audit (which reads response
// headers) and the summary (which re-validates the stored audit details), so the
// two cannot disagree about what a Server-Timing value may contain. Dependency-free
// on purpose: Lighthouse loads the audit, and this must not pull the lhci config in.

// One Server-Timing metric: a token name with optional `dur=<number>` and
// `desc=<token|quoted-string>` params. The quoted set allows `?`, `&`, `=`, `/`,
// `:` and `+` (valid in descriptions such as "?proto=TCP&rtt=20") but never `|`,
// markup, backslashes, `;` or `,`, so a value cannot break a Markdown table cell.
const METRIC =
  /^[A-Za-z0-9_.-]{1,64}(?: ?; ?(?:dur=\d{1,9}(?:\.\d{1,6})?|desc=(?:[A-Za-z0-9_.-]{1,64}|"[A-Za-z0-9_.:?&=/+ -]{0,128}")))*$/;

function isServerTiming(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) return false;
  return value.split(",").every((metric) => METRIC.test(metric.replace(/^ +| +$/g, "")));
}

module.exports = { isServerTiming };
