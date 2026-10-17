import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { QA_HEADER, STAGING_APP_URL } from "../../src/qa";
import { requireStagingOrigin } from "../staging-guard.mjs";
import { qaLogin } from "../qa-request.mjs";
import { memberStorageState, moderatorStorageState } from "./fixtures";

const stagingOrigin = requireStagingOrigin(STAGING_APP_URL);

// POST /auth/qa/:identity carries the shared `qa-login` throttle (10/min per
// runner IP). Every login — good, bad-token, or unknown-identity — spends it,
// so a 429 here names the budget and the Retry-After wait instead of failing
// the whole spec file on a bare status assert. The login itself lives in
// qa-request.mjs and travels over Node fetch: Playwright records request
// headers into retained traces for every context created during a run, so
// the token never passes through a browser context or the `request`
// fixture. Playwright only ever sees the storage state written below.
async function login(identity: "qa-member" | "qa-moderator", path: string): Promise<void> {
  const token = process.env.QA_AUTH_TOKEN;
  // The token arrives only as the staging Environment secret. A missing or
  // refused credential is a blocker, never a reason to substitute another.
  if (!token) throw new Error("Missing QA_AUTH_TOKEN staging Environment secret");
  const state = await qaLogin({ origin: stagingOrigin, identity, token, header: QA_HEADER });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
}

/**
 * Sign both QA identities in and persist their storage states. Every login
 * spends the shared `qa-login` throttle budget (10/min per runner IP —
 * global-setup plus six authed per-file hooks must stay under it), and the
 * sign-in sweep revokes each identity's older sessions, so every spec file
 * takes exactly the sessions it needs and no more:
 * - files needing one identity call loginQaMember() / loginQaModerator()
 *   (one login, not two);
 * - only files needing both identities call this (two logins).
 * The server rotates the session bearer on HTML page views and revokes older
 * sessions at sign-in, so a state file is still single-use across files — a
 * file written by global-setup alone is dead for every file that runs after
 * the first rotating read. Fresh per-file sign-in keeps each file
 * order-independent; the budget only caps how many fresh sign-ins a run holds.
 */
export async function loginQaIdentities(): Promise<void> {
  await login("qa-member", memberStorageState);
  await login("qa-moderator", moderatorStorageState);
}

/**
 * Sign in only the member identity (one throttle hit). For spec files that
 * never touch the moderator session — profile, logout, join, auth's member journey.
 */
export async function loginQaMember(): Promise<void> {
  await login("qa-member", memberStorageState);
}

/**
 * Sign in only the moderator identity (one throttle hit). For spec files that
 * never touch the member session — admin.
 */
export async function loginQaModerator(): Promise<void> {
  await login("qa-moderator", moderatorStorageState);
}
