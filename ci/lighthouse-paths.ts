export const fixtureKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// Fixture member for the audited link-in-bio page (ci/lighthouse-worker.ts
// emulates the users/profiles/member_links reads for this id only).
export const linksMember = "100000000000000111";
// The three DB-free static leaves (/faq, /rules, /privacy) follow the six dynamic/guest pages.
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
  `/members/${linksMember}/links`,
];
