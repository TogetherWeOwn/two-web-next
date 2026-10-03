import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { QA_HEADER, STAGING_APP_URL } from "../../src/qa";
import { requireStagingOrigin } from "../staging-guard.mjs";
import { sendTokenRequest } from "../qa-request.mjs";
import {
  parseRetryAfterSeconds,
  qaLoginThrottleError,
  QA_LOGIN_MAX_ATTEMPTS,
  sleep,
} from "../qa-login-retry.mjs";
import { emptyStorageState, memberStorageState, moderatorStorageState } from "./fixtures";

const stagingOrigin = requireStagingOrigin(STAGING_APP_URL);

// POST /auth/qa/:identity carries the shared `qa-login` throttle (10/min per
// runner IP). Every login — good, bad-token, or unknown-identity — spends it,
// so a 429 here names the budget and the Retry-After wait instead of failing
// the whole spec file on a bare status assert. Transport errors still go
// through sendTokenRequest so the token never reaches a public artifact.
async function login(identity: "qa-member" | "qa-moderator", path: string): Promise<void> {
  const token = process.env.QA_AUTH_TOKEN;
  // The token arrives only as the staging Environment secret. A missing or
  // refused credential is a blocker, never a reason to substitute another.
  if (!token) throw new Error("Missing QA_AUTH_TOKEN staging Environment secret");
  let retryAfterSeconds = 60;
  for (let attempt = 1; attempt <= QA_LOGIN_MAX_ATTEMPTS; attempt++) {
    const browser = await chromium.launch();
    try {
      // Explicitly empty storage state: a bare newContext() inherits the
      // config-level storageState file, which does not exist on a fresh
      // checkout (nothing writes it before the first login) — Playwright
      // then throws ENOENT before the login POST ever runs. The login needs
      // no cookies: it authenticates with the QA header and reads the
      // Set-Cookie session from the response jar.
      const context = await browser.newContext({
        baseURL: stagingOrigin,
        storageState: emptyStorageState,
      });
      // Same-origin gate needs the explicit staging Origin next to the header;
      // a bad token or unknown identity answers 404, never a redirect. The
      // transport error text carries the request headers, so it never escapes.
      const response = await sendTokenRequest(`staging QA login as ${identity}`, token, () =>
        context.request.post(`/auth/qa/${identity}`, {
          headers: { [QA_HEADER]: token, Origin: stagingOrigin },
          maxRedirects: 0,
        }),
      );
      if (response.status() === 429) {
        // Throttled: honor the server's Retry-After across the minute
        // boundary instead of failing the file. Header names arrive
        // lower-cased from Playwright.
        retryAfterSeconds = parseRetryAfterSeconds(response.headers());
        if (attempt < QA_LOGIN_MAX_ATTEMPTS) await sleep(retryAfterSeconds * 1000);
        continue;
      }
      assert.equal(response.status(), 204, `staging QA login as ${identity}`);
      // Persist only a real Set-Cookie session: the jar must hold the Secure
      // HttpOnly __Host- cookie for the staging host before it is saved.
      const cookie = (await context.cookies()).find((item) => item.name === "__Host-two_session");
      assert.match(cookie?.domain ?? "", /^(\.)?next\.togetherweown\.com$/);
      assert.equal(cookie?.httpOnly, true);
      assert.equal(cookie?.secure, true);
      mkdirSync(dirname(path), { recursive: true });
      await context.storageState({ path });
      return;
    } finally {
      await browser.close();
    }
  }
  throw qaLoginThrottleError(identity, retryAfterSeconds, QA_LOGIN_MAX_ATTEMPTS);
}

/**
 * Sign both QA identities in and persist their storage states. Every login
 * spends the shared `qa-login` throttle budget (10/min per runner IP —
 * global-setup plus four authed per-file hooks must stay under it), and the
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
 * never touch the moderator session — profile, auth's member journey.
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
