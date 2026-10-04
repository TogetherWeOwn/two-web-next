import { request, type APIRequestContext } from "@playwright/test";
import { requireGithubRunner } from "../ci-only.mjs";
import {
  SWEEP_MAX_DURATION_MS,
  SWEEP_MAX_PAGES,
  SWEEP_MAX_PASSES,
  SWEEP_MAX_THROTTLE_RETRIES,
  SWEEP_STATUSES,
  leftoverFixturesError,
  parseFixtureRows,
  sweepListPath,
  sweepNextListPath,
} from "../fixture-sweep.mjs";
import { parseRetryAfterSeconds, sleep } from "../qa-login-retry.mjs";
import { sendTokenRequest } from "../qa-request.mjs";
import { moderatorStorageState, stagingOrigin } from "./fixtures";
import { loginQaModerator } from "./qa-login";

// Event keys of every fixture the admin list still shows as published or draft.
async function listLiveFixtures(
  api: APIRequestContext,
  requestTimeout: () => number,
): Promise<string[]> {
  const keys = new Set<string>();
  for (const status of SWEEP_STATUSES) {
    let path: string | null = sweepListPath(status);
    for (let page = 1; path !== null; page++) {
      if (page > SWEEP_MAX_PAGES) {
        throw new Error("staging fixture sweep: admin pagination limit exhausted");
      }
      const listPath: string = path;
      const timeout = requestTimeout();
      const list = await sendTokenRequest("staging fixture sweep list", undefined, () =>
        api.get(listPath, { maxRedirects: 0, timeout }),
      );
      if (list.status() !== 200) {
        throw new Error(`staging fixture sweep: admin events list answered ${list.status()}`);
      }
      const html = await list.text();
      for (const row of parseFixtureRows(html)) keys.add(row.eventKey);
      path = sweepNextListPath(html, listPath, stagingOrigin);
    }
  }
  return [...keys];
}

// Backstop for the journeys' own `finally` cleanup. That cleanup runs after the
// test body, so a test timeout (which closes the contexts first) or a flaked
// cancel leaves a published fixture live on staging. This sign-in is fresh
// because every earlier session was rotated or revoked by the specs, and it
// costs one hit of the shared 10/min `qa-login` budget.
export default async function globalTeardown(): Promise<void> {
  requireGithubRunner();
  await loginQaModerator();
  const api = await request.newContext({
    baseURL: stagingOrigin,
    storageState: moderatorStorageState,
  });
  const deadline = Date.now() + SWEEP_MAX_DURATION_MS;
  const remainingTime = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("staging fixture sweep: time limit exhausted");
    return remaining;
  };
  const requestTimeout = () => Math.min(30_000, remainingTime());
  try {
    const swept = new Set<string>();
    let throttleRetries = 0;
    for (let pass = 1; pass <= SWEEP_MAX_PASSES; pass++) {
      const live = await listLiveFixtures(api, requestTimeout);
      if (live.length === 0) break;
      for (const eventKey of live) {
        // The same-origin guard needs the explicit staging Origin; the request
        // API sends neither Origin nor Fetch Metadata on its own. A cancel that
        // misses is picked up again by the next pass.
        for (;;) {
          const timeout = requestTimeout();
          const response = await sendTokenRequest("staging fixture sweep cancel", undefined, () =>
            api.post(`/admin/events/${eventKey}/cancel`, {
              headers: { Origin: stagingOrigin },
              maxRedirects: 0,
              timeout,
            }),
          );
          if (response.status() === 303) swept.add(eventKey);
          if (response.status() !== 429) break;
          const waitMs = parseRetryAfterSeconds(response.headers()) * 1000;
          if (throttleRetries >= SWEEP_MAX_THROTTLE_RETRIES) {
            throw new Error("staging fixture sweep: throttle retry limit exhausted");
          }
          if (waitMs >= remainingTime()) {
            throw new Error("staging fixture sweep: time limit exhausted before throttle retry");
          }
          // Retry this cancellation, even on the final pass. Waiting must not
          // spend a useful pass, but total waits and elapsed time stay bounded.
          throttleRetries++;
          await sleep(waitMs);
        }
      }
    }
    if (swept.size > 0) {
      console.log(
        `staging fixture sweep cancelled ${swept.size} orphaned fixture(s): ${[...swept].join(", ")}`,
      );
    }
    const remaining = await listLiveFixtures(api, requestTimeout);
    if (remaining.length > 0) throw leftoverFixturesError(remaining);
  } finally {
    await api.dispose();
  }
}
