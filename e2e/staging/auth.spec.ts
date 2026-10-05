import type { APIRequestContext, APIResponse } from "@playwright/test";
import { sendTokenRequest } from "../qa-request.mjs";
import { parseRetryAfterSeconds, QA_LOGIN_MAX_ATTEMPTS, sleep } from "../qa-login-retry.mjs";
import { test, expect, stagingOrigin, emptyStorageState, moderatorStorageState } from "./fixtures";
import { loginQaIdentities } from "./qa-login";

// The real token travels in a request header here. Traces record request
// headers, and the failure artifacts are public, so this spec records no
// trace/video/screenshot artifacts (the sweep in ci/scrub-qa-token.py is the
// backstop).
test.use({ trace: "off", screenshot: "off", video: "off" });

// Fresh sessions per file: event pages rotate the bearer on read, so a stored
// token is single-use across files. Member + moderator: two logins — the
// moderator journey reads this file's own moderator session, so it stays
// order-independent.
test.beforeAll(async () => {
  await loginQaIdentities();
});

// Storage-state identities land on their pages; negative QA cases answer 404.
test("staging QA member session opens the member profile", async ({ page }) => {
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "QA Member", exact: true })).toBeVisible();
});

test("staging QA moderator session opens the admin event list", async ({ browser }) => {
  const context = await browser.newContext({ storageState: moderatorStorageState });
  try {
    const page = await context.newPage();
    await page.goto("/admin/events");
    await expect(page.getByRole("heading", { name: "Events", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

// A negative probe shares the `qa-login` throttle budget (10/min per runner
// IP) with every per-file QA login in the run, and the throttle runs before
// the token/identity check — so a probe can answer 429 when the run's burst
// lands in one window. A 429 names the budget, not the verdict: honor
// Retry-After into a fresh window and re-probe, then assert the authoritative
// 404. Bounded like the login retry (qa-login-retry.mjs).
async function probeQaStatus(
  request: APIRequestContext,
  identity: string,
  headers: Record<string, string>,
): Promise<APIResponse> {
  let response = await request.post(`/auth/qa/${identity}`, {
    headers,
    maxRedirects: 0,
  });
  for (let attempt = 1; attempt < QA_LOGIN_MAX_ATTEMPTS && response.status() === 429; attempt++) {
    await sleep(parseRetryAfterSeconds(response.headers()) * 1000);
    response = await request.post(`/auth/qa/${identity}`, {
      headers,
      maxRedirects: 0,
    });
  }
  return response;
}

test.describe("negative QA cases", () => {
  test("staging QA rejects a bad token and an unknown identity with 404", async ({ browser }) => {
    const origin = stagingOrigin;
    // Explicitly empty: a bare newContext() inherits the member storageState
    // from the staging config, and these probes must not present a session.
    const context = await browser.newContext({
      baseURL: origin,
      storageState: emptyStorageState,
    });
    try {
      const bad = await sendTokenRequest(
        "staging QA bad-token probe",
        "staging-e2e-wrong-token",
        () =>
          probeQaStatus(context.request, "qa-member", {
            "X-TWO-QA-Auth": "staging-e2e-wrong-token",
            Origin: origin,
          }),
      );
      expect(bad.status()).toBe(404);
      const token = process.env.QA_AUTH_TOKEN ?? "";
      // A transport error's text carries the request headers; keep them out of
      // the report.
      const unknown = await sendTokenRequest("staging QA unknown-identity probe", token, () =>
        probeQaStatus(context.request, "no-such-identity", {
          "X-TWO-QA-Auth": token,
          Origin: origin,
        }),
      );
      expect(unknown.status()).toBe(404);
    } finally {
      await context.close();
    }
  });
});
