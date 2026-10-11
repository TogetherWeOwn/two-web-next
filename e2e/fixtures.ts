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
  // Every login — this one included — spends the shared `qa-login` throttle
  // budget (10/min per runner IP, src/throttle.ts), so a late-suite login can
  // land in a window earlier specs filled. Retry only 429, honoring the
  // server's Retry-After into a fresh window (bounded: the throttle error
  // names the budget instead of retrying harder). Any other status fails loud
  // below, as before.
  const send = () =>
    context.request.post(`/auth/qa/${identity}`, {
      headers: { "X-TWO-QA-Auth": token, Origin: localOrigin },
      maxRedirects: 0,
    });
  let response = await send();
  for (let attempt = 1; attempt <= QA_LOGIN_MAX_ATTEMPTS && response.status() === 429; attempt++) {
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers());
    if (attempt === QA_LOGIN_MAX_ATTEMPTS)
      throw qaLoginThrottleError(identity, retryAfterSeconds, attempt);
    await sleep(retryAfterSeconds * 1000);
    response = await send();
  }
  expect(response.status()).toBe(204);
  const cookie = (await context.cookies()).find((item) => item.name === "__Host-two_session");
  expect(cookie).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    domain: "localhost",
  });
}
