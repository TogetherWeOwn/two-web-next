import { test, expect } from "./fixtures";

test("server redirects cannot bypass the fail-closed browser proxy", async ({ page }) => {
  // Playwright routing does not re-intercept a server redirect hop. Prove the
  // browser fails at the dead loopback proxy, without connecting to Discord.
  await expect(page.goto("/__e2e/redirect-canary")).rejects.toThrow("ERR_PROXY_CONNECTION_FAILED");
});
