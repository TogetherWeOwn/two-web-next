import { writeFile } from "node:fs/promises";
import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { STAGING_APP_URL } from "../../src/qa";
import { SESSION_COOKIE } from "../../src/session-cookie";
import { requireStagingOrigin } from "../staging-guard.mjs";

export const stagingOrigin = requireStagingOrigin(STAGING_APP_URL);

// QA synthetic identities from src/qa.ts (stable across ports).
export const MEMBER_DISCORD_ID = "900000000000001396";

export const memberStorageState = "e2e/staging/.auth/member.json";
export const moderatorStorageState = "e2e/staging/.auth/moderator.json";

// Cancelled fixtures remain in the feed until they end. Near-term dates expire
// naturally and sort before the legacy 2099 fixtures instead of piling up behind them.
export function eventFixtureWindow(now = Date.now()): {
  startsAt: string;
  endsAt: string;
  timezone: "UTC";
} {
  const start = Math.floor((now + 2 * 86_400_000) / 60_000) * 60_000;
  const utcWall = (instant: number) =>
    new Date(instant).toISOString().slice(0, 16).replace("T", " ");
  return {
    startsAt: utcWall(start),
    endsAt: utcWall(start + 2 * 3_600_000),
    timezone: "UTC",
  };
}

export async function persistRotatedStorageState(
  context: Pick<APIRequestContext, "storageState">,
  storageStatePath: string,
): Promise<void> {
  const state = await context.storageState();
  // A guest/failed journey must not replace the last authenticated jar.
  if (!state.cookies.some((cookie) => cookie.name === SESSION_COOKIE && cookie.value)) return;
  await writeFile(storageStatePath, JSON.stringify(state));
}

// Explicitly unauthenticated state. A bare browser.newContext() inherits this
// config's storageState (and baseURL), so journeys that must run as guests
// opt out here instead of trusting the default.
export const emptyStorageState = { cookies: [], origins: [] };

export const test = base;
export { expect };
