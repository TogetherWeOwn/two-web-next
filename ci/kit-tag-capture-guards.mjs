// Pure fail-closed guards for ci/kit-tag-capture.mjs; no I/O so they test offline.
export const SOURCE_SHA = "6178285a1da1fbb3acc34707216990bc619cbb2d";
export const TAGS = ["neutral", "live", "you", "echo", "ok", "warn"];
export const DOTS = ["live", "presence"];
export const VIEWPORTS = [
  ["desktop", 1280, 800],
  ["mobile", 390, 844],
];

export function parseArgs(argv) {
  if (argv.length !== 2 || argv.some((a) => !a || a.startsWith("-")))
    throw new Error("Expected app and output paths");
  return { app: argv[0], output: argv[1] };
}

export function assertSource({ head, status }) {
  if (head !== SOURCE_SHA) throw new Error(`Source is not the pinned commit: ${head}`);
  if (status !== "") throw new Error("Source checkout is not clean; overlays are not allowed");
}

export function isAllowedRequest(request, origin) {
  try {
    return new URL(request).origin === origin;
  } catch {
    return false;
  }
}

// Report-only: an unapproved Kit policy is never evaluated here, so no pass is claimed.
export function summarizeLighthouse(lhr) {
  const score = (id) => lhr?.categories?.[id]?.score;
  const out = { performance: score("performance"), accessibility: score("accessibility") };
  for (const [id, v] of Object.entries(out))
    if (typeof v !== "number") throw new Error(`Missing Lighthouse category: ${id}`);
  if (lhr.runtimeError) throw new Error(`Lighthouse runtime error: ${lhr.runtimeError.code}`);
  return { ...out, lighthouseVersion: lhr.lighthouseVersion, policy: "not-evaluated" };
}

export function assertNoAxeViolations(results) {
  if (!Array.isArray(results?.violations)) throw new Error("Malformed axe result");
  if (results.violations.length > 0)
    throw new Error(`axe violations: ${results.violations.map((v) => v.id).join(",")}`);
  return { violations: 0, passes: results.passes?.length ?? 0 };
}
