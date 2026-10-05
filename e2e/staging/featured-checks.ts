import type { APIRequestContext, Page, TestInfo } from "@playwright/test";

// An absent section on HTTP 200 is a valid empty snapshot. A failed load is
// distinct, so an error page can never prove that the fixture disappeared.
async function homeHeadlines(guest: Page): Promise<string[] | null> {
  try {
    const response = await guest.goto("/", { waitUntil: "domcontentloaded", timeout: 5_000 });
    if (response?.status() !== 200) return null;
    return await guest
      .getByTestId("featured-content")
      .getByTestId("featured-item")
      .getByRole("heading", { level: 3 })
      .allTextContents();
  } catch {
    return null;
  }
}

// expect.poll retries a returned mismatch; neither presence nor absence may
// pass without a successful snapshot. The caller owns the finite poll budget.
export async function homeHasHeadline(
  guest: Page,
  headline: string,
  present: boolean,
): Promise<boolean> {
  const headlines = await homeHeadlines(guest);
  return headlines !== null && headlines.includes(headline) === present;
}

// The request API avoids opening a cleanup page and supplies the Origin the
// same-origin guard requires. 303 = deleted, 404 = already gone. A request
// error can contain cookies, so annotations expose only the id and status.
export async function cleanupFeaturedFixture(
  request: APIRequestContext,
  id: string,
  origin: string,
  testInfo: Pick<TestInfo, "annotations">,
): Promise<void> {
  const status = await request
    .post(`/admin/featured/${id}/delete`, {
      headers: { Origin: origin },
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
