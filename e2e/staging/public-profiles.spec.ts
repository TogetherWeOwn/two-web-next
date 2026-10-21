import { qaLoginRetryBudgetMs } from "../qa-login-retry.mjs";
import { test, expect, stagingOrigin, emptyStorageState, MEMBER_DISCORD_ID } from "./fixtures";
import { loginQaMember } from "./qa-login";

// Public profile pages (/u/<handle>) on staging: owner, member, guest and
// former-member journeys plus the guest leak assertion.
//
// Fixture contracts:
// - The QA member and QA moderator exist (src/qa.ts). Handles are DERIVED
//   per test from the /profile and /members/<id> 301s, never hardcoded: the
//   schema slice owns handle derivation, and these journeys must survive
//   whatever it produces.
// - Default visibility and default index opt-out are assumed for the QA
//   identities. The index opt-in flip cannot be staged (no editor exists
//   yet); the hermetic acceptance suite pins it instead.
// - Former member (REQUIRED on staging): a users row with id
//   900000000000001398, member=false, plus a profiles row with a unique
//   handle. The implementation provisions it by extending the staging seed
//   (bin/seed-staging.mjs) with a member:false seed user and an operator
//   apply BEFORE the staging run is expected to pass; until then the
//   former-member test fails naming this fixture. The fixture is viewed
//   only — no QA-login identity is needed for it.
// - The QA display names equal the QA Discord usernames on staging, so the
//   username half of the leak rule cannot be distinguished from the public
//   display name here: staging pins ID absence (exact), deep-link absence
//   and button absence, while the hermetic suite pins the username field
//   with fixtures where display, handle and username all differ.
//
// String contracts: "Message on Discord" (exact button text), /former
// member/i (badge), and the owner edit link as role=link named /edit/i.
// The "Message on Discord" affordance may render as a button or a link;
// the text is the contract.
//
// Login budget: one qa-member login (this file's beforeAll).
// Order: the owner and member tests derive the handles the guest tests
// read through module state, and the owner test writes the marker bio the
// guest/member read tests rely on. Within-file order is load-bearing for
// those pairs only; every other test derives what it needs.

const MODERATOR_DISCORD_ID = "900000000000001397";
const FORMER_DISCORD_ID = "900000000000001398";

const MARKER_BIO = `Public-profile marker ${Date.now()}: night-market co-op.`;
const MARKER_GAMES = ["Acceptance Marker Game I", "Acceptance Marker Game II"];
const MARKER_TZ = "Pacific/Auckland";

const handles: { member?: string; moderator?: string } = {};

test.beforeAll(async () => {
  // Hook timeout: the config's 30s covers the login itself; its bounded 429
  // waits get their own budget (qa-login-retry.mjs), one login here.
  test.setTimeout(30_000 + qaLoginRetryBudgetMs(1));
  await loginQaMember();
});

const handleFrom = (location: string | null): string => {
  const text = location ?? "";
  expect(text, `expected a /u/<handle> Location, got ${JSON.stringify(location)}`).toMatch(
    /^\/u\/[^/\s?#]+$/,
  );
  return text.slice("/u/".length);
};

const requireHandle = (which: "member" | "moderator"): string => {
  const handle = handles[which];
  expect(
    handle,
    `handle derivation failed: the legacy 301 must work before ${which} guest reads run`,
  ).toBeTruthy();
  return handle as string;
};

const markerBody = () => ({ bio: MARKER_BIO, games: MARKER_GAMES, timezone: MARKER_TZ });

// Writes keep working while page GETs move: the JSON save answers 200 and
// carries the marker the guest/member read tests rely on.
test("control: owner PATCH of the JSON profile still saves", async ({ page }) => {
  const saved = await page.request.patch(`${stagingOrigin}/members/${MEMBER_DISCORD_ID}`, {
    headers: { Origin: stagingOrigin, Accept: "application/json" },
    data: markerBody(),
  });
  expect(saved.status()).toBe(200);
  expect(saved.headers()["content-type"] ?? "").toContain("application/json");
});

test("owner: /profile 301s to the handle page, which shows every field plus an edit link", async ({
  page,
}) => {
  const profile = await page.request.get(`${stagingOrigin}/profile`, { maxRedirects: 0 });
  expect(profile.status(), "GET /profile must 301 to /u/<handle>").toBe(301);
  const handle = handleFrom(profile.headers()["location"] ?? null);
  handles.member = handle;
  const saved = await page.request.patch(`${stagingOrigin}/members/${MEMBER_DISCORD_ID}`, {
    headers: { Origin: stagingOrigin, Accept: "application/json" },
    data: markerBody(),
  });
  expect(saved.status()).toBe(200);
  await page.goto(`/u/${handle}`);
  await expect(page.getByText("QA Member").first()).toBeVisible();
  await expect(page.getByText(MARKER_BIO).first()).toBeVisible();
  for (const game of MARKER_GAMES) {
    await expect(page.getByText(game).first()).toBeVisible();
  }
  await expect(page.getByText(MARKER_TZ).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /edit/i })).toBeVisible();
});

test("member: /members/<own id> 301s to the same handle as /profile", async ({ page }) => {
  const keyed = await page.request.get(`${stagingOrigin}/members/${MEMBER_DISCORD_ID}`, {
    maxRedirects: 0,
  });
  expect(keyed.status(), "GET /members/<id> must 301 to /u/<handle>").toBe(301);
  const viaKeyed = handleFrom(keyed.headers()["location"] ?? null);
  handles.member = viaKeyed;
  const profile = await page.request.get(`${stagingOrigin}/profile`, { maxRedirects: 0 });
  expect(profile.status()).toBe(301);
  expect(viaKeyed).toBe(handleFrom(profile.headers()["location"] ?? null));
});

test("member: another member's page shows the message button and no edit link", async ({
  page,
}) => {
  const legacy = await page.request.get(`${stagingOrigin}/members/${MODERATOR_DISCORD_ID}`, {
    maxRedirects: 0,
  });
  expect(legacy.status(), "GET /members/<id> must 301 to /u/<handle>").toBe(301);
  const handle = handleFrom(legacy.headers()["location"] ?? null);
  handles.moderator = handle;
  await page.goto(`/u/${handle}`);
  await expect(page.getByText("QA Moderator").first()).toBeVisible();
  await expect(page.getByText("Message on Discord", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /edit/i })).toHaveCount(0);
});

test("guest: the public page shows public fields only and leaks no Discord identity", async ({
  browser,
}) => {
  const handle = requireHandle("member");
  const guest = await browser.newContext({ storageState: emptyStorageState });
  try {
    const page = await guest.newPage();
    const response = await page.goto(`/u/${handle}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByText("QA Member").first()).toBeVisible();
    await expect(page.getByText(MARKER_BIO)).toHaveCount(0);
    for (const game of MARKER_GAMES) {
      await expect(page.getByText(game)).toHaveCount(0);
    }
    await expect(page.getByText(MARKER_TZ)).toHaveCount(0);
    await expect(page.getByText("Message on Discord", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /edit/i })).toHaveCount(0);
    // Full served bytes: embedded JSON and meta tags included.
    const html = await page.content();
    expect(html, "guest HTML must not leak the Discord ID").not.toContain(MEMBER_DISCORD_ID);
    await expect(
      page.locator('a[href*="discord.com/users"], a[href^="discord:"]'),
      "guest page must carry no Discord deep links",
    ).toHaveCount(0);
    // noindex via meta robots or the X-Robots-Tag header; either proves it.
    const robotsMeta = page.locator('meta[name="robots"]');
    const metaContent =
      (await robotsMeta.count()) > 0
        ? ((await robotsMeta.first().getAttribute("content")) ?? "")
        : "";
    const headerTag = response?.headers()["x-robots-tag"] ?? "";
    expect(
      `${metaContent} ${headerTag}`.toLowerCase(),
      "guest profile must be noindex (meta robots or X-Robots-Tag)",
    ).toContain("noindex");
    // Canonical and OG URL are pinned for correctness when present; the
    // hermetic suite pins the model signals unconditionally.
    const canonical = page.locator('link[rel="canonical"]');
    if ((await canonical.count()) > 0) {
      await expect(canonical.first()).toHaveAttribute("href", `${stagingOrigin}/u/${handle}`);
    }
    const ogUrl = page.locator('meta[property="og:url"]');
    if ((await ogUrl.count()) > 0) {
      await expect(ogUrl.first()).toHaveAttribute("content", `${stagingOrigin}/u/${handle}`);
    }
    // The Kit data endpoint serves the same filtered view when it answers.
    const data = await guest.request.get(`${stagingOrigin}/u/${handle}/__data.json`);
    if (data.status() === 200) {
      const body = await data.text();
      expect(body, "guest Kit data must not leak the Discord ID").not.toContain(MEMBER_DISCORD_ID);
    }
  } finally {
    await guest.close();
  }
});

test("guest: a second profile leaks no Discord identity either", async ({ browser }) => {
  const handle = requireHandle("moderator");
  const guest = await browser.newContext({ storageState: emptyStorageState });
  try {
    const page = await guest.newPage();
    const response = await page.goto(`/u/${handle}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByText("QA Moderator").first()).toBeVisible();
    await expect(page.getByText("Message on Discord", { exact: true })).toHaveCount(0);
    const html = await page.content();
    expect(html, "guest HTML must not leak the Discord ID").not.toContain(MODERATOR_DISCORD_ID);
    const robotsMeta = page.locator('meta[name="robots"]');
    const metaContent =
      (await robotsMeta.count()) > 0
        ? ((await robotsMeta.first().getAttribute("content")) ?? "")
        : "";
    const headerTag = response?.headers()["x-robots-tag"] ?? "";
    expect(
      `${metaContent} ${headerTag}`.toLowerCase(),
      "guest profile must be noindex (meta robots or X-Robots-Tag)",
    ).toContain("noindex");
  } finally {
    await guest.close();
  }
});

test("former member: guests get 404, members see the former-member badge", async ({
  page,
  browser,
}) => {
  const legacy = await page.request.get(`${stagingOrigin}/members/${FORMER_DISCORD_ID}`, {
    maxRedirects: 0,
  });
  expect(
    legacy.status(),
    `staging former-member fixture missing: expected 301 for the seeded former user ${FORMER_DISCORD_ID} (see file header)`,
  ).toBe(301);
  const handle = handleFrom(legacy.headers()["location"] ?? null);
  await page.goto(`/u/${handle}`);
  await expect(page.getByText(/former member/i)).toBeVisible();
  const guest = await browser.newContext({ storageState: emptyStorageState });
  try {
    const guestPage = await guest.newPage();
    const res = await guestPage.goto(`/u/${handle}`);
    expect(res?.status(), "former-member profile must 404 for guests").toBe(404);
  } finally {
    await guest.close();
  }
});

test("control: unknown handles 404 for every viewer", async ({ page, browser }) => {
  const missing = "qa-no-such-handle-000000";
  const memberRes = await page.goto(`/u/${missing}`);
  expect(memberRes?.status()).toBe(404);
  const guest = await browser.newContext({ storageState: emptyStorageState });
  try {
    const guestPage = await guest.newPage();
    const guestRes = await guestPage.goto(`/u/${missing}`);
    expect(guestRes?.status()).toBe(404);
  } finally {
    await guest.close();
  }
});

test("control: guests still bounce to sign-in from the legacy profile URLs", async ({
  browser,
}) => {
  const guest = await browser.newContext({ storageState: emptyStorageState });
  try {
    const profile = await guest.request.get(`${stagingOrigin}/profile`, { maxRedirects: 0 });
    expect(profile.status()).toBe(302);
    expect(profile.headers()["location"] ?? "").toContain("/auth/discord");
    const keyed = await guest.request.get(`${stagingOrigin}/members/${MEMBER_DISCORD_ID}`, {
      maxRedirects: 0,
    });
    expect(keyed.status()).toBe(302);
    expect(keyed.headers()["location"] ?? "").toContain("/auth/discord");
  } finally {
    await guest.close();
  }
});
