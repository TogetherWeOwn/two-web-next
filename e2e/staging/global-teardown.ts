import { request, type APIRequestContext } from "@playwright/test";
import { requireGithubRunner } from "../ci-only.mjs";
import {
  SWEEP_MAX_PASSES,
  SWEEP_STATUSES,
  leftoverFixturesError,
  parseFixtureRows,
  sweepListPath,
} from "../fixture-sweep.mjs";
import { parseRetryAfterSeconds, sleep } from "../qa-login-retry.mjs";
import { moderatorStorageState, stagingOrigin } from "./fixtures";
import { loginQaModerator } from "./qa-login";

// Event keys of every fixture the admin list still shows as published or draft.
async function listLiveFixtures(api: APIRequestContext): Promise<string[]> {
  const keys: string[] = [];
  for (const status of SWEEP_STATUSES) {
    const list = await api.get(sweepListPath(status), { maxRedirects: 0 });
    if (list.status() !== 200) {
      throw new Error(`staging fixture sweep: admin events list answered ${list.status()}`);
    }
    keys.push(...parseFixtureRows(await list.text()).map((row) => row.eventKey));
  }
  return keys;
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
  try {
    const swept = new Set<string>();
    for (let pass = 1; pass <= SWEEP_MAX_PASSES; pass++) {
      const live = await listLiveFixtures(api);
      if (live.length === 0) break;
      for (const eventKey of live) {
        // The same-origin guard needs the explicit staging Origin; the request
        // API sends neither Origin nor Fetch Metadata on its own. A cancel that
        // misses is picked up again by the next pass.
        const response = await api.post(`/admin/events/${eventKey}/cancel`, {
          headers: { Origin: stagingOrigin },
          maxRedirects: 0,
        });
        if (response.status() === 303) swept.add(eventKey);
        if (response.status() === 429) {
          // `admin-write` allows 30 a minute per runner IP and the journeys
          // spend it too: wait out the window, then list again.
          await sleep(parseRetryAfterSeconds(response.headers()) * 1000);
          break;
        }
      }
    }
    if (swept.size > 0) {
      console.log(
        `staging fixture sweep cancelled ${swept.size} orphaned fixture(s): ${[...swept].join(", ")}`,
      );
    }
    const remaining = await listLiveFixtures(api);
    if (remaining.length > 0) throw leftoverFixturesError(remaining);
  } finally {
    await api.dispose();
  }
}
