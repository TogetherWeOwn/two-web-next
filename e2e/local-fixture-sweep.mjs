// Backstop sweep for RSVP fixtures made by the local browser spec.
// This module is local-origin-only and never constructs a request to staging.

export const LOCAL_FIXTURE_ORIGIN = "https://localhost:8787";
export const LOCAL_FIXTURE_TITLE_PREFIXES = Object.freeze(["E2E Waitlist ", "E2E Promotion "]);
export const LOCAL_SWEEP_STATUSES = Object.freeze(["published", "draft"]);
export const LOCAL_SWEEP_MAX_PASSES = 4;
export const LOCAL_SWEEP_MAX_PAGES = 20;
export const LOCAL_SWEEP_MAX_DURATION_MS = 300_000;

const ROW_LINK = /<a href="\/admin\/events\/([0-9A-HJKMNP-TV-Z]{26})">([^<]*)<\/a>/g;

export function localSweepListPath(prefix, status, page = 1) {
  if (!LOCAL_FIXTURE_TITLE_PREFIXES.includes(prefix) || !LOCAL_SWEEP_STATUSES.includes(status)) {
    throw new Error("local fixture sweep: invalid list filter");
  }
  const params = new URLSearchParams({
    q: prefix.trim(),
    status,
    sort: "starts_at",
    order: "desc",
  });
  if (page > 1) params.set("page", String(page));
  return `/admin/events?${params}`;
}

export function parseLocalFixtureRows(html, prefix) {
  if (!LOCAL_FIXTURE_TITLE_PREFIXES.includes(prefix)) {
    throw new Error("local fixture sweep: invalid fixture prefix");
  }
  const rows = [];
  for (const match of html.matchAll(ROW_LINK)) {
    const [, eventKey, title] = match;
    if (title.startsWith(prefix)) rows.push({ eventKey, title });
  }
  return rows;
}

export function localSweepNextListPath(html, currentPath) {
  const link = [...html.matchAll(/<a\b([^>]*)>/g)].find((match) =>
    /\brel=["']next["']/.test(match[1]),
  );
  if (!link) return null;
  const href = /\bhref=["']([^"']*)["']/.exec(link[1])?.[1];
  const current = new URL(currentPath, LOCAL_FIXTURE_ORIGIN);
  const page = Number(current.searchParams.get("page") ?? 1);
  const prefix = LOCAL_FIXTURE_TITLE_PREFIXES.find(
    (value) => value.trim() === current.searchParams.get("q"),
  );
  const status = current.searchParams.get("status");
  if (!href || !prefix || !LOCAL_SWEEP_STATUSES.includes(status)) {
    throw new Error("local fixture sweep: invalid pagination link");
  }
  const expectedPath = localSweepListPath(prefix, status, page + 1);
  const expected = new URL(expectedPath, LOCAL_FIXTURE_ORIGIN);
  let next;
  try {
    next = new URL(href.replaceAll("&amp;", "&"), current);
  } catch {
    throw new Error("local fixture sweep: invalid pagination link");
  }
  next.searchParams.sort();
  expected.searchParams.sort();
  if (
    next.origin !== LOCAL_FIXTURE_ORIGIN ||
    next.username ||
    next.password ||
    next.hash ||
    next.pathname !== expected.pathname ||
    next.search !== expected.search
  ) {
    throw new Error("local fixture sweep: invalid pagination link");
  }
  return expectedPath;
}

export async function sweepLocalFixtures(api, { now = Date.now } = {}) {
  const deadline = now() + LOCAL_SWEEP_MAX_DURATION_MS;
  const requestTimeout = () => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("local fixture sweep: time limit exhausted");
    return Math.min(30_000, remaining);
  };
  const listLive = async () => {
    const keys = new Set();
    for (const prefix of LOCAL_FIXTURE_TITLE_PREFIXES) {
      for (const status of LOCAL_SWEEP_STATUSES) {
        let path = localSweepListPath(prefix, status);
        for (let page = 1; path !== null; page++) {
          if (page > LOCAL_SWEEP_MAX_PAGES) {
            throw new Error("local fixture sweep: pagination limit exhausted");
          }
          const response = await api.get(path, {
            maxRedirects: 0,
            timeout: requestTimeout(),
          });
          if (response.status() !== 200) {
            throw new Error(`local fixture sweep: admin events list answered ${response.status()}`);
          }
          const html = await response.text();
          for (const row of parseLocalFixtureRows(html, prefix)) keys.add(row.eventKey);
          path = localSweepNextListPath(html, path);
        }
      }
    }
    return [...keys];
  };

  let cancelled = 0;
  for (let pass = 1; pass <= LOCAL_SWEEP_MAX_PASSES; pass++) {
    const live = await listLive();
    if (live.length === 0) break;
    for (const eventKey of live) {
      const response = await api.post(`/admin/events/${eventKey}/cancel`, {
        headers: { Origin: LOCAL_FIXTURE_ORIGIN },
        maxRedirects: 0,
        timeout: requestTimeout(),
      });
      if (response.status() !== 303) {
        throw new Error(
          `local fixture sweep: cancel answered ${response.status()} for ${eventKey}`,
        );
      }
      cancelled++;
    }
  }
  const remaining = await listLive();
  if (remaining.length > 0) {
    throw new Error(
      `local fixture sweep left ${remaining.length} RSVP fixture(s) live after ${LOCAL_SWEEP_MAX_PASSES} passes: ${remaining.join(", ")}`,
    );
  }
  return cancelled;
}
