import { test as base, expect, type BrowserContext } from "@playwright/test";

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
  const response = await context.request.post(`/auth/qa/${identity}`, {
    headers: { "X-TWO-QA-Auth": token, Origin: localOrigin },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(204);
  const cookie = (await context.cookies()).find((item) => item.name === "__Host-two_session");
  expect(cookie).toMatchObject({
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    domain: "localhost",
  });
}
