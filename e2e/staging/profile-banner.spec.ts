import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { qaLoginRetryBudgetMs } from "../qa-login-retry.mjs";
import { MEMBER_DISCORD_ID, stagingOrigin, test, expect } from "./fixtures";
import { loginQaMember } from "./qa-login";

// Staging journey: profile banner upload API (paired with the hermetic
// acceptance suite in test/profile-banner-upload-acceptance.test.ts, which
// owns the full contract: types, size, dimensions, EXIF strip, replacement,
// moderator hide, erasure, rate limit).
//
// API-level on purpose: the banner picker UI ships with the profile editor
// card, so this journey pins the live contract without depending on that UI.
// Member-only (one qa-login hit): moderator hide is covered hermetically.
// Order-independent: every run replaces then deletes the QA member's banner.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const png = readFileSync(join(root, "test/fixtures/banner/banner-valid.png"));
const gif = readFileSync(join(root, "test/fixtures/banner/banner.gif"));

const bannerPath = `/members/${MEMBER_DISCORD_ID}/banner`;
// APIRequestContext is a Node-side client: it sends no Origin on its own,
// and the unsafe methods stay behind the same-origin guard.
const originHeader = { origin: stagingOrigin };

test.beforeAll(async () => {
  test.setTimeout(30_000 + qaLoginRetryBudgetMs(1));
  await loginQaMember();
});

test("staging QA member uploads, serves and deletes a profile banner", async ({ page }) => {
  const api = page.request;
  let url: string | null = null;
  try {
    const uploaded = await api.post(bannerPath, {
      headers: originHeader,
      multipart: { banner: { name: "banner.png", mimeType: "image/png", buffer: png } },
    });
    expect(uploaded.status()).toBe(200);
    const body = (await uploaded.json()) as { saved: boolean; url: string };
    expect(body.saved).toBe(true);
    expect(body.url.startsWith(bannerPath)).toBe(true);
    url = body.url;

    const served = await api.get(url);
    expect(served.status()).toBe(200);
    expect(served.headers()["content-type"]).toContain("image/png");
    const cache = served.headers()["cache-control"] ?? "";
    expect(cache).toContain("public");
    expect(cache).toContain("immutable");
    expect(body.url).not.toContain("banners/");

    const rejected = await api.post(bannerPath, {
      headers: originHeader,
      multipart: { banner: { name: "banner.gif", mimeType: "image/gif", buffer: gif } },
    });
    expect(rejected.status()).toBe(422);
    const errors = (await rejected.json()) as { errors: { banner: string } };
    expect(errors.errors.banner).toMatch(/jpeg/i);
    expect(errors.errors.banner).toMatch(/png/i);
    expect(errors.errors.banner).toMatch(/webp/i);
  } finally {
    const deleted = await api.delete(bannerPath, { headers: originHeader });
    expect(deleted.status()).toBe(200);
    if (url) expect((await api.get(url)).status()).toBe(404);
  }
});
