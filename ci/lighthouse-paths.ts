export const fixtureKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// The three DB-free static leaves (/faq, /rules, /privacy) follow the five dynamic/guest pages.
// ci/lighthouserc.cjs and ci/lighthouse-admission.cjs repeat this list (they are CommonJS);
// test/lighthouse-inventory.test.ts fails if any of the three drifts.
export const auditPaths = [
  "/",
  "/events",
  `/e/${fixtureKey}`,
  "/join",
  "/about",
  "/faq",
  "/rules",
  "/privacy",
];
