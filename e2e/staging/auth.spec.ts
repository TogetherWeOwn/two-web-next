import { sendTokenRequest } from "../qa-request.mjs";
import { test, expect, stagingOrigin, emptyStorageState, moderatorStorageState } from "./fixtures";
import { loginQaIdentities } from "./qa-login";

// The real token travels in a request header here. Traces record request
// headers, and the failure artifacts are public, so this spec records no
// trace/video/screenshot artifacts (the sweep in ci/scrub-qa-token.py is the
// backstop).
test.use({ trace: "off", screenshot: "off", video: "off" });

// Fresh sessions per file: event pages rotate the bearer on read, so a stored
// token is single-use across files.
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
      const bad = await context.request.post("/auth/qa/qa-member", {
        headers: { "X-TWO-QA-Auth": "staging-e2e-wrong-token", Origin: origin },
        maxRedirects: 0,
      });
      expect(bad.status()).toBe(404);
      const token = process.env.QA_AUTH_TOKEN ?? "";
      // A transport error's text carries the request headers; keep them out of
      // the report.
      const unknown = await sendTokenRequest("staging QA unknown-identity probe", token, () =>
        context.request.post("/auth/qa/no-such-identity", {
          headers: { "X-TWO-QA-Auth": token, Origin: origin },
          maxRedirects: 0,
        }),
      );
      expect(unknown.status()).toBe(404);
    } finally {
      await context.close();
    }
  });
});
