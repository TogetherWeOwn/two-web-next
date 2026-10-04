import { test as base, expect } from "@playwright/test";
import { STAGING_APP_URL } from "../../src/qa";
import { requireStagingOrigin } from "../staging-guard.mjs";

export const stagingOrigin = requireStagingOrigin(STAGING_APP_URL);

// QA synthetic identities from src/qa.ts (stable across ports).
export const MEMBER_DISCORD_ID = "900000000000001396";

export const memberStorageState = "e2e/staging/.auth/member.json";
export const moderatorStorageState = "e2e/staging/.auth/moderator.json";

// Explicitly unauthenticated state. A bare browser.newContext() inherits this
// config's storageState (and baseURL), so journeys that must run as guests
// opt out here instead of trusting the default.
export const emptyStorageState = { cookies: [], origins: [] };

export const test = base;
export { expect };
