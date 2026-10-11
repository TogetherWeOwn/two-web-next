import { expect, localOrigin, qaLogin, test } from "./fixtures";

// Moderator featured journey against local wrangler dev + disposable
// Postgres: create a published slot, show it to a guest on the homepage,
// rename it, delete it. Mirrors e2e/staging/featured.spec.ts without its
// staging seam (no storageState files, no 20 s poll: the local read is
// immediate). Frozen testids: featured-content/featured-item on the homepage
// (src/pages.tsx), featured-preview/new-featured/save-featured/delete-featured
// on the admin form (src/admin/pages.tsx).

// Highest position the form accepts is 2147483647 (src/admin/validation.ts).
// A slot this far down sorts after every real card, so a run that dies before
// cleanup still never displaces real content. Same staging pattern.
const LAST_POSITION = "2147483000";

// The window bounds are UTC wall text, `YYYY-MM-DD HH:mm`. The start sits an
// hour in the past so clock skew between the runner and the Worker cannot
// hide the slot; the end is a day out so the run never races the cutoff.
function utcWall(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 16).replace("T", " ");
}

test("moderator creates, renames and deletes a featured slot shown on the homepage", async ({
  page,
  context,
  browser,
}, testInfo) => {
  test.setTimeout(60_000);
  await qaLogin(context, "qa-moderator");
  const stamp = Date.now();
  const title = `E2E Featured ${stamp}`;
  const renamed = `E2E Featured Renamed ${stamp}`;
  const body = "Created by the local CI browser suite; deleted before the run ends.";
  let id: string | undefined;
  let deleted = false;
  // A clean jar: the moderator session must never leak into the public view,
  // and the guest view must never rotate the moderator bearer.
  const guestContext = await browser.newContext({
    baseURL: localOrigin,
    ignoreHTTPSErrors: true,
  });
  try {
    const guest = await guestContext.newPage();

    // 1. Create: published, visible now, no image (no FEATURED_IMAGE_HOSTS
    // dependency), last in order.
    await page.goto("/admin/featured");
    await page.getByTestId("new-featured").click();
    await page.getByLabel("Headline", { exact: true }).fill(title);
    await page.getByLabel("Body", { exact: true }).fill(body);
    await page.getByLabel("Published", { exact: true }).check();
    await page.getByLabel("Position (lower appears first)", { exact: true }).fill(LAST_POSITION);
    await page
      .getByLabel("Show from (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)", { exact: true })
      .fill(utcWall(-3_600_000));
    await page
      .getByLabel("Show until (UTC, YYYY-MM-DD HH:mm[:ss[.ffffff]], or empty)", { exact: true })
      .fill(utcWall(86_400_000));
    await page.getByTestId("save-featured").click();
    await expect(page).toHaveURL(/\/admin\/featured\/[1-9]\d*$/);
    id = new URL(page.url()).pathname.split("/").at(-1);
    expect(id).toBeDefined();
    await expect(page.getByRole("heading", { name: `Edit ${title}`, exact: true })).toBeVisible();
    await expect(page.getByTestId("featured-preview").getByTestId("featured-item")).toContainText(
      title,
    );

    // 2. A guest sees the slot in the homepage featured section.
    await guest.goto("/");
    await expect(guest.getByTestId("featured-content")).toBeVisible();
    await expect(guest.getByRole("heading", { name: "From the community team" })).toBeVisible();
    const shown = guest
      .getByTestId("featured-content")
      .getByTestId("featured-item")
      .filter({ has: guest.getByRole("heading", { level: 3, name: title, exact: true }) });
    await expect(shown).toHaveCount(1);
    await expect(shown).toContainText(body);

    // 3. Rename; the guest sees the new headline and not the old one.
    await page.getByLabel("Headline", { exact: true }).fill(renamed);
    await page.getByTestId("save-featured").click();
    await expect(page.getByRole("heading", { name: `Edit ${renamed}`, exact: true })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/admin/featured/${id}$`));
    await guest.goto("/");
    await expect(
      guest.getByRole("heading", { level: 3, name: renamed, exact: true }),
    ).toBeVisible();
    await expect(guest.getByRole("heading", { level: 3, name: title, exact: true })).toHaveCount(0);

    // 4. Delete through the UI; the homepage drops it and the edit page 404s.
    // The 404 is the firm proof: a homepage read that degrades to no section
    // would also pass the absence check.
    await page.getByTestId("delete-featured").click();
    await expect(page).toHaveURL(/\/admin\/featured$/);
    deleted = true;
    await expect(page.getByRole("link", { name: renamed, exact: true })).toHaveCount(0);
    await guest.goto("/");
    await expect(guest.getByRole("heading", { level: 3, name: renamed, exact: true })).toHaveCount(
      0,
    );
    const gone = await page.goto(`/admin/featured/${id}`);
    expect(gone?.status()).toBe(404);
  } finally {
    try {
      if (id !== undefined && !deleted) {
        // Same-origin guard requires the explicit Origin; 303 = deleted,
        // 404 = already gone. Never expose more than id + status.
        const status = await page.request
          .post(`/admin/featured/${id}/delete`, {
            headers: { Origin: localOrigin },
            maxRedirects: 0,
            timeout: 5_000,
          })
          .then((response) => response.status())
          .catch(() => -1);
        if (status !== 303 && status !== 404) {
          testInfo.annotations.push({
            type: "featured-cleanup-failed",
            description: JSON.stringify({ id, status }),
          });
        }
      }
    } finally {
      await guestContext.close();
    }
  }
});
