// Backstop sweep for staging E2E event fixtures.
//
// A journey cancels its own fixture in `finally`, but that cleanup runs after
// the test body and loses to anything that tears the browser contexts down
// first: a 30 s test timeout made the cancel throw `Failed to find browser
// context`, and the published fixture stayed live on staging. The global
// teardown signs the moderator in fresh and cancels every fixture still live,
// so no failure path (timeout, crash, a flaked cancel) leaves one behind.
// Pure helpers only: no browser, safe to unit-test with node:test.

/** Every events fixture a staging spec creates starts with this title prefix. */
export const FIXTURE_TITLE_PREFIX = "Staging E2E ";

/** Statuses a cancel still applies to (src/admin/routes.tsx: draft|published to cancelled). */
export const SWEEP_STATUSES = Object.freeze(["published", "draft"]);

/** The admin list holds 25 rows a page; each pass cancels what it saw and lists again. */
export const SWEEP_MAX_PASSES = 4;

// Crockford ULID, as in the admin routes.
const ROW_LINK = /<a href="\/admin\/events\/([0-9A-HJKMNP-TV-Z]{26})">([^<]*)<\/a>/g;

/**
 * Admin events list URL for one status, newest start first: fixtures start in
 * 2099, so they always sit on page 1.
 *
 * @param {string} status one of SWEEP_STATUSES
 */
export function sweepListPath(status) {
  const params = new URLSearchParams({
    q: FIXTURE_TITLE_PREFIX.trim(),
    status,
    sort: "starts_at",
    order: "desc",
  });
  return `/admin/events?${params}`;
}

/**
 * Fixture rows on one admin events list page. The list search is a substring
 * match, so rows whose title does not start with the prefix are dropped.
 *
 * @param {string} html admin events list document
 * @returns {{ eventKey: string, title: string }[]}
 */
export function parseFixtureRows(html) {
  const rows = [];
  for (const match of html.matchAll(ROW_LINK)) {
    const [, eventKey, title] = match;
    if (title.startsWith(FIXTURE_TITLE_PREFIX)) rows.push({ eventKey, title });
  }
  return rows;
}

/**
 * Failure when fixtures are still live after the last pass. Names the keys
 * (ULIDs, never a token or session) so an operator can cancel them by hand.
 *
 * @param {string[]} eventKeys
 */
export function leftoverFixturesError(eventKeys) {
  return new Error(
    `staging fixture sweep left ${eventKeys.length} live "${FIXTURE_TITLE_PREFIX.trim()}" ` +
      `event(s) after ${SWEEP_MAX_PASSES} pass(es): ${eventKeys.join(", ")}. ` +
      `Cancel them from /admin/events as the QA moderator.`,
  );
}
