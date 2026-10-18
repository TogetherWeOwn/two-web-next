import { fetchTokenRequest } from "../qa-request.mjs";
import {
  parseRetryAfterSeconds,
  qaLoginRetryBudgetMs,
  QA_LOGIN_MAX_ATTEMPTS,
  sleep,
} from "../qa-login-retry.mjs";
import { test, expect, stagingOrigin, moderatorStorageState } from "./fixtures";
import { loginQaIdentities } from "./qa-login";

// The real token travels in a request header here, but only over Node fetch
// (qa-request.mjs): Playwright records request headers into retained traces,
// and the failure artifacts are public. This spec still records no
// trace/video/screenshot artifacts as defense in depth, and the sweep in
// ci/scrub-qa-token.py remains the backstop.
test.use({ trace: "off", screenshot: "off", video: "off" });

// Fresh sessions per file: event pages rotate the bearer on read, so a stored
// token is single-use across files. Member + moderator: two logins — the
// moderator journey reads this file's own moderator session, so it stays
// order-independent.
test.beforeAll(async () => {
  // Hook timeout: the config's 30s covers the logins themselves; their
  // bounded 429 waits get their own budget (qa-login-retry.mjs), two logins.
  test.setTimeout(30_000 + qaLoginRetryBudgetMs(2));
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
// 404. Bounded like the login retry (qa-login-retry.mjs). Fetch presents no
// session cookies, so the probes stay unauthenticated by construction, and
// fetchTokenRequest keeps any transport error reason-only.
async function probeQaStatus(
  label: string,
  token: string,
  identity: string,
  headers: Record<string, string>,
): Promise<number> {
  let response = await fetchTokenRequest(label, token, `${stagingOrigin}/auth/qa/${identity}`, {
    method: "POST",
    headers,
  });
  for (let attempt = 1; attempt < QA_LOGIN_MAX_ATTEMPTS && response.status === 429; attempt++) {
    const retryAfter = response.headers.get("retry-after");
    const retryAfterSeconds = parseRetryAfterSeconds(
      retryAfter === null ? undefined : { "retry-after": retryAfter },
    );
    await response.body?.cancel().catch(() => {});
    await sleep(retryAfterSeconds * 1000);
    response = await fetchTokenRequest(label, token, `${stagingOrigin}/auth/qa/${identity}`, {
      method: "POST",
      headers,
    });
  }
  const { status } = response;
  await response.body?.cancel().catch(() => {});
  return status;
}

test.describe("negative QA cases", () => {
  test("staging QA rejects a bad token and an unknown identity with 404", async () => {
    // The config's 30s covers the probes themselves; the bounded 429 retries
    // get their own budget: qaLoginRetryBudgetMs(2) prices two probes, each
    // with up to QA_LOGIN_MAX_ATTEMPTS - 1 capped waits.
    test.setTimeout(30_000 + qaLoginRetryBudgetMs(2));
    const origin = stagingOrigin;
    const bad = await probeQaStatus(
      "staging QA bad-token probe",
      "staging-e2e-wrong-token",
      "qa-member",
      {
        "X-TWO-QA-Auth": "staging-e2e-wrong-token",
        Origin: origin,
      },
    );
    expect(bad).toBe(404);
    const token = process.env.QA_AUTH_TOKEN ?? "";
    const unknown = await probeQaStatus(
      "staging QA unknown-identity probe",
      token,
      "no-such-identity",
      {
        "X-TWO-QA-Auth": token,
        Origin: origin,
      },
    );
    expect(unknown).toBe(404);
  });
});
