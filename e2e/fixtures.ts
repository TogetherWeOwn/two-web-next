import { test as base, expect, type BrowserContext } from "@playwright/test";
import {
  parseRetryAfterSeconds,
  QA_LOGIN_MAX_ATTEMPTS,
  qaLoginThrottleError,
  sleep,
} from "./qa-login-retry.mjs";

export const localOrigin = "https://localhost:8787";

export const test = base.extend<{ networkIsolation: void }>({
  networkIsolation: [
    async ({ context }, use) => {
      const blocked: string[] = [];
      // Even links/iframes to Discord or staging are blocked before a packet is
      // sent. A spec may intercept the OAuth authorize page with a local stub.
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === localOrigin) return route.continue();
        blocked.push(`${route.request().method()} ${url.origin}${url.pathname}`);
        return route.abort("blockedbyclient");
      });
      await use();
      expect(blocked, "No real Discord, staging or other external browser traffic").toEqual([]);
      const response = await context.request.get("/__e2e/network", { maxRedirects: 0 });
      expect(response.ok()).toBe(true);
      expect(
        (await response.json()).forbidden,
        "Worker must never forward an upstream fetch",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export async function qaLogin(context: BrowserContext, identity: "qa-member" | "qa-moderator") {
  const token = process.env.E2E_QA_TOKEN;
  if (!token) throw new Error("Missing ephemeral CI QA token");
  // APIRequestContext shares the browser's cookie jar; no manufactured cookie
  // or saved production identity. Don't follow login redirects in this helper.
  // APIRequestContext sends no Origin or Fetch Metadata (unlike the browser
  // fetch the specs use after login), but main #84 requires same-origin
  // evidence on every unsafe method. Send the local origin explicitly: the
  // E2E worker translates exactly this value to the virtual staging origin
  // the gate expects, and foreign origins are still never translated.
  //
  // The shared qa-login throttle (AUTH_THROTTLE_PER_MINUTE = 10/min per
  // runner IP, src/throttle.ts) counts every login in the single-worker
  // suite, so late specs routinely meet a 429. Honor Retry-After with the
  // same bounded retries as the local teardown sweep; a login still
  // throttled after every retry fails loud so the suite cuts logins instead
  // of waiting longer.
  let retryAfter = 0;
  for (let attempt = 1; attempt <= QA_LOGIN_MAX_ATTEMPTS; attempt++) {
    const response = await context.request.post(`/auth/qa/${identity}`, {
      headers: { "X-TWO-QA-Auth": token, Origin: localOrigin },
      maxRedirects: 0,
    });
    if (response.status() === 204) {
      const cookie = (await context.cookies()).find((item) => item.name === "__Host-two_session");
      expect(cookie).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        domain: "localhost",
      });
      return;
    }
    if (response.status() !== 429)
      throw new Error(`QA login as ${identity} answered ${response.status()}`);
    retryAfter = parseRetryAfterSeconds(response.headers());
    if (attempt < QA_LOGIN_MAX_ATTEMPTS) await sleep(retryAfter * 1000);
  }
  throw qaLoginThrottleError(identity, retryAfter, QA_LOGIN_MAX_ATTEMPTS);
}
